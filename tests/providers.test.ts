import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { createProvider, geminiTransport, GeminiWebProvider, GROQ_MODEL, GroqProvider, parseGeminiResponse, readBounded, readGeminiAnswer, request } from '../packages/providers';
const signal = () => new AbortController().signal;
const output = JSON.stringify({ type: 'descriptive', answer: 'Paris' });
const geminiFrame = (text: string) => JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [['rcid', [text]]]])]]);
describe('Groq adapter', () => {
  it('uses authenticated HTTPS and JSON mode', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'stop' }] })));
    await expect(new GroqProvider('synthetic-test-key', transport).generate('system', 'question', signal())).resolves.toBe(output);
    const call = transport.mock.calls[0]!; expect(call[0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    const init = call[1]!; expect((init.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-test-key');
    const body = JSON.parse(String(init.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.model).toBe('openai/gpt-oss-120b'); expect(body.reasoning_effort).toBe('low');
  });
  it('validates authentication and the current model without sending clipboard content', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: GROQ_MODEL }] })));
    await new GroqProvider('synthetic-test-key', transport).validate(signal());
    expect(transport.mock.calls[0]?.[0]).toContain('/models');
    expect(transport.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
  it('does not validate an account that only exposes a retired model', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"data":[{"id":"llama-3.3-70b-versatile"}]}'));
    await expect(new GroqProvider('synthetic-test-key', transport).validate(signal())).rejects.toThrow('unavailable for this account');
  });
  it('rejects invalid model-list responses', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    await expect(new GroqProvider('synthetic-test-key', transport).validate(signal())).rejects.toThrow('invalid model list');
  });
  it('handles invalid keys and truncated answers', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(new GroqProvider('synthetic-test-key', transport).validate(signal())).rejects.toThrow('key is invalid');
    transport.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'length' }] })));
    await expect(new GroqProvider('synthetic-test-key', transport).generate('s', 'q', signal())).rejects.toThrow('incomplete');
  });
});
describe('Gemini web adapter', () => {
  it('returns a completed answer without waiting for the HTTP stream to close', async () => {
    const candidate: unknown[] = ['rcid', [output]]; candidate[8] = [2];
    const frame = JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [candidate]])]]) + '\n';
    const cancel = vi.fn(); const data = new TextEncoder().encode(frame);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data.slice(0, 19)); controller.enqueue(data.slice(19)); }, cancel });
    await expect(readGeminiAnswer(new Response(body), signal())).resolves.toBe(output);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('waits for completion rather than returning a partial but valid JSON answer', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const candidate: unknown[] = ['rcid', [output]]; candidate[8] = [1];
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify([['wrb.fr', null, JSON.stringify(value)]]) + '\n');
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(encode([null, null, null, null, [candidate]])); } });
    const resolved = vi.fn(); const reading = readGeminiAnswer(new Response(body), signal()).then(value => { resolved(); return value; });
    await new Promise(resolve => setTimeout(resolve, 10)); expect(resolved).not.toHaveBeenCalled();
    const final: unknown[] = []; final[25] = 'synthetic-final-context'; controller.enqueue(encode(final));
    await new Promise(resolve => setTimeout(resolve, 10)); expect(resolved).not.toHaveBeenCalled();
    candidate[8] = [2]; controller.enqueue(encode([null, null, null, null, [candidate]]));
    await expect(reading).resolves.toBe(output);
  });
  it('rejects truncated partial streams and bounds streamed bytes', async () => {
    const candidate: unknown[] = ['rcid', [output]]; candidate[8] = [1];
    await expect(readGeminiAnswer(new Response(JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [candidate]])]])), signal())).rejects.toThrow('incomplete');
    await expect(readGeminiAnswer(new Response('x'.repeat(2_000_001)), signal())).rejects.toThrow('too large');
  });
  it('maps a body timeout to the safe timeout message instead of a generic connection error', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new DOMException('DO_NOT_LEAK_PROVIDER_DATA', 'TimeoutError')); } });
    await expect(readGeminiAnswer(new Response(body), signal())).rejects.toThrow('AI request timed out or was cancelled');
  });
  it('still reports rate limits encountered inside a streamed response', async () => {
    const part: unknown[] = ['wrb.fr']; part[5] = [null, null, [[null, [1037]]]];
    await expect(readGeminiAnswer(new Response(JSON.stringify([part]) + '\n'), signal())).rejects.toThrow('Rate limit');
  });
  it('uses supplied Cookie header values for session validation', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('"SNlM0e":"synthetic-token"'));
    await new GeminiWebProvider('Cookie: __Secure-1PSID=synthetic-cookie==; SSID=synthetic-ssid', transport).validate(signal());
    expect((transport.mock.calls[0]?.[1]?.headers as Record<string, string>).Cookie).toBe('__Secure-1PSID=synthetic-cookie==; SSID=synthetic-ssid');
  });
  it('initializes supplied session, reuses it, and submits temporary requests', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('"SNlM0e":"token","cfb2h":"build","FdrFJe":"session"'))
      .mockResolvedValueOnce(new Response(`)]}'\n123\n${geminiFrame(output)}\n`))
      .mockResolvedValueOnce(new Response(geminiFrame(output)));
    const provider = new GeminiWebProvider('{"__Secure-1PSID":"synthetic-test-cookie"}', transport);
    expect(await provider.generate('system', 'question', signal())).toBe(output);
    expect(await provider.generate('system', 'next', signal())).toBe(output);
    expect(transport).toHaveBeenCalledTimes(3);
    const init = transport.mock.calls[1]![1]!;
    expect((init.headers as Record<string, string>).Cookie).toContain('synthetic-test-cookie');
    const body = new URLSearchParams(String(init.body)); const outer = JSON.parse(body.get('f.req')!); const inner = JSON.parse(outer[1]);
    expect(inner[45]).toBe(1); expect(inner[0][0]).toContain('question');
  });
  it('rejects expired sessions and does not follow redirects with cookies', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('login'));
    await expect(new GeminiWebProvider('{"__Secure-1PSID":"synthetic-test-cookie"}', transport).validate(signal())).rejects.toThrow('session expired');
    transport.mockResolvedValue(new Response('', { status: 302, headers: { location: 'https://evil.test' } }));
    await expect(new GeminiWebProvider('{"__Secure-1PSID":"synthetic-test-cookie"}', transport).validate(signal())).rejects.toThrow('session expired');
    expect(transport.mock.calls.at(-1)?.[1]?.redirect).toBe('manual');
  });
  it('parses multiple frames and rejects unsupported output', () => {
    expect(parseGeminiResponse(`${geminiFrame('first')}\n321\n${geminiFrame('last')}`)).toBe('last');
    expect(() => parseGeminiResponse('invalid')).toThrow('invalid response');
  });
  it('switches providers explicitly', () => { expect(createProvider('groq', 'test')).toBeInstanceOf(GroqProvider); expect(createProvider('gemini', '{"__Secure-1PSID":"synthetic-test-cookie"}')).toBeInstanceOf(GeminiWebProvider); });
});
describe('bounded HTTP transport', () => {
  it('clears the 30-second header timer after headers arrive while retaining the caller deadline', async () => {
    vi.useFakeTimers();
    try {
      const parent = new AbortController(); let bodySignal: AbortSignal | undefined;
      const transport = vi.fn<typeof fetch>(async (_url, init) => { bodySignal = init?.signal as AbortSignal; return new Response('answer'); });
      await request(transport, 'https://gemini.google.com/app', { signal: parent.signal }, 'gemini');
      await vi.advanceTimersByTimeAsync(31000); expect(bodySignal?.aborted).toBe(false);
      parent.abort(); expect(bodySignal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('still times out a connection that never returns headers', async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
      const result = expect(request(transport, 'https://gemini.google.com/app', { signal: signal() }, 'gemini')).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(30000); await result;
    } finally { vi.useRealTimers(); }
  });
  it('accepts Google-sized response headers while retaining a finite header limit', async () => {
    const server = createServer((req, res) => {
      res.setHeader('Set-Cookie', Array.from({ length: req.url === '/oversized' ? 80 : 24 }, (_, i) => 'synthetic' + i + '=' + 'x'.repeat(1024) + '; Secure; HttpOnly'));
      res.end('"SNlM0e":"synthetic-token"');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const base = 'http://127.0.0.1:' + address.port;
      const response = await request(geminiTransport, base, {}, 'gemini');
      expect(response.headers.getSetCookie()).toHaveLength(24);
      expect(await readBounded(response)).toContain('synthetic-token');
      await expect(request(geminiTransport, base + '/oversized', {}, 'gemini')).rejects.toThrow('headers exceeded');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('reports header overflow without exposing native error details or retrying it', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('DO_NOT_LEAK_COOKIE', { cause: { code: 'UND_ERR_HEADERS_OVERFLOW', message: 'DO_NOT_LEAK_COOKIE' } }));
    const error = await request(transport, 'https://gemini.google.com/app', {}, 'gemini').catch(error => error as Error);
    expect((error as Error).message).toContain('headers exceeded');
    expect((error as Error).message).not.toContain('DO_NOT_LEAK_COOKIE');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    [400, 'model_decommissioned', 'model unavailable'],
    [404, 'model_not_found', 'model unavailable'],
    [400, 'json_validate_failed', 'valid JSON'],
    [403, 'model_permission_blocked_project', 'permissions'],
    [413, 'request_too_large', 'shorter question'],
    [402, 'insufficient_quota', 'quota limit']
  ])('maps HTTP %s / %s to a safe useful error', async (status, code, message) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code, message: 'DO_NOT_LEAK_USER_CONTENT', failed_generation: 'DO_NOT_LEAK_USER_CONTENT' } }), { status }));
    await expect(request(transport, 'https://api.groq.com', {}, 'groq')).rejects.toThrow(message);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('includes the status without exposing an unknown provider error body', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":{"code":"unknown","message":"DO_NOT_LEAK_USER_CONTENT"}}', { status: 400 }));
    const error = await request(transport, 'https://api.groq.com', {}, 'groq').catch(error => error as Error);
    expect((error as Error).message).toContain('HTTP 400'); expect((error as Error).message).not.toContain('DO_NOT_LEAK_USER_CONTENT');
  });
  it('retries transient failures once', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('socket')).mockResolvedValue(new Response('{}'));
    await expect(request(transport, 'https://api.groq.com', { signal: signal() }, 'groq')).resolves.toBeInstanceOf(Response); expect(transport).toHaveBeenCalledTimes(2);
  });
  it('respects long rate-limit delays without retry loops', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    await expect(request(transport, 'https://api.groq.com', {}, 'groq')).rejects.toThrow('Rate limit'); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('retries server errors once then gives a useful error', async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 503, headers: { 'retry-after': '0' } }));
    await expect(request(transport, 'https://api.groq.com', {}, 'groq')).rejects.toThrow('unavailable'); expect(transport).toHaveBeenCalledTimes(2);
  });
  it('handles cancellation and bounds response bodies', async () => {
    const abort = new AbortController(); abort.abort(); const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error('abort'));
    await expect(request(transport, 'https://api.groq.com', { signal: abort.signal }, 'groq')).rejects.toThrow('timed out');
    await expect(readBounded(new Response('123456789'), 4)).rejects.toThrow('too large');
  });
});
