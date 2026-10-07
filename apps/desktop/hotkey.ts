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
    // libuiohook can initialize its modifier mask before Windows applies the
    // first modifier keydown. Use the observed down/up events as well as its
    // mask so the first Ctrl+V after startup is recognized.
    const ctrl = event.ctrlKey || this.gate.isDown(UiohookKey.Ctrl) || this.gate.isDown(UiohookKey.CtrlRight);
    const alt = event.altKey || this.gate.isDown(UiohookKey.Alt) || this.gate.isDown(UiohookKey.AltRight);
    const shift = event.shiftKey || this.gate.isDown(UiohookKey.Shift) || this.gate.isDown(UiohookKey.ShiftRight);
    const meta = event.metaKey || this.gate.isDown(UiohookKey.Meta) || this.gate.isDown(UiohookKey.MetaRight);
    return ctrl && alt === parts.includes('Alt') && shift === parts.includes('Shift') && !meta && event.keycode === code;
  }
  handleDown(event: UiohookKeyboardEvent): void { if (this.gate.down(event.keycode, this.matches(event))) this.trigger(); }
  handleUp(key: number): void { this.gate.up(key); }
  reset(): void { this.gate.reset(); }
  start(): void {
    uIOhook.on('keydown', event => this.handleDown(event));
    uIOhook.on('keyup', event => this.handleUp(event.keycode));
    uIOhook.start(); this.running = true;
  }
  stop(): void { if (this.running) uIOhook.stop(); this.running = false; this.gate.reset(); }
}
