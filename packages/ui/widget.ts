import { stateSchema, type AssistantState } from '../schemas';

export const widgetCSS = `
:host, .assistant-widget { font: 13px/1.55 "Segoe UI",system-ui,sans-serif; color:#19352f; }
* { box-sizing:border-box; } body { margin:0; background:transparent; }
.assistant-widget { position:relative; width:100%; height:100%; display:flex; flex-direction:column; align-items:flex-end; justify-content:flex-end; padding:4px; gap:6px; }
.assistant-widget.left { align-items:flex-start; } .assistant-widget.top { flex-direction:column-reverse; }
.dot { flex:none; border:1px solid #abc5ba; background:#f2faf6; width:32px; height:32px; border-radius:50%; display:grid; place-items:center; cursor:pointer; padding:0; box-shadow:0 2px 8px #122d2420; }
.dot::after { content:""; width:8px; height:8px; border-radius:50%; background:#709b85; }
.dot.ready::after { background:#12684e; } .dot.error::after { background:#bb594b; }
.dot.processing::after { background:#166749; animation:pulse 1s infinite; }
.dot:focus-visible,button:focus-visible { outline:2px solid #137b57; outline-offset:2px; }
@keyframes pulse { 50% { opacity:.25; transform:scale(.75); } }
@media(prefers-reduced-motion:reduce) { .dot.processing::after { animation:none; background:#bb923d; } }
.panel { width:100%; max-height:288px; min-height:0; overflow:auto; padding:14px 16px; background:#f6faf7; border:1px solid #c7d8ce; border-radius:14px; box-shadow:0 4px 16px #102d2520; }
.panel[hidden] { display:none; } .label { font-size:10px; font-weight:700; color:#59796a; text-transform:uppercase; letter-spacing:1.3px; margin-bottom:6px; }
.answer { white-space:pre-wrap; overflow-wrap:anywhere; margin:0; } pre.answer { font:12px/1.7 Consolas,monospace; max-height:220px; overflow:auto; tab-size:4; }
.copy { margin-top:10px; font:600 12px "Segoe UI",sans-serif; border:1px solid #abcabb; color:#165b44; background:#e8f3ec; border-radius:6px; padding:6px 12px; cursor:pointer; }
.explanation { margin-top:8px; color:#607b6d; } .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
`;
export interface WidgetActions { copy(code: string): Promise<void>; resize(width: number, height: number): void }
export class Widget {
  private state?: AssistantState;
  private hovered = false;
  private focused = false;
  private expanded = false;
  private timer?: ReturnType<typeof setTimeout>;
  private root: HTMLDivElement;
  private dot: HTMLButtonElement;
  private panel: HTMLDivElement;
  private answer: HTMLElement;
  private label: HTMLDivElement;
  private copy: HTMLButtonElement;
  private explanation: HTMLDivElement;
  private announced: HTMLDivElement;
  private mcqVisible = false;
  private version = '';
  constructor(container: HTMLElement, private readonly actions: WidgetActions) {
    this.root = document.createElement('div'); this.root.className = 'assistant-widget';
    this.dot = document.createElement('button'); this.dot.className = 'dot'; this.dot.type = 'button'; this.dot.setAttribute('aria-label', 'Assistant idle');
    this.panel = document.createElement('div'); this.panel.className = 'panel'; this.panel.hidden = true; this.panel.id = 'assistant-answer';
    this.dot.setAttribute('aria-controls', this.panel.id);
    this.label = document.createElement('div'); this.label.className = 'label';
    this.answer = document.createElement('div'); this.answer.className = 'answer';
    this.copy = document.createElement('button'); this.copy.className = 'copy'; this.copy.textContent = 'Copy code'; this.copy.type = 'button'; this.copy.hidden = true;
    this.explanation = document.createElement('div'); this.explanation.className = 'explanation';
    this.announced = document.createElement('div'); this.announced.className = 'sr'; this.announced.setAttribute('aria-live', 'polite');
    this.panel.append(this.label, this.answer, this.explanation, this.copy); this.root.append(this.panel, this.dot, this.announced); container.append(this.root);
    this.root.addEventListener('mouseenter', () => { this.hovered = true; this.render(); });
    this.root.addEventListener('mouseleave', () => { this.hovered = false; this.render(); });
    this.root.addEventListener('focusin', () => { this.focused = true; this.render(); });
    this.root.addEventListener('focusout', event => { if (!this.root.contains(event.relatedTarget as Node | null)) { this.focused = false; this.render(); } });
    this.dot.addEventListener('click', () => { this.expanded = !this.expanded; this.render(); });
    this.root.addEventListener('keydown', event => { if (event.key === 'Escape') { this.expanded = false; this.focused = false; this.hovered = false; this.dot.blur(); this.render(); } });
    this.copy.addEventListener('click', async () => {
      const code = this.state?.answer; if (code?.type !== 'code') return;
      try { await this.actions.copy(code.code); this.copy.textContent = 'Copied'; }
      catch { this.copy.textContent = 'Copy failed — try again'; }
    });
  }
  update(value: unknown): void {
    const parsed = stateSchema.safeParse(value); if (!parsed.success) return;
    const state = parsed.data;
    const version = `${state.requestId}:${state.phase}:${state.updatedAt}`;
    this.state = state;
    if (this.version === version) return;
    if (this.version !== version) {
      clearTimeout(this.timer); this.version = version; this.expanded = false;
      this.mcqVisible = state.phase === 'ready' && state.answer?.type === 'mcq';
      if (this.mcqVisible && state.config.duration > 0) {
        const remaining = state.config.duration * 1000 - (Date.now() - state.updatedAt);
        if (remaining <= 0) this.mcqVisible = false;
        else this.timer = setTimeout(() => { this.mcqVisible = false; this.render(); }, remaining);
      }
      this.copy.textContent = 'Copy code';
      this.announced.textContent = state.phase === 'ready' ? state.answer?.type === 'mcq' ? `Answer ${state.answer.answer}` : 'Answer available. Focus the assistant to read it.' : state.phase === 'processing' ? 'Processing' : state.phase === 'error' ? state.error ?? 'AI connection failed' : '';
    }
    this.render();
  }
  private render(): void {
    const state = this.state; if (!state) return;
    const hidden = state.config.visibility === 'sharing' && state.config.sharing;
    this.root.hidden = hidden; this.root.style.display = hidden ? 'none' : 'flex';
    this.root.classList.toggle('left', state.config.position.endsWith('left'));
    this.root.classList.toggle('top', state.config.position.startsWith('top'));
    const intentional = this.hovered || this.focused || this.expanded;
    const show = !hidden && (state.phase === 'ready' || state.phase === 'error') && (intentional || (this.mcqVisible && state.config.visibility !== 'minimized'));
    this.panel.hidden = !show;
    this.dot.className = `dot ${state.phase}`;
    this.dot.setAttribute('aria-label', state.phase === 'ready' ? 'Answer available. Hover or focus to read' : state.phase === 'error' ? 'Assistant error. Hover or focus for details' : `Assistant ${state.phase}`);
    this.dot.setAttribute('aria-expanded', String(show));
    if (show) {
      const value = state.answer;
      this.label.textContent = state.phase === 'error' ? 'Connection' : value?.type === 'code' ? value.language : value?.type === 'mcq' ? 'Answer' : 'Quick answer';
      this.answer.textContent = state.phase === 'error' ? state.error ?? 'AI connection failed' : value?.type === 'code' ? value.code : value?.type === 'mcq' ? `${value.answer}${value.text ? `. ${value.text}` : ''}` : value?.answer ?? '';
      this.answer.style.fontFamily = value?.type === 'code' ? 'Consolas, monospace' : 'inherit';
      this.answer.style.maxHeight = value?.type === 'code' ? '205px' : '220px'; this.answer.style.overflow = 'auto';
      this.copy.hidden = value?.type !== 'code' || state.phase !== 'ready';
      this.explanation.textContent = value?.type === 'mcq' ? value.explanation ?? '' : '';
    } else { this.answer.textContent = ''; this.explanation.textContent = ''; }
    this.actions.resize(show ? (state.answer?.type === 'mcq' && !intentional ? 300 : 420) : 40, show ? (state.answer?.type === 'mcq' && !intentional ? 160 : 340) : 40);
  }
  destroy(): void { clearTimeout(this.timer); this.root.remove(); }
}
