import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, powerMonitor, safeStorage, screen, Tray } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { release } from 'node:os';
import type { Server } from 'node:http';
import { z } from 'zod';
import { AssistantError, type AIProvider } from '../../packages/core';
import { configSchema, copyRequestSchema, parseCookies, type AssistantState, type Config } from '../../packages/schemas';
import { createProvider } from '../../packages/providers';
import { PORT, type SettingsData } from '../../packages/protocol';
import { Storage } from './storage';
import { Controller } from './controller';
import { startBridge } from './bridge';
import { PassiveHotkey } from './hotkey';
import { readClipboardQuestion, readImageFile } from './images';

const smoke = process.argv.includes('--smoke');
if (smoke) app.setPath('userData', process.env.AI_BOT_SMOKE_DATA ?? join(app.getPath('temp'), 'ai-quick-answer-smoke'));
app.setName('AI Quick Answer');
app.commandLine.appendSwitch('disable-http-cache');
let tray: Tray | undefined;
let settingsWindow: BrowserWindow | undefined;
let widgetWindow: BrowserWindow | undefined;
let bridge: Server | undefined;
let hotkey: PassiveHotkey | undefined;
let storage: Storage;
let controller: Controller;
let pairingToken: string;
let config: Config;
let bridgeStatus = 'Starting';
let hotkeyStatus = 'Starting';
let quitting = false;
const providers = new Map<Config['provider'], AIProvider>();
const views = join(__dirname, 'renderer');

function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
}
function providerFor(current: Config): AIProvider {
  const existing = providers.get(current.provider); if (existing) return existing;
  const secret = storage.getSecret(current.provider);
  if (!secret) throw new AssistantError('credentials', 'Set up your AI provider in Settings');
  const provider = createProvider(current.provider, secret); providers.set(current.provider, provider); return provider;
}
function secureWindow(window: BrowserWindow, file: string): void {
  applyCaptureProtection(window);
  window.on('ready-to-show', () => applyCaptureProtection(window));
  window.on('show', () => applyCaptureProtection(window));
  const url = pathToFileURL(join(views, file)).href;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, destination) => { if (destination !== url) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  void window.loadURL(url);
}
function applyCaptureProtection(window: BrowserWindow): void {
  if (process.platform === 'win32') window.setContentProtection(config.captureProtection);
}
function captureStatus(): string {
  if (!config.captureProtection) return 'Disabled';
  if (process.platform !== 'win32') return 'Unsupported on this platform; use Hide while sharing';
  if (Number(release().split('.')[2]) < 19041) return 'Legacy Windows capture masking; use Hide while sharing';
  const windows = [widgetWindow, settingsWindow].filter((window): window is BrowserWindow => !!window && !window.isDestroyed());
  return windows.length && windows.every(window => window.isContentProtected()) ? 'Windows capture exclusion enabled; verify sharing preview' : 'Not enabled; use Hide while sharing';
}
function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({ width: 770, height: 850, minWidth: 620, minHeight: 650, show: false, title: 'AI Quick Answer · Settings', backgroundColor: '#f5f7f6', autoHideMenuBar: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !app.isPackaged } });
  secureWindow(settingsWindow, 'settings.html');
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('close', event => { if (!quitting) { event.preventDefault(); settingsWindow?.hide(); } });
}
function positionWidget(): void {
  if (!widgetWindow) return;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [width = 18, height = 18] = widgetWindow.getSize();
  const left = config.position.endsWith('left'); const top = config.position.startsWith('top');
  widgetWindow.setPosition(left ? area.x + 16 : area.x + area.width - width - 16, top ? area.y + 16 : area.y + area.height - height - 16);
}
function visibleState(): AssistantState {
  const hidden = config.visibility === 'sharing' && config.sharing;
  return hidden ? { ...controller.state, phase: 'idle', answer: undefined, error: undefined } : controller.state;
}
function publish(): void {
  if (!controller) return;
  if (controller.state.phase === 'idle' || (config.visibility === 'sharing' && config.sharing)) widgetWindow?.hide();
  const state = visibleState();
  for (const window of [widgetWindow, settingsWindow]) if (window && !window.isDestroyed()) window.webContents.send('assistant:state', state);
}
function updateTray(): void {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'AI Quick Answer', enabled: false },
    { label: `Shortcut: ${config.shortcut}`, enabled: false },
    { label: 'Settings', click: openSettings },
    { label: 'Answer clipboard', click: () => { void controller.trigger(); } },
    { label: 'Answer image file…', click: () => { void answerImageFile(); } },
    { label: 'Screen sharing is active', type: 'checkbox', checked: config.sharing, click: item => {
      config = { ...config, sharing: item.checked }; storage.saveConfig(config); controller.configure(config); updateTray();
    } },
    { type: 'separator' }, { label: 'Quit', click: () => app.quit() }
  ]));
}
async function answerImageFile(): Promise<void> {
  const result = await dialog.showOpenDialog({ title: 'Choose an image question', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
  if (!result.canceled && result.filePaths[0]) await controller.trigger(() => readImageFile(result.filePaths[0]!));
}
function authorized(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, settingsOnly = false): boolean {
  const id = event.sender.id;
  const window = [settingsWindow, ...(settingsOnly ? [] : [widgetWindow])].find(w => w && !w.isDestroyed() && w.webContents.id === id);
  return !!window && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith(pathToFileURL(views).href + '/');
}
function handle(channel: string, settingsOnly: boolean, callback: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!authorized(event, settingsOnly)) throw new Error('Access denied');
    try { return await callback(...args); }
    catch (error) { throw new Error(error instanceof AssistantError ? error.message : 'Unable to complete this action. Check your settings'); }
  });
}
function credential(provider: unknown, value: unknown): { name: Config['provider']; secret: string } {
  const name = z.enum(['groq', 'gemini']).parse(provider);
  const secret = z.string().trim().min(1).max(65536).parse(value);
  if (name === 'groq' && (!/^[A-Za-z0-9_-]{20,256}$/.test(secret))) throw new AssistantError('credentials', 'Enter a valid Groq API key');
  if (name === 'gemini') {
    try { parseCookies(secret); } catch (error) { throw new AssistantError('cookies', error instanceof Error ? error.message : 'Invalid cookie input'); }
  }
  return { name, secret };
}
function registerIPC(): void {
  handle('settings:get', true, (): SettingsData => ({ config, pairingToken, configured: { groq: storage.hasSecret('groq'), gemini: storage.hasSecret('gemini') }, diagnostics: { provider: config.provider, configured: storage.hasSecret(config.provider), hotkey: hotkeyStatus, bridge: bridgeStatus, encryption: encryptionAvailable(), version: app.getVersion(), capture: captureStatus() } }));
  handle('settings:save', true, value => {
    const next = configSchema.safeParse(value);
    if (!next.success) throw new AssistantError('settings', 'Invalid settings or shortcut. Use Ctrl+[Alt+][Shift+]+key');
    config = next.data;
    for (const window of [widgetWindow, settingsWindow]) if (window && !window.isDestroyed()) applyCaptureProtection(window);
    storage.saveConfig(config); hotkey?.configure(config.shortcut); controller.configure(config); updateTray();
  });
  handle('credential:save', true, (provider, value) => {
    const { name, secret } = credential(provider, value); storage.setSecret(name, secret); providers.delete(name);
    controller.configure(config);
  });
  handle('credential:validate', true, async (provider, value) => {
    const name = z.enum(['groq', 'gemini']).parse(provider);
    const input = typeof value === 'string' && value.trim() ? credential(provider, value).secret : storage.getSecret(name);
    if (!input) throw new AssistantError('credentials', 'Enter a credential first');
    await createProvider(name, input).validate(AbortSignal.timeout(35000));
  });
  handle('credential:remove', true, provider => { const name = z.enum(['groq', 'gemini']).parse(provider); storage.removeSecret(name); providers.delete(name); controller.configure(config); });
  handle('pairing:rotate', true, () => { const next = randomBytes(32).toString('hex'); storage.setSecret('pairing', next); pairingToken = next; return next; });
  handle('assistant:trigger', false, () => { void controller.trigger(); });
  handle('assistant:dismiss', false, requestId => {
    const parsed = copyRequestSchema.safeParse({ requestId });
    if (!parsed.success || !controller.dismiss(parsed.data.requestId)) throw new AssistantError('dismiss', 'Answer changed. Try again');
  });
  handle('assistant:copy', false, async requestId => {
    const parsed = copyRequestSchema.safeParse({ requestId }); const state = controller.state;
    if (!parsed.success || state.requestId !== parsed.data.requestId || state.phase !== 'ready' || state.answer?.type !== 'code') throw new AssistantError('copy', 'Answer changed. Try copying again');
    await clipboard.writeText(state.answer.code);
  });
  ipcMain.on('assistant:subscribe', event => { if (authorized(event)) event.sender.send('assistant:state', visibleState()); });
  ipcMain.on('widget:resize', (event, width: unknown, height: unknown, visible: unknown) => {
    if (!authorized(event) || event.sender.id !== widgetWindow?.webContents.id) return;
    if (typeof width !== 'number' || typeof height !== 'number' || typeof visible !== 'boolean' || !Number.isInteger(width) || !Number.isInteger(height) || width < 18 || width > 320 || height < 18 || height > 220) return;
    widgetWindow.setSize(width, height); positionWidget();
    const state = controller.state;
    const expired = state.phase === 'ready' && state.answer?.type === 'mcq' && config.duration > 0 && Date.now() >= state.updatedAt + config.duration * 1000;
    if (visible && state.phase !== 'idle' && !expired && !(config.visibility === 'sharing' && config.sharing)) {
      applyCaptureProtection(widgetWindow); widgetWindow.showInactive();
    }
    else widgetWindow.hide();
  });
}

async function start(): Promise<void> {
  storage = new Storage(app.getPath('userData'), { isEncryptionAvailable: encryptionAvailable, encryptString: value => safeStorage.encryptString(value), decryptString: value => safeStorage.decryptString(value) });
  config = storage.loadConfig();
  pairingToken = storage.getSecret('pairing') ?? randomBytes(32).toString('hex');
  storage.setSecret('pairing', pairingToken);
  controller = new Controller(config, readClipboardQuestion, providerFor, publish);
  registerIPC();
  widgetWindow = new BrowserWindow({ width: 18, height: 18, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false, title: 'AI Quick Answer widget', webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, devTools: !app.isPackaged } });
  widgetWindow.setAlwaysOnTop(true, 'floating');
  secureWindow(widgetWindow, 'widget.html');
  widgetWindow.once('ready-to-show', () => { positionWidget(); publish(); });
  screen.on('display-metrics-changed', positionWidget);
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGElEQVQ4T2NkqLf4z0ABYBw1gGE0DBgGAgBxpR4xBXNK1AAAAABJRU5ErkJggg==');
  tray = new Tray(icon); tray.setToolTip('AI Quick Answer'); tray.on('double-click', openSettings); updateTray();
  try { bridge = await startBridge(controller, () => pairingToken, openSettings, PORT, async code => { await clipboard.writeText(code); }); bridgeStatus = `Listening on 127.0.0.1:${PORT}`; }
  catch { bridgeStatus = `Unavailable: port ${PORT} is in use. Restart after closing the conflicting application`; }
  hotkey = new PassiveHotkey(() => { if (BrowserWindow.getFocusedWindow() === settingsWindow) return; void controller.trigger(); });
  hotkey.configure(config.shortcut);
  try { hotkey.start(); hotkeyStatus = 'Passive listener active (normal paste preserved)'; }
  catch { hotkeyStatus = 'Unavailable. Restart the app and check keyboard permissions'; }
  const resetKeys = () => hotkey?.reset();
  powerMonitor.on('lock-screen', resetKeys); powerMonitor.on('unlock-screen', resetKeys);
  powerMonitor.on('suspend', resetKeys); powerMonitor.on('resume', resetKeys);
  if (!storage.hasSecret(config.provider) || smoke) openSettings();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (controller) openSettings(); });
  app.whenReady().then(start).catch((error: unknown) => {
    console.error('Assistant startup failed:', error instanceof AssistantError ? error.code : error instanceof Error ? error.name : 'unknown');
    void dialog.showMessageBox({ type: 'error', title: 'AI Quick Answer', message: 'Unable to start. Secure storage or application files are unavailable.' }).then(() => app.quit());
  });
}
app.on('window-all-closed', () => { /* The assistant stays in the system tray. */ });
app.on('before-quit', () => { quitting = true; controller?.stop(); hotkey?.stop(); bridge?.close(); tray?.destroy(); });
