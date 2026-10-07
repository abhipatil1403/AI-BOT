import { Widget, widgetCSS } from '../../../packages/ui/widget';
import { defaultConfig, hideBrowserOverlay, type AssistantState } from '../../../packages/schemas';
const style = document.createElement('style'); style.textContent = widgetCSS; document.head.append(style);
let current: AssistantState = { phase: 'idle', requestId: 0, config: defaultConfig, updatedAt: Date.now() };
const widget = new Widget(document.getElementById('widget')!, {
  copy: async () => {
    const response = await chrome.runtime.sendMessage({ kind: 'copy', requestId: current.requestId }) as { ok: boolean };
    if (!response.ok) throw new Error('Copy failed');
  },
  resize: (width, height) => { void chrome.runtime.sendMessage({ kind: 'layout', width, height, position: current.config.position, hidden: hideBrowserOverlay(current.config) }).catch(() => {}); }
});
let stopped = false;
async function poll(): Promise<void> {
  if (stopped) return;
  let connected = false;
  try {
    const response = await chrome.runtime.sendMessage({ kind: 'state' }) as { ok: boolean; state?: AssistantState; error?: string };
    if (response.ok && response.state) { current = response.state; connected = true; }
    else if (current.phase !== 'error' || current.error !== response.error) current = { ...current, phase: 'error', answer: undefined, error: response.error ?? 'Desktop connection failed', updatedAt: Date.now() };
  } catch { current = { ...current, phase: 'error', answer: undefined, error: 'Extension disconnected. Reload this page', updatedAt: Date.now() }; }
  widget.update(current);
  setTimeout(() => { void poll(); }, connected ? 800 : 5000);
}
window.addEventListener('pagehide', () => { stopped = true; widget.destroy(); });
void poll();
