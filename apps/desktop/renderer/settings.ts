import { configSchema, type Config } from '../../../packages/schemas';
import type { SettingsData } from '../../../packages/protocol';
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const select = (id: string) => element<HTMLSelectElement>(id);
let data: SettingsData;
let dirty = false;
const status = (message: string, error = false) => { element('status').textContent = message; element('status').classList.toggle('error', error); };
const provider = (): Config['provider'] => (document.querySelector<HTMLInputElement>('input[name=provider]:checked')?.value ?? 'groq') as Config['provider'];
function updateFields(): void { element('groq-fields').hidden = provider() !== 'groq'; element('gemini-fields').hidden = provider() !== 'gemini'; }
function credentialValue(): string { return provider() === 'groq' ? input('groq-key').value : element<HTMLTextAreaElement>('gemini-cookies').value; }
async function refresh(): Promise<void> {
  data = await window.assistant.settings();
  const config = data.config;
  document.querySelector<HTMLInputElement>(`input[name=provider][value=${config.provider}]`)!.checked = true;
  for (const key of ['duration', 'language', 'position', 'visibility'] as const) select(key).value = String(config[key]);
  for (const key of ['explanations', 'comments', 'sharing', 'captureProtection'] as const) input(key).checked = config[key];
  input('shortcut').value = config.shortcut; input('pairing').value = data.pairingToken;
  element('groq-saved').textContent = data.configured.groq ? 'Saved securely' : 'Not configured';
  element('gemini-saved').textContent = data.configured.gemini ? 'Saved securely' : 'Not configured';
  element('connection').textContent = data.diagnostics.configured ? 'Provider configured' : 'Setup needed';
  const diagnostics = element('diagnostics'); diagnostics.replaceChildren();
  for (const [name, value] of Object.entries(data.diagnostics)) {
    const term = document.createElement('dt'); term.textContent = name;
    const description = document.createElement('dd'); description.textContent = String(value); diagnostics.append(term, description);
  }
  updateFields();
  dirty = false;
}
async function action(button: HTMLButtonElement, fn: () => Promise<void>, success: string): Promise<void> {
  button.disabled = true; status('Working…');
  try { await fn(); status(success); }
  catch (error) { const raw = error instanceof Error ? error.message : 'Action failed'; status(raw.replace(/^Error invoking remote method '[^']+': Error: /, ''), true); }
  finally { button.disabled = false; }
}
document.querySelectorAll('input[name=provider]').forEach(radio => radio.addEventListener('change', updateFields));
element('settings').addEventListener('input', () => { dirty = true; });
element('settings').addEventListener('change', () => { dirty = true; });
element('settings').addEventListener('submit', event => {
  event.preventDefault();
  const next = configSchema.safeParse({ ...data.config, provider: provider(), duration: Number(select('duration').value), language: select('language').value, position: select('position').value, visibility: select('visibility').value, shortcut: input('shortcut').value, explanations: input('explanations').checked, comments: input('comments').checked, sharing: input('sharing').checked, captureProtection: input('captureProtection').checked });
  if (!next.success) { status('Invalid shortcut. Use Ctrl+[Alt+][Shift+] followed by a letter, digit or F1–F12.', true); return; }
  void action(document.querySelector<HTMLButtonElement>('button[type=submit]')!, async () => { await window.assistant.saveConfig(next.data); await refresh(); }, 'Settings saved');
});
element<HTMLButtonElement>('validate').addEventListener('click', event => { void action(event.currentTarget as HTMLButtonElement, () => window.assistant.validateCredential(provider(), credentialValue()), 'Connection validated'); });
element<HTMLButtonElement>('save-credential').addEventListener('click', event => { void action(event.currentTarget as HTMLButtonElement, async () => {
  const name = provider(); await window.assistant.saveCredential(name, credentialValue());
  await window.assistant.saveConfig({ ...data.config, provider: name });
  input('groq-key').value = ''; element<HTMLTextAreaElement>('gemini-cookies').value = ''; await refresh();
}, 'Credential saved securely'); });
element<HTMLButtonElement>('remove-credential').addEventListener('click', event => { void action(event.currentTarget as HTMLButtonElement, async () => { await window.assistant.removeCredential(provider()); await refresh(); }, 'Credential removed'); });
element<HTMLButtonElement>('rotate').addEventListener('click', event => { void action(event.currentTarget as HTMLButtonElement, async () => { input('pairing').value = await window.assistant.rotatePairing(); }, 'Pairing token rotated'); });
element<HTMLButtonElement>('test-clipboard').addEventListener('click', event => { void action(event.currentTarget as HTMLButtonElement, () => window.assistant.trigger(), 'Clipboard request triggered'); });
window.assistant.onState(() => { /* No answer content is displayed in Settings. */ });
void refresh().catch(() => status('Settings could not be loaded. Restart the application.', true));
window.addEventListener('focus', () => { if (data && !dirty && !input('groq-key').value && !element<HTMLTextAreaElement>('gemini-cookies').value) void refresh().catch(() => {}); });
