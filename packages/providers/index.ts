import { AssistantError, type AIProvider } from '../core';
import { parseCookies, type Config } from '../schemas';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

type Transport = typeof fetch;
export async function readBounded(response: Response, limit = 2_000_000): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0; let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new AssistantError('response', 'Provider response is too large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel(); }
}
export async function request(transport: Transport, url: string, init: RequestInit, provider: string): Promise<Response> {
  const signal = AbortSignal.any([init.signal ?? new AbortController().signal, AbortSignal.timeout(30000)]);
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try { res = await transport(url, { ...init, signal, redirect: 'manual' }); }
    catch {
      if (signal.aborted) throw new AssistantError('timeout', 'AI request timed out or was cancelled');
      if (attempt === 0) { await delay(350, undefined, { signal }).catch(() => {}); continue; }
      throw new AssistantError('network', 'AI connection failed');
    }
    if (res.ok) return res;
    await res.body?.cancel();
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) throw new AssistantError('auth', provider === 'gemini' ? 'Gemini session expired' : 'Groq API key is invalid');
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = res.headers.get('retry-after');
      const seconds = retryAfter === null ? 0.5 : Number(retryAfter);
      if (attempt === 0 && Number.isFinite(seconds) && seconds <= 3) {
        await delay(Math.max(350, seconds * 1000), undefined, { signal }).catch(() => {});
        continue;
      }
      throw new AssistantError(res.status === 429 ? 'rate' : 'api', res.status === 429 ? 'Rate limit reached. Try again later' : 'AI provider is unavailable');
    }
    throw new AssistantError('api', 'AI provider rejected the request');
  }
  throw new AssistantError('network', 'AI connection failed');
}
export class GroqProvider implements AIProvider {
  constructor(private readonly key: string, private readonly transport: Transport = fetch) {}
  async validate(signal: AbortSignal): Promise<void> {
    const res = await request(this.transport, 'https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${this.key}` }, signal }, 'groq');
    await res.body?.cancel();
  }
  async generate(system: string, question: string, signal: AbortSignal): Promise<string> {
    const res = await request(this.transport, 'https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', temperature: 0.1, max_completion_tokens: 4096, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: question }] })
    }, 'groq');
    let raw: unknown;
    try { raw = JSON.parse(await readBounded(res)); } catch { throw new AssistantError('response', 'Groq returned an invalid response'); }
    const data = raw as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] } | null;
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || data?.choices?.[0]?.finish_reason === 'length') throw new AssistantError('response', 'Groq returned an incomplete response');
    return content;
  }
}

function nested(value: unknown, path: number[]): unknown {
  return path.reduce<unknown>((current, key) => Array.isArray(current) ? current[key] : undefined, value);
}
export function parseGeminiResponse(raw: string): string {
  let answer = '';
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('[')) continue;
    let parts: unknown;
    try { parts = JSON.parse(text); } catch { continue; }
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const code = nested(part, [5, 2, 0, 1, 0]);
      if (code === 1037) throw new AssistantError('rate', 'Rate limit reached. Try again later');
      if (typeof code === 'number' && code > 0) throw new AssistantError('api', 'Gemini session or web protocol is unavailable');
      const payload = nested(part, [2]);
      if (typeof payload !== 'string') continue;
      let value: unknown;
      try { value = JSON.parse(payload); } catch { continue; }
      const candidate = nested(value, [4, 0, 1, 0]);
      if (typeof candidate === 'string' && candidate) answer = candidate;
    }
  }
  if (!answer) throw new AssistantError('response', 'Gemini returned an invalid response');
  return answer;
}
export class GeminiWebProvider implements AIProvider {
  private readonly cookies: Record<string, string>;
  private session?: { token: string; build?: string; id?: string; expires: number };
  private requestId = 10000;
  constructor(sessionInput: string, private readonly transport: Transport = fetch) { this.cookies = parseCookies(sessionInput); }
  private headers(): Record<string, string> {
    return { Cookie: Object.entries(this.cookies).map(([name, value]) => `${name}=${value}`).join('; '), 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36' };
  }
  private updateCookies(res: Response): void {
    for (const cookie of res.headers.getSetCookie()) {
      const match = /^([A-Za-z0-9_-]+)=([^;]*)/.exec(cookie);
      if (match?.[1] && match[2] && /^[\x21-\x7e]+$/.test(match[2]) && !/[;,]/.test(match[2])) this.cookies[match[1]] = match[2];
    }
  }
  async validate(signal: AbortSignal): Promise<void> {
    const res = await request(this.transport, 'https://gemini.google.com/app', { signal, headers: this.headers() }, 'gemini');
    this.updateCookies(res);
    const html = await readBounded(res, 8_000_000);
    const token = /"SNlM0e"\s*:\s*"([^"\r\n]+)"/.exec(html)?.[1];
    if (!token) throw new AssistantError('auth', 'Gemini session expired');
    this.session = { token, build: /"cfb2h"\s*:\s*"([^"\r\n]+)"/.exec(html)?.[1], id: /"FdrFJe"\s*:\s*"([^"\r\n]+)"/.exec(html)?.[1], expires: Date.now() + 10 * 60 * 1000 };
  }
  async generate(system: string, question: string, signal: AbortSignal): Promise<string> {
    if (!this.session || this.session.expires < Date.now()) await this.validate(signal);
    const session = this.session!;
    const payload: unknown[] = Array.from({ length: 81 }, () => null);
    payload[0] = [`${system}\n\nQuestion:\n${question}`, 0, null, null, null, null, 0];
    payload[1] = ['en']; payload[2] = ['', '', '', null, null, null, null, null, null, ''];
    payload[6] = [1]; payload[7] = 1; payload[10] = 1; payload[11] = 0;
    payload[17] = [[0]]; payload[18] = 0; payload[27] = 1; payload[30] = [4];
    payload[41] = [1]; payload[45] = 1; payload[53] = 0; payload[59] = randomUUID().toUpperCase(); payload[61] = []; payload[68] = 1; payload[80] = 1;
    const params = new URLSearchParams({ hl: 'en', rt: 'c', _reqid: String(this.requestId += 100000) });
    if (session.build) params.set('bl', session.build);
    if (session.id) params.set('f.sid', session.id);
    try {
      const res = await request(this.transport, `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${params}`, {
        method: 'POST', signal,
        headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Origin: 'https://gemini.google.com', Referer: 'https://gemini.google.com/', 'x-same-domain': '1', 'x-goog-ext-525005358-jspb': JSON.stringify([payload[59], 1]) },
        body: new URLSearchParams({ at: session.token, 'f.req': JSON.stringify([null, JSON.stringify(payload)]) }).toString()
      }, 'gemini');
      this.updateCookies(res);
      return parseGeminiResponse(await readBounded(res));
    } catch (error) { this.session = undefined; throw error; }
  }
}
export function createProvider(name: Config['provider'], secret: string, transport: Transport = fetch): AIProvider {
  return name === 'groq' ? new GroqProvider(secret, transport) : new GeminiWebProvider(secret, transport);
}
