import { AssistantError, sanitizeQuestion, type AIProvider, type QuestionImage } from '../core';
import { parseCookies, type Config } from '../schemas';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';

type Transport = typeof fetch;
// Google's Set-Cookie response headers can exceed Node's default 16 KiB.
// Keep the higher limit scoped to Gemini, with a finite bound and normal TLS.
const geminiAgent = new Agent({ maxHeaderSize: 65536 });
export const geminiTransport: Transport = (input, init) => {
  const options: RequestInit & { dispatcher: Agent } = { ...init, dispatcher: geminiAgent };
  return fetch(input, options);
};
export const GROQ_MODEL = 'openai/gpt-oss-120b';
export const GROQ_VISION_MODEL = 'qwen/qwen3.8-27b';
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
    catch (error) {
      if (signal.aborted) throw new AssistantError('timeout', 'AI request timed out or was cancelled');
      const cause = error instanceof Error ? error.cause : undefined;
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
      if (code === 'UND_ERR_HEADERS_OVERFLOW' || code === 'HPE_HEADER_OVERFLOW') throw new AssistantError('network', 'AI response headers exceeded the connection limit. Update the app');
      if (attempt === 0) { await delay(350, undefined, { signal }).catch(() => {}); continue; }
      throw new AssistantError('network', 'AI connection failed');
    }
    if (res.ok) return res;
    if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel();
      throw new AssistantError('auth', provider === 'gemini' ? 'Gemini session expired' : 'Groq API key is invalid');
    }
    if (res.status === 403) {
      await res.body?.cancel();
      throw new AssistantError(provider === 'gemini' ? 'auth' : 'permission', provider === 'gemini' ? 'Gemini session expired' : 'Groq access denied (HTTP 403). Check project and model permissions');
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel();
      const retryAfter = res.headers.get('retry-after');
      const seconds = retryAfter === null ? 0.5 : Number(retryAfter);
      if (attempt === 0 && Number.isFinite(seconds) && seconds <= 3) {
        await delay(Math.max(350, seconds * 1000), undefined, { signal }).catch(() => {});
        continue;
      }
      throw new AssistantError(res.status === 429 ? 'rate' : 'api', res.status === 429 ? 'Rate limit reached. Try again later' : 'AI provider is unavailable');
    }
    let code: unknown;
    if (provider === 'groq') {
      // Error messages can echo user input or credentials. Map known codes
      // from a bounded error body to our own messages.
      try {
        const raw: unknown = JSON.parse(await readBounded(res, 16384));
        if (raw && typeof raw === 'object' && 'error' in raw && raw.error && typeof raw.error === 'object' && 'code' in raw.error) code = raw.error.code;
      } catch { /* Use the status when the error body is unavailable. */ }
    } else await res.body?.cancel();
    if (provider === 'groq' && ['model_decommissioned', 'model_not_found', 'model_not_available', 'model_permission_blocked_org', 'model_permission_blocked_project'].includes(String(code))) throw new AssistantError('model', 'Groq model unavailable (HTTP ' + res.status + '). Update the app or check model permissions');
    if (provider === 'groq' && code === 'json_validate_failed') throw new AssistantError('response', 'Groq could not generate valid JSON. Try again');
    if (res.status === 413 || code === 'context_length_exceeded') throw new AssistantError('size', (provider === 'groq' ? 'Groq' : 'Gemini') + ' request is too large. Copy a shorter question');
    if (provider === 'groq' && res.status === 402) throw new AssistantError('quota', 'Groq billing or quota limit reached (HTTP 402)');
    throw new AssistantError('api', (provider === 'groq' ? 'Groq' : 'Gemini') + ' rejected the request (HTTP ' + res.status + '). Check provider settings');
  }
  throw new AssistantError('network', 'AI connection failed');
}
export class GroqProvider implements AIProvider {
  constructor(private readonly key: string, private readonly transport: Transport = fetch) {}
  async validate(signal: AbortSignal): Promise<void> {
    const res = await request(this.transport, 'https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${this.key}` }, signal }, 'groq');
    let raw: unknown;
    try { raw = JSON.parse(await readBounded(res)); } catch { throw new AssistantError('response', 'Groq returned an invalid model list'); }
    if (!raw || typeof raw !== 'object' || !('data' in raw) || !Array.isArray(raw.data)) throw new AssistantError('response', 'Groq returned an invalid model list');
    if (!raw.data.some(model => model && typeof model === 'object' && model.id === GROQ_MODEL)) throw new AssistantError('model', 'Groq model ' + GROQ_MODEL + ' is unavailable for this account');
  }
  async generate(system: string, question: string, signal: AbortSignal, image?: QuestionImage): Promise<string> {
    if (image) sanitizeQuestion({ image });
    const userContent = image ? [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')}` } }] : question;
    const res = await request(this.transport, 'https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: image ? GROQ_VISION_MODEL : GROQ_MODEL, reasoning_effort: image ? 'none' : 'low', temperature: 0.1, max_completion_tokens: 4096, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }] })
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
  private session?: { token: string; build?: string; id?: string; pushId: string; expires: number };
  private requestId = 10000;
  constructor(sessionInput: string, private readonly transport: Transport = geminiTransport) { this.cookies = parseCookies(sessionInput); }
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
    this.session = { token, build: /"cfb2h"\s*:\s*"([^"\r\n]+)"/.exec(html)?.[1], id: /"FdrFJe"\s*:\s*"([^"\r\n]+)"/.exec(html)?.[1], pushId: /"qKIAYe"\s*:\s*"([^"\r\n]+)"/.exec(html)?.[1] ?? 'feeds/mcudyrk2a4khkz', expires: Date.now() + 10 * 60 * 1000 };
  }
  async generate(system: string, question: string, signal: AbortSignal, image?: QuestionImage): Promise<string> {
    if (image) sanitizeQuestion({ image });
    if (!this.session || this.session.expires < Date.now()) await this.validate(signal);
    const session = this.session!;
    try {
    let fileData: unknown = null;
    if (image) {
      const name = image.mimeType === 'image/png' ? 'question.png' : 'question.jpg';
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(image.data)], { type: image.mimeType }), name);
      const upload = await request(this.transport, 'https://content-push.googleapis.com/upload', {
        method: 'POST', signal, body: form,
        headers: { ...this.headers(), Origin: 'https://gemini.google.com', Referer: 'https://gemini.google.com/', 'X-Tenant-Id': 'bard-storage', 'Push-ID': session.pushId }
      }, 'gemini');
      this.updateCookies(upload);
      const reference = (await readBounded(upload, 8192)).trim();
      if (!reference || /[\s<>]/.test(reference) || !reference.startsWith('/contrib_service/')) throw new AssistantError('image', 'Gemini image upload failed. Try again');
      fileData = [[[reference], name]];
    }
    const payload: unknown[] = Array.from({ length: 81 }, () => null);
    payload[0] = [`${system}\n\nQuestion:\n${question}`, 0, null, fileData, null, null, 0];
    payload[1] = ['en']; payload[2] = ['', '', '', null, null, null, null, null, null, ''];
    payload[6] = [1]; payload[7] = 1; payload[10] = 1; payload[11] = 0;
    payload[17] = [[0]]; payload[18] = 0; payload[27] = 1; payload[30] = [4];
    payload[41] = [1]; payload[45] = 1; payload[53] = 0; payload[59] = randomUUID().toUpperCase(); payload[61] = []; payload[68] = 1; payload[80] = 1;
    const params = new URLSearchParams({ hl: 'en', rt: 'c', _reqid: String(this.requestId += 100000) });
    if (session.build) params.set('bl', session.build);
    if (session.id) params.set('f.sid', session.id);
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
export function createProvider(name: Config['provider'], secret: string, transport?: Transport): AIProvider {
  return name === 'groq' ? new GroqProvider(secret, transport) : new GeminiWebProvider(secret, transport);
}
