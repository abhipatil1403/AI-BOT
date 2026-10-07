export {};
const token = document.getElementById('token') as HTMLInputElement;
const status = document.getElementById('status')!;
let checkVersion = 0;
async function check(): Promise<void> {
  const version = ++checkVersion;
  try {
    const response = await chrome.runtime.sendMessage({ kind: 'state' }) as { ok: boolean; error?: string };
    if (version !== checkVersion) return;
    status.textContent = response.ok ? 'Connected. Provider and settings are shared with the desktop app.' : response.error ?? 'Connection failed';
  } catch { if (version === checkVersion) status.textContent = 'Extension disconnected. Reload this page'; }
}
document.getElementById('save')!.addEventListener('click', () => {
  if (!/^[a-f0-9]{64}$/.test(token.value.trim())) { status.textContent = 'Enter the 64-character pairing token from desktop Settings'; return; }
  checkVersion++; status.textContent = 'Connecting…';
  void chrome.storage.local.set({ pairingToken: token.value.trim() }).then(() => { token.value = ''; return check(); }).catch(() => { status.textContent = 'Could not save pairing'; });
});
document.getElementById('forget')!.addEventListener('click', () => { checkVersion++; void chrome.storage.local.remove('pairingToken').then(() => { token.value = ''; status.textContent = 'Disconnected'; }); });
document.getElementById('settings')!.addEventListener('click', () => {
  checkVersion++;
  void chrome.runtime.sendMessage({ kind: 'settings' }).then((response: { ok: boolean; error?: string }) => { status.textContent = response.ok ? 'Desktop settings opened' : response.error ?? 'Connection failed'; }).catch(() => { status.textContent = 'Connection failed'; });
});
void check();
