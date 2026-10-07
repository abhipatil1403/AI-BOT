import { bridgeRequest, getState } from '../shared/bridge';
import { copyRequestSchema } from '../../../packages/schemas';

// Content scripts cannot read extension-local credentials or pairing tokens.
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const ownPage = (sender: chrome.runtime.MessageSender): boolean => sender.id === chrome.runtime.id && !!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`);
const overlayPage = (sender: chrome.runtime.MessageSender): boolean => sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('overlay/index.html');
const settingsPage = (sender: chrome.runtime.MessageSender): boolean => ownPage(sender) && /\/(?:options|popup)\/index\.html$/.test(sender.url ?? '');
chrome.runtime.onMessage.addListener((value: unknown, sender, respond) => {
  if (!value || typeof value !== 'object') return;
  const message = value as { kind?: string; width?: number; height?: number; position?: string; hidden?: boolean; requestId?: number };
  if (message.kind === 'state' && ownPage(sender)) {
    void getState().then(state => respond({ ok: true, state })).catch((error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : 'Desktop connection failed' }));
    return true;
  }
  if (message.kind === 'layout' && overlayPage(sender) && sender.tab?.id !== undefined) {
    if (typeof message.width !== 'number' || typeof message.height !== 'number' || message.width < 40 || message.width > 440 || message.height < 40 || message.height > 360) return;
    if (!['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(message.position ?? '')) return;
    void chrome.tabs.sendMessage(sender.tab.id, { kind: 'layout', width: message.width, height: message.height, position: message.position, hidden: message.hidden === true }).catch(() => {});
    respond({ ok: true });
  }
  if (message.kind === 'trigger' && settingsPage(sender)) {
    void bridgeRequest('/v1/trigger', 'POST').then(() => respond({ ok: true })).catch((error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : 'Desktop connection failed' })); return true;
  }
  if (message.kind === 'copy' && overlayPage(sender)) {
    const copy = copyRequestSchema.safeParse({ requestId: message.requestId }); if (!copy.success) return;
    void bridgeRequest('/v1/copy', 'POST', copy.data).then(() => respond({ ok: true })).catch(() => respond({ ok: false, error: 'Answer changed or copy failed. Try again' })); return true;
  }
  if (message.kind === 'settings' && settingsPage(sender)) {
    void bridgeRequest('/v1/settings', 'POST').then(() => respond({ ok: true })).catch((error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : 'Desktop connection failed' })); return true;
  }
});
chrome.commands.onCommand.addListener(command => { if (command === 'answer-clipboard') void bridgeRequest('/v1/trigger', 'POST').catch(() => {}); });
