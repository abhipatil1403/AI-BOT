import { uIOhook, UiohookKey, type UiohookKeyboardEvent } from 'uiohook-napi';
import { HotkeyGate } from '../../packages/core';
import { shortcutSchema } from '../../packages/schemas';

export class PassiveHotkey {
  private shortcut = 'Ctrl+V';
  private gate = new HotkeyGate();
  private running = false;
  constructor(private readonly trigger: () => void) {}
  configure(shortcut: string): void { this.shortcut = shortcutSchema.parse(shortcut); this.gate.reset(); }
  private matches(event: UiohookKeyboardEvent): boolean {
    const parts = this.shortcut.split('+');
    const key = parts.at(-1)!;
    const code = UiohookKey[key as keyof typeof UiohookKey];
    return event.ctrlKey && event.altKey === parts.includes('Alt') && event.shiftKey === parts.includes('Shift') && !event.metaKey && event.keycode === code;
  }
  start(): void {
    uIOhook.on('keydown', event => { if (this.gate.down(event.keycode, this.matches(event))) this.trigger(); });
    uIOhook.on('keyup', event => this.gate.up(event.keycode));
    uIOhook.start(); this.running = true;
  }
  stop(): void { if (this.running) uIOhook.stop(); this.running = false; this.gate.reset(); }
}
