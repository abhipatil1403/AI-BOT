import { stateSchema, type AssistantState } from '../schemas';

export const widgetCSS = `
:host, .assistant-widget { font: 11px/1.4 "Segoe UI",system-ui,sans-serif; color:#d8e7df; }
* { box-sizing:border-box; } body { margin:0; background:transparent; }
.assistant-widget { position:relative; width:100%; height:100%; display:flex; flex-direction:column; align-items:flex-end; justify-content:flex-end; padding:3px; gap:4px; }
.assistant-widget.left { align-items:flex-start; } .assistant-widget.top { flex-direction:column-reverse; }
.dot { flex:none; border:0; background:transparent; width:12px; height:12px; border-radius:50%; display:grid; place-items:center; cursor:pointer; padding:0; }
.dot::after { content:""; width:6px; height:6px; border-radius:50%; background:#c2d7cb; box-shadow:0 0 2px #18312670; }
.dot.ready::after { background:#c9e4d4; } .dot.error::after { background:#e1b9af; }
.dot.processing::after { background:#d7e8dd; animation:pulse .8s ease-in-out infinite; }
.dot:focus-visible,button:focus-visible { outline:1px solid #bfd9c9; outline-offset:1px; }
@keyframes pulse { 50% { opacity:.12; } }
@media(prefers-reduced-motion:reduce) { .dot.processing::after { animation:none; background:#bb923d; } }
.panel { width:100%; flex-shrink:0; max-height:176px; min-height:0; overflow:auto; padding:6px 8px; background:transparent; border:1px solid #d0e2d325; border-radius:6px; text-shadow:0 1px 2px #14241ddb; }
.panel[hidden], .assistant-widget[hidden] { display:none; } .panel-header { display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:3px; }
.label { font-size:8px; font-weight:500; color:#c3d6ca; text-transform:uppercase; letter-spacing:.6px; }
.close { flex:none; font:12px/14px "Segoe UI",sans-serif; width:14px; height:14px; border:0; padding:0; color:#c3d6ca; background:transparent; cursor:pointer; text-shadow:inherit; }
.answer { white-space:pre-wrap; overflow-wrap:anywhere; margin:0; } pre.answer { font:12px/1.7 Consolas,monospace; max-height:220px; overflow:auto; tab-size:4; }
.copy { margin-top:5px; font:10px "Segoe UI",sans-serif; border:1px solid #c3d6ca30; color:#d8e7df; background:transparent; border-radius:3px; padding:2px 5px; cursor:pointer; text-shadow:inherit; }
.explanation { margin-top:4px; color:#c3d6ca; } .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
`;
export interface WidgetActions { copy(code: string): Promise<void>; dismiss(requestId: number): Promise<void>; resize(width: number, height: number, visible: boolean): void }
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
  private dismissed = false;
  private version = '';
  private readonly onResize = () => this.render();
  constructor(container: HTMLElement, private readonly actions: WidgetActions) {
    this.root = document.createElement('div'); this.root.className = 'assistant-widget';
    this.dot = document.createElement('button'); this.dot.className = 'dot'; this.dot.type = 'button'; this.dot.setAttribute('aria-label', 'Assistant idle');
    this.panel = document.createElement('div'); this.panel.className = 'panel'; this.panel.hidden = true; this.panel.id = 'assistant-answer';
    this.dot.setAttribute('aria-controls', this.panel.id);
    this.label = document.createElement('div'); this.label.className = 'label';
    const header = document.createElement('div'); header.className = 'panel-header';
    const close = document.createElement('button'); close.className = 'close'; close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss answer'); close.title = 'Dismiss answer';
    header.append(this.label, close);
    this.answer = document.createElement('div'); this.answer.className = 'answer';
    this.copy = document.createElement('button'); this.copy.className = 'copy'; this.copy.textContent = 'Copy code'; this.copy.type = 'button'; this.copy.hidden = true;
    this.explanation = document.createElement('div'); this.explanation.className = 'explanation';
    this.announced = document.createElement('div'); this.announced.className = 'sr'; this.announced.setAttribute('aria-live', 'polite');
    this.root.hidden = true;
    window.addEventListener('resize', this.onResize);
    this.panel.append(header, this.answer, this.explanation, this.copy); this.root.append(this.panel, this.dot, this.announced); container.append(this.root);
    close.addEventListener('click', () => {
      if (!this.state || !['ready', 'error'].includes(this.state.phase)) return;
      this.dismissed = true; this.expanded = false; this.hovered = false; this.focused = false;
      clearTimeout(this.timer); this.announced.textContent = ''; this.render();
      void this.actions.dismiss(this.state.requestId).catch(() => { /* Keep locally dismissed until the next request. */ });
    });
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
    const newRequest = this.state?.requestId !== state.requestId;
    this.state = state;
    if (this.version === version) return;
    if (this.version !== version) {
      clearTimeout(this.timer); this.version = version; this.expanded = false;
      if (newRequest) { this.dismissed = false; this.hovered = false; this.focused = false; }
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
    if (this.mcqVisible && state.answer?.type === 'mcq' && state.config.duration > 0 && Date.now() >= state.updatedAt + state.config.duration * 1000) this.mcqVisible = false;
    const expired = state.phase === 'ready' && state.answer?.type === 'mcq' && !this.mcqVisible;
    const hidden = state.phase === 'idle' || this.dismissed || expired || (state.config.visibility === 'sharing' && state.config.sharing);
    this.root.hidden = hidden; this.root.style.display = hidden ? 'none' : 'flex';
    this.root.classList.toggle('left', state.config.position.endsWith('left'));
    this.root.classList.toggle('top', state.config.position.startsWith('top'));
    const intentional = this.hovered || this.focused || this.expanded;
    const show = !hidden && (state.phase === 'ready' || state.phase === 'error') && (state.answer?.type === 'mcq' ? this.mcqVisible && (intentional || state.config.visibility !== 'minimized') : intentional);
    this.panel.hidden = !show;
    const phase = state.phase === 'ready' && state.answer?.type === 'mcq' && !this.mcqVisible ? 'idle' : state.phase;
    this.dot.className = `dot ${phase}`;
    this.dot.setAttribute('aria-label', phase === 'ready' ? 'Answer available. Hover or focus to read' : phase === 'error' ? 'Assistant error. Hover or focus for details' : `Assistant ${phase}`);
    this.dot.setAttribute('aria-expanded', String(show));
    if (show) {
      const value = state.answer;
      this.label.textContent = state.phase === 'error' ? 'Connection' : value?.type === 'code' ? value.language : value?.type === 'mcq' ? 'Answer' : 'Quick answer';
      this.answer.textContent = state.phase === 'error' ? state.error ?? 'AI connection failed' : value?.type === 'code' ? value.code : value?.type === 'mcq' ? `${value.answer}${value.text ? `. ${value.text}` : ''}` : value?.answer ?? '';
      this.answer.style.fontFamily = value?.type === 'code' ? 'Consolas, monospace' : 'inherit';
      this.answer.style.fontSize = value?.type === 'code' ? '10px' : '11px';
      this.answer.style.maxHeight = '125px'; this.answer.style.overflow = 'auto';
      this.copy.hidden = value?.type !== 'code' || state.phase !== 'ready';
      this.explanation.textContent = value?.type === 'mcq' ? value.explanation ?? '' : '';
    } else { this.answer.textContent = ''; this.explanation.textContent = ''; }
    const width = show ? state.answer?.type === 'code' ? 286 : state.answer?.type === 'mcq' ? 166 : 226 : 18;
    this.panel.style.width = `${width - 6}px`;
    const height = show ? Math.min(204, Math.ceil(this.panel.getBoundingClientRect().height) + 22) : 18;
    this.actions.resize(width, height, !hidden);
  }
  destroy(): void { clearTimeout(this.timer); window.removeEventListener('resize', this.onResize); this.root.remove(); }
}
