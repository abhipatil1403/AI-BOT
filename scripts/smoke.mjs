import { _electron, chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const profile = await mkdtemp(join(tmpdir(), 'ai-bot-e2e-'));
const browserProfile = await mkdtemp(join(tmpdir(), 'ai-bot-browser-'));
const output = resolve('test-results'); await mkdir(output, { recursive: true });
const env = { ...process.env, AI_BOT_SMOKE_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
let desktop; let browser; let originalClipboard;
async function desktopWindow(predicate) {
  await expect.poll(() => desktop.windows().some(predicate), { timeout: 60000 }).toBe(true);
  return desktop.windows().find(predicate);
}
const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><title>Smoke target</title></head><body><h1>Assistant test page</h1><textarea id="paste" aria-label="Paste target"></textarea></body></html>'); });
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const sitePort = site.address().port;
try {
  desktop = await _electron.launch({
    ...(process.env.AI_BOT_SMOKE_EXE ? { executablePath: resolve(process.env.AI_BOT_SMOKE_EXE) } : {}),
    args: [...(process.env.AI_BOT_SMOKE_EXE ? [] : ['.']), '--smoke'], env, timeout: 60000
  });
  console.log('Smoke: Electron launched');
  desktop.process().stderr.on('data', data => { if (String(data).includes('Assistant startup failed')) console.log(String(data).trim()); });
  console.log('Smoke launch diagnostics:', await desktop.evaluate(({ app, BrowserWindow, safeStorage }) => ({ version: app.getVersion(), ready: app.isReady(), encryption: safeStorage.isEncryptionAvailable(), windows: BrowserWindow.getAllWindows().map(window => ({ title: window.getTitle(), url: window.webContents.getURL() })) })));
  const settings = await desktopWindow(page => page.url().endsWith('settings.html'));
  assert(settings, 'Settings window launched');
  await settings.locator('#connection').filter({ hasText: /Setup needed|Provider configured/ }).waitFor();
  const widget = await desktopWindow(page => page.url().endsWith('widget.html')); assert(widget, 'Widget window launched');
  await expect(widget.locator('.dot')).toBeHidden();
  assert(await desktop.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows().find(window => window.getTitle() === 'AI Quick Answer widget')?.isVisible()), 'Idle native surface is hidden');
  await widget.evaluate(() => {
    globalThis.__smokePhases = [];
    window.assistant.onState(state => globalThis.__smokePhases.push(state.phase));
  });
  if (process.platform === 'win32') {
    for (const enabled of [true, false, true]) {
      await settings.evaluate(async enabled => {
        const data = await window.assistant.settings();
        await window.assistant.saveConfig({ ...data.config, captureProtection: enabled });
      }, enabled);
      const handles = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => {
        const handle = window.getNativeWindowHandle();
        return handle.length === 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString();
      }));
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/query-display-affinity.ps1'), '-Handles', handles.join(',')], { windowsHide: true, timeout: 30000 });
      assert.deepEqual(JSON.parse(result.stdout.trim()), handles.map(() => enabled ? 0x11 : 0), 'Actual Win32 affinity on both desktop windows');
    }
    console.log('PASS: actual Windows WDA_EXCLUDEFROMCAPTURE on Settings and widget; toggle restores WDA_NONE');
  }
  originalClipboard = await desktop.evaluate(({ clipboard }) => clipboard.readText());

  // Test-only HTTP fixtures installed externally into the running main process.
  // Production bundles contain no mock provider or synthetic-response branch.
  await desktop.evaluate(() => {
    const actualFetch = globalThis.fetch;
    globalThis.__smokeRequests = 0;
    globalThis.__smokeRequestKinds = [];
    globalThis.fetch = async (url, init) => {
      const address = String(url);
      if (address.startsWith('http://127.0.0.1:')) return actualFetch(url, init);
      if (address === 'https://api.groq.com/openai/v1/models') return new Response('{"data":[{"id":"openai/gpt-oss-120b"}]}');
      if (address === 'https://gemini.google.com/app') return new Response('"SNlM0e":"synthetic-token","cfb2h":"synthetic-build","FdrFJe":"synthetic-session"');
      let question; let system;
      if (address.includes('api.groq.com/openai/v1/chat/completions')) {
        const body = JSON.parse(init.body); system = body.messages[0].content; question = body.messages[1].content;
      } else if (address.includes('gemini.google.com/') && address.includes('StreamGenerate')) {
        const body = new URLSearchParams(init.body); const inner = JSON.parse(JSON.parse(body.get('f.req'))[1]);
        system = inner[0][0]; question = system;
      } else throw new Error('Unexpected external request during smoke test');
      globalThis.__smokeRequests++;
      const answer = system.includes('"type":"code"') ? { type: 'code', language: 'python', code: 'def add(a, b):\n    return a + b\n' }
        : system.includes('"type":"mcq"') ? { type: 'mcq', answer: 'B', text: 'Paris' }
        : { type: 'descriptive', answer: question.includes('photosynthesis') ? 'Plants use light to turn water and carbon dioxide into sugars.' : 'Paris' };
      const text = JSON.stringify(answer);
      globalThis.__smokeRequestKinds.push({ provider: address.includes('api.groq.com') ? 'groq' : 'gemini', type: answer.type, retry: system.includes('Your previous output was invalid') });
      if (address.includes('api.groq.com')) return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
      return new Response(`)]}'\n123\n${JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [['rcid', [text]]]])]])}\n`);
    };
  });
  await settings.locator('#groq-key').fill('synthetic_test_key_for_smoke');
  await settings.locator('#validate').click(); await settings.locator('#status').filter({ hasText: 'Connection validated' }).waitFor();
  await settings.locator('#save-credential').click(); await settings.locator('#status').filter({ hasText: 'Credential saved securely' }).waitFor();
  assert.equal(await settings.locator('#groq-key').inputValue(), '');
  const vault = await readFile(join(profile, 'vault.json'), 'utf8'); assert(!vault.includes('synthetic_test_key_for_smoke'), 'DPAPI stores ciphertext');
  const diagnostics = await settings.evaluate(() => window.assistant.settings()); assert(diagnostics.diagnostics.encryption, 'Actual OS encryption available');
  assert(diagnostics.diagnostics.bridge.startsWith('Listening'), 'Close the already-running desktop companion before this isolated smoke test; port 47831 must be free');
  await settings.screenshot({ path: join(output, 'settings.png'), fullPage: true });
  console.log('Smoke: Settings and real DPAPI verified');

  // Prior interactive runs can leave the pointer over the desktop dot.
  // Establish the non-hovered, non-focused precondition before requesting.
  await widget.evaluate(() => document.activeElement?.blur());
  await widget.evaluate(() => document.querySelector('.assistant-widget').dispatchEvent(new window.MouseEvent('mouseleave')));

  // A test-owned native window receives actual injected Ctrl+V. This verifies
  // the passive OS hook and ordinary paste together, not a JS shortcut handler.
  await desktop.evaluate(async ({ BrowserWindow }) => {
    const target = new BrowserWindow({ width: 480, height: 260, title: 'AI Quick Answer smoke target' });
    globalThis.__smokeTarget = target;
    await target.loadURL('data:text/html,<html><body><textarea id="target" autofocus></textarea></body></html>'); target.show(); target.focus(); target.webContents.focus();
  });
  const target = await desktopWindow(page => page.url().startsWith('data:text/html')); assert(target, 'Native paste target exists');
  const text = 'What is photosynthesis?';
  await desktop.evaluate(({ clipboard }) => clipboard.writeText('What is photosynthesis?'));
  await target.locator('#target').focus();
  await target.bringToFront();
  await target.evaluate(() => {
    globalThis.__pasteEvents = [];
    document.addEventListener('keydown', event => globalThis.__pasteEvents.push({ key: event.key, ctrl: event.ctrlKey }));
    document.addEventListener('paste', () => globalThis.__pasteEvents.push({ paste: true }));
  });
  const focused = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle());
  assert.equal(focused, 'AI Quick Answer smoke target', 'Test window must own focus before native input');
  if (process.env.AI_BOT_SMOKE_NATIVE === 'manual') console.log('Smoke: waiting for native Ctrl+V in the smoke target window');
  else {
    await desktop.evaluate(async ({ app, BrowserWindow }) => {
      const { createRequire } = process.getBuiltinModule('module');
      const { uIOhook, UiohookKey } = createRequire(`${app.getAppPath()}/package.json`)('uiohook-napi');
      globalThis.__smokeKeys = [];
      const monitor = event => { if (event.keycode === UiohookKey.V) globalThis.__smokeKeys.push({ ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, focused: BrowserWindow.getFocusedWindow()?.getTitle() }); };
      uIOhook.on('keydown', monitor);
      // Acquire native and renderer focus immediately before OS input, after
      // all Playwright setup calls that can activate another window.
      globalThis.__smokeTarget.show(); globalThis.__smokeTarget.focus(); globalThis.__smokeTarget.webContents.focus();
      await new Promise(resolve => setTimeout(resolve, 250));
      uIOhook.keyToggle(UiohookKey.Ctrl, 'down');
      await new Promise(resolve => setTimeout(resolve, 100));
      uIOhook.keyToggle(UiohookKey.V, 'down');
      await new Promise(resolve => setTimeout(resolve, 100));
      uIOhook.keyToggle(UiohookKey.V, 'up'); uIOhook.keyToggle(UiohookKey.Ctrl, 'up');
      await new Promise(resolve => setTimeout(resolve, 300)); uIOhook.removeListener('keydown', monitor);
    });
  }
  await target.locator('#target').filter({}).waitFor();
  await target.waitForFunction(expected => document.querySelector('#target').value === expected, text, { timeout: process.env.AI_BOT_SMOKE_NATIVE === 'manual' ? 180000 : 30000 }).catch(async error => {
    console.log('Paste diagnostic:', JSON.stringify(await target.locator('#target').inputValue()), 'requests:', await desktop.evaluate(() => globalThis.__smokeRequests));
    console.log('Focus diagnostic:', await target.evaluate(() => ({ focused: document.hasFocus(), active: document.activeElement?.id, events: globalThis.__pasteEvents })), await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle()));
    await target.screenshot({ path: join(output, 'paste-failure.png') });
    throw error;
  });
  await widget.locator('.dot.ready').waitFor().catch(async error => {
    console.log('Hotkey diagnostic:', await desktop.evaluate(() => ({ requests: globalThis.__smokeRequests, keys: globalThis.__smokeKeys })), await widget.locator('.dot').getAttribute('class'));
    throw error;
  });
  await expect(widget.locator('.panel')).toBeHidden();
  await widget.locator('.dot').hover(); await widget.locator('.answer').filter({ hasText: 'Plants use light' }).waitFor();
  assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), text, 'Hotkey never changes clipboard');
  await expect.poll(() => widget.evaluate(() => window.innerWidth)).toBe(226);
  await expect.poll(() => widget.evaluate(() => {
    const bounds = document.querySelector('.panel').getBoundingClientRect();
    return bounds.top >= 0 && bounds.left >= 0 && bounds.bottom <= window.innerHeight;
  })).toBe(true);
  await widget.screenshot({ path: join(output, 'descriptive.png'), omitBackground: true });
  const design = await widget.evaluate(() => ({
    marker: window.getComputedStyle(document.querySelector('.dot'), '::after').width,
    background: window.getComputedStyle(document.querySelector('.panel')).backgroundColor,
    width: window.innerWidth,
    height: window.innerHeight,
    phases: globalThis.__smokePhases
  }));
  assert.equal(design.marker, '6px'); assert.equal(design.background, 'rgba(0, 0, 0, 0)');
  assert(design.width <= 286 && design.height <= 204); assert(design.phases.includes('processing'));
  assert.equal(await desktop.evaluate(() => globalThis.__smokeRequests), 1, 'One native paste request');
  console.log('PASS: actual Ctrl+V preserves paste and drives clipboard → provider → hover answer');

  // Requests via explicit test UI actions exercise the same production pipeline.
  await new Promise(resolve => setTimeout(resolve, 350));
  await desktop.evaluate(({ clipboard }) => clipboard.writeText('Capital of France?\nA. Berlin\nB. Paris\nC. Rome'));
  await settings.evaluate(() => window.assistant.trigger());
  await widget.locator('.answer').filter({ hasText: 'B. Paris' }).waitFor();
  await widget.screenshot({ path: join(output, 'mcq.png'), omitBackground: true });
  await widget.locator('.dot').hover();
  await widget.locator('.panel').waitFor({ state: 'hidden', timeout: 8000 });
  await expect(widget.locator('.dot')).toBeHidden();
  await widget.evaluate(() => document.querySelector('.assistant-widget').dispatchEvent(new window.MouseEvent('mouseenter')));
  await expect(widget.locator('.panel')).toBeHidden();
  await new Promise(resolve => setTimeout(resolve, 350));
  await desktop.evaluate(({ clipboard }) => clipboard.writeText('Write a program to add two numbers'));
  await settings.evaluate(() => window.assistant.trigger());
  await widget.locator('.dot.ready').waitFor(); await widget.locator('.dot').hover();
  await widget.locator('.copy').waitFor(); await widget.locator('.copy').click();
  assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), 'def add(a, b):\n    return a + b\n');
  await widget.screenshot({ path: join(output, 'code.png'), omitBackground: true });
  assert.equal(await desktop.evaluate(() => globalThis.__smokeRequests), 3, 'One request per answer mode');
  console.log('PASS: all answer modes and exact raw code copy');

  const extension = resolve('dist/extension');
  browser = await chromium.launchPersistentContext(browserProfile, { channel: 'chromium', headless: false, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP assistant-smoke.test 127.0.0.1', '--no-proxy-server'] });
  let worker = browser.serviceWorkers()[0]; if (!worker) worker = await browser.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const options = await browser.newPage(); await options.goto(`chrome-extension://${extensionId}/options/index.html`);
  await options.locator('#token').fill(diagnostics.pairingToken); await options.locator('#save').click();
  await options.locator('#status').filter({ hasText: 'Connected.' }).waitFor().catch(async error => {
    console.log('Pairing diagnostic:', await options.locator('#status').innerText(), (await settings.evaluate(() => window.assistant.settings())).diagnostics.bridge);
    throw error;
  });
  const page = await browser.newPage(); await page.goto(`http://assistant-smoke.test:${sitePort}/`);
  const frame = page.frameLocator('iframe[title="AI Quick Answer"]');
  await frame.locator('.dot.ready').waitFor({ timeout: 20000 });
  await frame.locator('.dot').hover(); await frame.locator('.answer').filter({ hasText: 'def add' }).waitFor();
  await desktop.evaluate(({ clipboard }) => clipboard.writeText('Browser copy sentinel'));
  await frame.locator('.copy').click(); await expect(frame.locator('.copy')).toHaveText('Copied');
  assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), 'def add(a, b):\n    return a + b\n', 'Browser copies only raw code');
  assert.equal(await page.locator('body').innerText(), 'Assistant test page', 'Answer is not in page DOM');
  await page.screenshot({ path: join(output, 'extension.png') });
  console.log('PASS: actual MV3 extension pairs and renders authenticated companion state');
  await page.locator('#paste').hover();
  await new Promise(resolve => setTimeout(resolve, 5500));
  await frame.locator('.dot').hover(); await frame.locator('.answer').filter({ hasText: 'def add' }).waitFor();
  await frame.locator('.close').click();
  await page.locator('iframe[title="AI Quick Answer"]').waitFor({ state: 'hidden' });
  await expect(widget.locator('.dot')).toBeHidden();
  console.log('PASS: code survives hover changes and MCQ duration; manual cross dismisses both clients');

  await settings.evaluate(async () => {
    const data = await window.assistant.settings(); await window.assistant.saveConfig({ ...data.config, visibility: 'always', sharing: true, captureProtection: true });
  });
  await new Promise(resolve => setTimeout(resolve, 350));
  await desktop.evaluate(({ clipboard }) => clipboard.writeText('What is photosynthesis?'));
  await settings.evaluate(() => window.assistant.trigger());
  await widget.locator('.dot.ready').waitFor();
  await page.locator('iframe[title="AI Quick Answer"]').waitFor({ state: 'hidden' });
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'AI Quick Answer widget');
    return window?.isVisible() && window.isContentProtected();
  })).toBe(true);
  console.log('PASS: capture exclusion keeps desktop visible and hides browser overlay while sharing');

  await settings.evaluate(async () => {
    const data = await window.assistant.settings(); await window.assistant.saveConfig({ ...data.config, visibility: 'sharing', sharing: true });
  });
  await page.locator('iframe[title="AI Quick Answer"]').waitFor({ state: 'hidden' });
  const desktopHidden = await desktop.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows().find(window => window.getTitle() === 'AI Quick Answer widget')?.isVisible()); assert(desktopHidden);
  await settings.evaluate(async () => {
    const data = await window.assistant.settings(); await window.assistant.saveConfig({ ...data.config, visibility: 'always', sharing: false, provider: 'gemini' });
    await window.assistant.saveCredential('gemini', 'Cookie: __Secure-1PSID=synthetic-test-cookie'); await window.assistant.validateCredential('gemini', '');
  });
  await new Promise(resolve => setTimeout(resolve, 350));
  await desktop.evaluate(({ clipboard }) => clipboard.writeText('What is photosynthesis?'));
  await settings.evaluate(() => window.assistant.trigger()); await frame.locator('.dot.ready').waitFor(); await frame.locator('.dot').hover(); await frame.locator('.answer').filter({ hasText: 'Plants use light' }).waitFor();
  assert.equal((await settings.evaluate(() => window.assistant.settings())).config.provider, 'gemini');
  console.log('PASS: sharing hides both clients; Gemini switching and session adapter');
  await options.locator('#forget').click(); await options.locator('#status').filter({ hasText: 'Disconnected' }).waitFor();
  const count = await desktop.evaluate(() => globalThis.__smokeRequests);
  await frame.locator('.close').click();
  await page.locator('iframe[title="AI Quick Answer"]').waitFor({ state: 'hidden' }); await expect(widget.locator('.dot')).toBeHidden();
  if (count !== 5) console.log('Request categories:', await desktop.evaluate(() => globalThis.__smokeRequestKinds));
  assert.equal(count, 5, 'Each user trigger produces one request');
  console.log(`Smoke passed: ${count} fixture requests. Screenshots in test-results/.`);
} finally {
  await browser?.close();
  if (desktop && originalClipboard !== undefined) {
    await desktop.evaluate(async ({ clipboard }, original) => {
      const current = await clipboard.readText();
      const synthetic = ['What is photosynthesis?', 'Capital of France?\nA. Berlin\nB. Paris\nC. Rome', 'Write a program to add two numbers', 'def add(a, b):\n    return a + b\n', 'Browser copy sentinel'];
      if (synthetic.includes(current)) await clipboard.writeText(original);
    }, originalClipboard).catch(() => {});
  }
  await desktop?.close();
  await new Promise(resolve => site.close(resolve));
  // Each path is a fresh mkdtemp directory under the OS temp root.
  for (const path of [profile, browserProfile]) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
}
