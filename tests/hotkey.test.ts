import { describe, expect, it, vi } from 'vitest';
import { EventType, UiohookKey, type UiohookKeyboardEvent } from 'uiohook-napi';
import { PassiveHotkey } from '../apps/desktop/hotkey';

function key(keycode: number, modifiers: Partial<UiohookKeyboardEvent> = {}): UiohookKeyboardEvent {
  return { type: EventType.EVENT_KEY_PRESSED, time: 0, keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers };
}
describe('Windows passive shortcut modifier handling', () => {
  it('recognizes the first Ctrl+V even when the native initial modifier mask is stale', () => {
    const trigger = vi.fn(); const hotkey = new PassiveHotkey(trigger);
    hotkey.handleDown(key(UiohookKey.Ctrl)); hotkey.handleDown(key(UiohookKey.V));
    expect(trigger).toHaveBeenCalledTimes(1);
    hotkey.handleDown(key(UiohookKey.V)); expect(trigger).toHaveBeenCalledTimes(1);
    hotkey.handleUp(UiohookKey.V); hotkey.handleUp(UiohookKey.Ctrl);
    hotkey.handleDown(key(UiohookKey.V)); expect(trigger).toHaveBeenCalledTimes(1);
  });
  it('requires exact configured modifiers and resets held keys across session transitions', () => {
    const trigger = vi.fn(); const hotkey = new PassiveHotkey(trigger); hotkey.configure('Ctrl+Alt+K');
    hotkey.handleDown(key(UiohookKey.Ctrl)); hotkey.handleDown(key(UiohookKey.K)); expect(trigger).not.toHaveBeenCalled();
    hotkey.handleUp(UiohookKey.K); hotkey.handleDown(key(UiohookKey.Alt)); hotkey.handleDown(key(UiohookKey.K)); expect(trigger).toHaveBeenCalledTimes(1);
    hotkey.reset(); hotkey.handleDown(key(UiohookKey.K)); expect(trigger).toHaveBeenCalledTimes(1);
  });
});
