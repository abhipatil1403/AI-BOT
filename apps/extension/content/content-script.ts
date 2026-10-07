// The only injected element is an extension-owned frame; no clipboard or answer
// content is handled by this content script.
const frame = document.createElement('iframe');
frame.src = chrome.runtime.getURL('overlay/index.html');
frame.title = 'AI Quick Answer'; frame.setAttribute('allow', 'clipboard-write');
frame.style.cssText = 'position:fixed!important;bottom:16px!important;right:16px!important;width:18px!important;height:18px!important;border:0!important;background:transparent!important;z-index:2147483647!important;color-scheme:light!important;display:none!important;';
document.documentElement.append(frame);
chrome.runtime.onMessage.addListener((value: unknown, sender) => {
  if (sender.id !== chrome.runtime.id || !value || typeof value !== 'object') return;
  const message = value as { kind?: string; width?: number; height?: number; position?: string; hidden?: boolean };
  if (message.kind !== 'layout' || typeof message.width !== 'number' || typeof message.height !== 'number' || !['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(message.position ?? '')) return;
  if (!Number.isInteger(message.width) || !Number.isInteger(message.height) || message.width < 18 || message.width > 320 || message.height < 18 || message.height > 220) return;
  frame.style.setProperty('width', `${message.width}px`, 'important'); frame.style.setProperty('height', `${message.height}px`, 'important');
  frame.style.setProperty('display', message.hidden ? 'none' : 'block', 'important');
  for (const edge of ['top', 'bottom', 'left', 'right']) frame.style.setProperty(edge, message.position!.includes(edge) ? '16px' : 'auto', 'important');
});
