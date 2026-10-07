// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Widget } from '../packages/ui/widget';
import { defaultConfig, type AssistantState } from '../packages/schemas';
const widgets: Widget[] = [];
afterEach(() => { for (const widget of widgets.splice(0)) widget.destroy(); vi.useRealTimers(); document.body.replaceChildren(); });
function setup(state: AssistantState) {
  const container = document.createElement('div'); document.body.append(container);
  const copy = vi.fn().mockResolvedValue(undefined); const resize = vi.fn(); const widget = new Widget(container, { copy, resize }); widgets.push(widget); widget.update(state);
  return { widget, container, copy, resize, panel: container.querySelector<HTMLDivElement>('.panel')!, dot: container.querySelector<HTMLButtonElement>('.dot')! };
}
const ready = (answer: AssistantState['answer']): AssistantState => ({ phase: 'ready', requestId: 1, answer, config: defaultConfig, updatedAt: Date.now() });
describe('widget behavior', () => {
  it('shows a small processing dot', () => { const { dot, panel, resize } = setup({ phase: 'processing', requestId: 1, config: defaultConfig, updatedAt: Date.now() }); expect(dot.className).toContain('processing'); expect(panel.hidden).toBe(true); expect(resize).toHaveBeenLastCalledWith(40, 40); });
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
  it('shows descriptive text only on hover and has no timer', () => {
    vi.useFakeTimers(); const { panel, container } = setup(ready({ type: 'descriptive', answer: 'Paris' })); expect(panel.hidden).toBe(true);
    container.firstElementChild!.dispatchEvent(new MouseEvent('mouseenter')); expect(panel.hidden).toBe(false); vi.advanceTimersByTime(60000); expect(panel.hidden).toBe(false);
    container.firstElementChild!.dispatchEvent(new MouseEvent('mouseleave')); expect(panel.hidden).toBe(true);
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
