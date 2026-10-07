// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Widget } from '../packages/ui/widget';
import { defaultConfig, type AssistantState } from '../packages/schemas';
const widgets: Widget[] = [];
afterEach(() => { for (const widget of widgets.splice(0)) widget.destroy(); vi.useRealTimers(); document.body.replaceChildren(); });
function setup(state: AssistantState) {
  const container = document.createElement('div'); document.body.append(container);
  const copy = vi.fn().mockResolvedValue(undefined); const dismiss = vi.fn().mockResolvedValue(undefined); const resize = vi.fn(); const widget = new Widget(container, { copy, dismiss, resize }); widgets.push(widget); widget.update(state);
  return { widget, container, copy, dismiss, resize, panel: container.querySelector<HTMLDivElement>('.panel')!, dot: container.querySelector<HTMLButtonElement>('.dot')! };
}
const ready = (answer: AssistantState['answer']): AssistantState => ({ phase: 'ready', requestId: 1, answer, config: defaultConfig, updatedAt: Date.now() });
describe('widget behavior', () => {
  it('hides the idle surface and activates an 18px surface for processing', () => {
    const { widget, container, dot, panel, resize } = setup({ phase: 'idle', requestId: 0, config: defaultConfig, updatedAt: Date.now() });
    expect((container.firstElementChild as HTMLElement).hidden).toBe(true); expect(resize).toHaveBeenLastCalledWith(18, 18, false);
    widget.update({ phase: 'processing', requestId: 1, config: defaultConfig, updatedAt: Date.now() });
    expect(dot.className).toContain('processing'); expect(panel.hidden).toBe(true); expect(resize).toHaveBeenLastCalledWith(18, 18, true);
  });
  it('shows MCQ temporarily and does not reset timer on repeated state', () => {
    vi.useFakeTimers(); const state = ready({ type: 'mcq', answer: 'B', text: 'Paris' }); const { panel, widget } = setup(state);
    expect(panel.hidden).toBe(false); vi.advanceTimersByTime(3000); widget.update(state); vi.advanceTimersByTime(2001); expect(panel.hidden).toBe(true);
  });
  it('keeps MCQ until next request when duration is zero', () => { vi.useFakeTimers(); const state = ready({ type: 'mcq', answer: 'B' }); state.config = { ...defaultConfig, duration: 0 }; const { panel } = setup(state); vi.advanceTimersByTime(60000); expect(panel.hidden).toBe(false); });
  it('returns MCQ to idle at the deadline even while hovered', () => {
    vi.useFakeTimers(); const { panel, container, dot } = setup(ready({ type: 'mcq', answer: 'B' }));
    container.firstElementChild!.dispatchEvent(new MouseEvent('mouseenter')); expect(panel.hidden).toBe(false);
    vi.advanceTimersByTime(5001); expect(panel.hidden).toBe(true); expect(dot.className).toBe('dot idle');
  });
  it.each([2, 3, 5, 10, 15] as const)('never reveals MCQ after its %s second deadline', duration => {
    vi.useFakeTimers(); const state = ready({ type: 'mcq', answer: 'B' }); state.config = { ...defaultConfig, duration };
    const { panel, dot, container, widget, resize } = setup(state);
    const root = container.firstElementChild as HTMLElement;
    root.dispatchEvent(new MouseEvent('mouseenter')); dot.focus(); dot.click();
    vi.advanceTimersByTime(duration * 1000 + 1);
    root.dispatchEvent(new MouseEvent('mouseleave')); root.dispatchEvent(new MouseEvent('mouseenter')); dot.click(); widget.update(state);
    expect(panel.hidden).toBe(true); expect(root.hidden).toBe(true); expect(resize).toHaveBeenLastCalledWith(18, 18, false);
    expect(container.querySelector('.answer')!.textContent).toBe('');
  });
  it('keeps late-loaded MCQ hidden without restarting its deadline', () => {
    const state = ready({ type: 'mcq', answer: 'B' }); state.updatedAt -= 6000;
    const { panel, container } = setup(state); container.firstElementChild!.dispatchEvent(new MouseEvent('mouseenter'));
    expect(panel.hidden).toBe(true); expect((container.firstElementChild as HTMLElement).hidden).toBe(true);
  });
  it('dismisses text manually, resists repeated state and reactivates for a new request', async () => {
    const state = ready({ type: 'descriptive', answer: 'Paris' }); const { panel, container, widget, dismiss } = setup(state);
    const root = container.firstElementChild as HTMLElement; root.dispatchEvent(new MouseEvent('mouseenter'));
    container.querySelector<HTMLButtonElement>('.close')!.click(); await vi.waitFor(() => expect(dismiss).toHaveBeenCalledExactlyOnceWith(1));
    root.dispatchEvent(new MouseEvent('mouseenter')); widget.update(state); expect(root.hidden).toBe(true); expect(panel.hidden).toBe(true);
    widget.update({ ...state, phase: 'processing', answer: undefined, requestId: 2 }); expect(root.hidden).toBe(false); expect(panel.hidden).toBe(true);
    widget.update({ ...state, requestId: 2 }); root.dispatchEvent(new MouseEvent('mouseenter')); expect(panel.hidden).toBe(false);
  });
  it('shows descriptive text only on hover and has no timer', () => {
    vi.useFakeTimers(); const { panel, container } = setup(ready({ type: 'descriptive', answer: 'Paris' })); expect(panel.hidden).toBe(true);
    container.firstElementChild!.dispatchEvent(new MouseEvent('mouseenter')); expect(panel.hidden).toBe(false); vi.advanceTimersByTime(60000); expect(panel.hidden).toBe(false);
    container.firstElementChild!.dispatchEvent(new MouseEvent('mouseleave')); expect(panel.hidden).toBe(true);
    container.firstElementChild!.dispatchEvent(new MouseEvent('mouseenter')); expect(panel.hidden).toBe(false);
  });
  it('supports keyboard focus and escape', () => { const { dot, panel, container } = setup(ready({ type: 'descriptive', answer: 'Paris' })); dot.focus(); expect(panel.hidden).toBe(false); container.firstElementChild!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(panel.hidden).toBe(true); });
  it('copies exactly raw code and renders markup as text', async () => {
    const code = 'print("<script>alert(1)</script>")\n'; const { container, dot, copy } = setup(ready({ type: 'code', language: 'python', code })); dot.focus();
    container.querySelector<HTMLButtonElement>('.copy')!.click(); await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(code)); expect(container.querySelector('script')).toBeNull(); expect(container.querySelector('.answer')!.textContent).toBe(code);
  });
  it('hides the entire widget when sharing is explicitly active', () => { const state = ready({ type: 'descriptive', answer: 'private' }); state.config = { ...defaultConfig, visibility: 'sharing', sharing: true }; const { container } = setup(state); expect((container.firstElementChild as HTMLElement).hidden).toBe(true); expect(container.querySelector('.answer')!.textContent).toBe(''); });
  it('keeps minimized MCQs hidden until focus', () => { const state = ready({ type: 'mcq', answer: 'B' }); state.config = { ...defaultConfig, visibility: 'minimized' }; const { panel, dot } = setup(state); expect(panel.hidden).toBe(true); dot.focus(); expect(panel.hidden).toBe(false); });
  it('ignores malformed state from the bridge', () => { const { widget, panel } = setup(ready({ type: 'descriptive', answer: 'Paris' })); widget.update({ phase: 'ready', answer: '<img>' }); expect(panel.hidden).toBe(true); });
});
