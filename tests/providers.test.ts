import { describe, it, expect, vi } from 'vitest';
import { createProvider, GeminiWebProvider, GroqProvider, parseGeminiResponse, readBounded, request } from '../packages/providers';
const signal = () => new AbortController().signal;
const output = JSON.stringify({ type: 'descriptive', answer: 'Paris' });
const geminiFrame = (text: string) => JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [['rcid', [text]]]])]]);
describe('Groq adapter', () => {
  it('uses authenticated HTTPS and JSON mode', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'stop' }] })));
    await expect(new GroqProvider('synthetic-test-key', transport).generate('system', 'question', signal())).resolves.toBe(output);
    const call = transport.mock.calls[0]!; expect(call[0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    const init = call[1]!; expect((init.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-test-key');
    expect(JSON.parse(String(init.body)).response_format).toEqual({ type: 'json_object' });
  });
  it('validates without sending clipboard content', async () => { const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}')); await new GroqProvider('synthetic-test-key', transport).validate(signal()); expect(transport.mock.calls[0]?.[0]).toContain('/models'); });
  it('handles invalid keys and truncated answers', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(new GroqProvider('synthetic-test-key', transport).validate(signal())).rejects.toThrow('key is invalid');
    transport.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'length' }] })));
    await expect(new GroqProvider('synthetic-test-key', transport).generate('s', 'q', signal())).rejects.toThrow('incomplete');
  });
});
describe('Gemini web adapter', () => {
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
