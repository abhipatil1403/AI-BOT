import { answerQuestion, AssistantError, sanitizeInput, type AIProvider } from '../../packages/core';
import type { AssistantState, Config } from '../../packages/schemas';

export class Controller {
  state: AssistantState;
  private pending?: AbortController;
  private lastTrigger = 0;
  private clipboardSequence = 0;
  constructor(config: Config, private readonly clipboard: () => string | Promise<string>, private readonly provider: (config: Config) => AIProvider, private readonly publish: (state: AssistantState) => void) {
    this.state = { phase: 'idle', requestId: 0, updatedAt: Date.now(), config };
  }
  configure(config: Config): void {
    this.clipboardSequence++;
    this.pending?.abort(); this.pending = undefined;
    this.state = { phase: 'idle', requestId: this.state.requestId + 1, config, updatedAt: Date.now() }; this.publish(this.state);
  }
  async trigger(): Promise<void> {
    if (Date.now() - this.lastTrigger < 300) return;
    this.lastTrigger = Date.now();
    const sequence = ++this.clipboardSequence;
    let text: string;
    try { text = sanitizeInput(await this.clipboard()); if (sequence !== this.clipboardSequence) return; }
    catch (error) {
      if (sequence !== this.clipboardSequence) return;
      if (error instanceof AssistantError && error.code === 'empty') return;
      this.pending?.abort(); this.pending = undefined;
      this.fail(error); return;
    }
    this.pending?.abort();
    const pending = new AbortController(); this.pending = pending;
    const requestId = this.state.requestId + 1;
    const config = { ...this.state.config };
    this.state = { phase: 'processing', requestId, config, updatedAt: Date.now() }; this.publish(this.state);
    try {
      const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(65000)]);
      const answer = await answerQuestion(text, config, this.provider(config), signal);
      if (pending.signal.aborted) return;
      this.state = { phase: 'ready', requestId, config, updatedAt: Date.now(), answer }; this.publish(this.state);
    } catch (error) { if (!pending.signal.aborted) this.fail(error); }
    finally { if (this.pending === pending) this.pending = undefined; }
  }
  private fail(error: unknown): void {
    this.state = { phase: 'error', requestId: this.state.requestId, config: this.state.config, updatedAt: Date.now(), error: error instanceof AssistantError ? error.message : 'AI connection failed' };
    this.publish(this.state);
  }
  stop(): void { this.clipboardSequence++; this.pending?.abort(); }
}
