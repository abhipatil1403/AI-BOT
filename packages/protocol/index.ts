import type { AssistantState, Config } from '../schemas';
export const HOST = '127.0.0.1';
export const PORT = 47831;
export const BASE_URL = `http://${HOST}:${PORT}`;
export interface Diagnostics { provider: Config['provider']; configured: boolean; hotkey: string; bridge: string; encryption: boolean; version: string; capture: string }
export interface SettingsData { config: Config; configured: { groq: boolean; gemini: boolean }; pairingToken: string; diagnostics: Diagnostics }
export interface DesktopAPI {
  settings(): Promise<SettingsData>;
  saveConfig(config: Config): Promise<void>;
  saveCredential(provider: Config['provider'], value: string): Promise<void>;
  validateCredential(provider: Config['provider'], value: string): Promise<void>;
  removeCredential(provider: Config['provider']): Promise<void>;
  rotatePairing(): Promise<string>;
  trigger(): Promise<void>;
  copyCode(requestId: number): Promise<void>;
  resizeWidget(width: number, height: number): void;
  onState(callback: (state: AssistantState) => void): () => void;
}
declare global { interface Window { assistant: DesktopAPI } }
