export {};
const status = document.getElementById('status')!;
async function send(kind: string): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ kind }) as { ok: boolean; error?: string; state?: { config: { provider: string; shortcut: string }; phase: string } };
    status.textContent = response.ok ? response.state ? `${response.state.config.provider} · ${response.state.phase} · ${response.state.config.shortcut}` : 'Request sent' : response.error ?? 'Desktop connection failed';
  } catch { status.textContent = 'Extension disconnected. Reopen this popup'; }
}
document.getElementById('answer')!.addEventListener('click', () => { void send('trigger'); });
document.getElementById('settings')!.addEventListener('click', () => { void send('settings'); });
document.getElementById('pair')!.addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
void send('state');
