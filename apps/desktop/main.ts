import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, safeStorage, screen, Tray } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { z } from 'zod';
import { AssistantError, type AIProvider } from '../../packages/core';
import { configSchema, parseCookies, type AssistantState, type Config } from '../../packages/schemas';
import { createProvider } from '../../packages/providers';
import { PORT, type SettingsData } from '../../packages/protocol';
import { Storage } from './storage';
import { Controller } from './controller';
import { startBridge } from './bridge';
import { PassiveHotkey } from './hotkey';

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
  const url = pathToFileURL(join(views, file)).href;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, destination) => { if (destination !== url) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  void window.loadURL(url);
}
function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({ width: 770, height: 850, minWidth: 620, minHeight: 650, title: 'AI Quick Answer · Settings', backgroundColor: '#f5f7f6', autoHideMenuBar: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !app.isPackaged } });
  secureWindow(settingsWindow, 'settings.html');
  settingsWindow.on('close', event => { if (!quitting) { event.preventDefault(); settingsWindow?.hide(); } });
}
function positionWidget(): void {
  if (!widgetWindow) return;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [width = 40, height = 40] = widgetWindow.getSize();
  const left = config.position.endsWith('left'); const top = config.position.startsWith('top');
  widgetWindow.setPosition(left ? area.x + 16 : area.x + area.width - width - 16, top ? area.y + 16 : area.y + area.height - height - 16);
}
function visibleState(): AssistantState {
  const hidden = config.visibility === 'sharing' && config.sharing;
  return hidden ? { ...controller.state, phase: 'idle', answer: undefined, error: undefined } : controller.state;
}
function publish(): void {
  if (!controller) return;
  if (config.visibility === 'sharing' && config.sharing) widgetWindow?.hide();
  else if (widgetWindow && !widgetWindow.isVisible()) widgetWindow.showInactive();
  const state = visibleState();
  for (const window of [widgetWindow, settingsWindow]) if (window && !window.isDestroyed()) window.webContents.send('assistant:state', state);
}
function updateTray(): void {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'AI Quick Answer', enabled: false },
    { label: `Shortcut: ${config.shortcut}`, enabled: false },
    { label: 'Settings', click: openSettings },
    { label: 'Answer clipboard', click: () => { void controller.trigger(); } },
    { label: 'Screen sharing is active', type: 'checkbox', checked: config.sharing, click: item => {
      config = { ...config, sharing: item.checked }; storage.saveConfig(config); controller.configure(config); updateTray();
    } },
    { type: 'separator' }, { label: 'Quit', click: () => app.quit() }
  ]));
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
    try { parseCookies(secret); } catch (error) { throw new AssistantError('cookies', error instanceof Error ? error.message : 'Invalid cookie JSON'); }
  }
  return { name, secret };
}
function registerIPC(): void {
  handle('settings:get', true, (): SettingsData => ({ config, pairingToken, configured: { groq: storage.hasSecret('groq'), gemini: storage.hasSecret('gemini') }, diagnostics: { provider: config.provider, configured: storage.hasSecret(config.provider), hotkey: hotkeyStatus, bridge: bridgeStatus, encryption: encryptionAvailable(), version: app.getVersion() } }));
  handle('settings:save', true, value => {
    const next = configSchema.safeParse(value);
    if (!next.success) throw new AssistantError('settings', 'Invalid settings or shortcut. Use Ctrl+[Alt+][Shift+]+key');
    storage.saveConfig(next.data); config = next.data; hotkey?.configure(config.shortcut); controller.configure(config); updateTray();
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
  handle('assistant:copy', false, async () => { if (controller.state.phase === 'ready' && controller.state.answer?.type === 'code') await clipboard.writeText(controller.state.answer.code); });
  ipcMain.on('assistant:subscribe', event => { if (authorized(event)) event.sender.send('assistant:state', visibleState()); });
  ipcMain.on('widget:resize', (event, width: unknown, height: unknown) => {
    if (!authorized(event) || event.sender.id !== widgetWindow?.webContents.id) return;
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width < 40 || width > 440 || height < 40 || height > 360) return;
    widgetWindow.setSize(width, height); positionWidget();
  });
}

async function start(): Promise<void> {
  storage = new Storage(app.getPath('userData'), { isEncryptionAvailable: encryptionAvailable, encryptString: value => safeStorage.encryptString(value), decryptString: value => safeStorage.decryptString(value) });
  config = storage.loadConfig();
  pairingToken = storage.getSecret('pairing') ?? randomBytes(32).toString('hex');
  storage.setSecret('pairing', pairingToken);
  controller = new Controller(config, () => clipboard.readText(), providerFor, publish);
  registerIPC();
  widgetWindow = new BrowserWindow({ width: 40, height: 40, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false, title: 'AI Quick Answer widget', webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !app.isPackaged } });
  widgetWindow.setAlwaysOnTop(true, 'floating');
  secureWindow(widgetWindow, 'widget.html');
  widgetWindow.once('ready-to-show', () => { positionWidget(); publish(); });
  screen.on('display-metrics-changed', positionWidget);
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGElEQVQ4T2NkqLf4z0ABYBw1gGE0DBgGAgBxpR4xBXNK1AAAAABJRU5ErkJggg==');
  tray = new Tray(icon); tray.setToolTip('AI Quick Answer'); tray.on('double-click', openSettings); updateTray();
  try { bridge = await startBridge(controller, () => pairingToken, openSettings); bridgeStatus = `Listening on 127.0.0.1:${PORT}`; }
  catch { bridgeStatus = `Unavailable: port ${PORT} is in use. Restart after closing the conflicting application`; }
  hotkey = new PassiveHotkey(() => { if (BrowserWindow.getFocusedWindow() === settingsWindow) return; void controller.trigger(); });
  hotkey.configure(config.shortcut);
  try { hotkey.start(); hotkeyStatus = 'Passive listener active (normal paste preserved)'; }
  catch { hotkeyStatus = 'Unavailable. Restart the app and check keyboard permissions'; }
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
