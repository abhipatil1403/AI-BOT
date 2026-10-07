import { describe, expect, it, vi } from 'vitest';
import { answerQuestion, MAX_IMAGE_BYTES, sanitizeQuestion, type QuestionImage } from '../packages/core';
import { defaultConfig } from '../packages/schemas';
import { Controller } from '../apps/desktop/controller';
import { GeminiWebProvider, GROQ_VISION_MODEL, GroqProvider } from '../packages/providers';

const image: QuestionImage = { mimeType: 'image/png', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]) };
const signal = () => new AbortController().signal;
describe('image question pipeline', () => {
  it.each([
    { type: 'mcq', answer: 'B', explanation: 'reason' },
    { type: 'descriptive', answer: 'Four' },
    { type: 'code', language: 'python', code: 'print(4)\n' }
  ])('auto detects $type from a vision response and retains preferences', async answer => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify(answer));
    const result = await answerQuestion({ image }, defaultConfig, { generate, validate: vi.fn() }, signal());
    expect(result.type).toBe(answer.type);
    expect(result).not.toHaveProperty('explanation');
    expect(generate.mock.calls[0]?.[3]).toBe(image);
    expect(generate.mock.calls[0]?.[0]).toContain('including coding MCQs');
  });
  it('format retries with the same image and rejects incorrect code language', async () => {
    const generate = vi.fn().mockResolvedValueOnce('{"type":"code","language":"java","code":"x"}').mockResolvedValueOnce('{"type":"code","language":"python","code":"print(4)"}');
    await answerQuestion({ image, text: ' Solve this\r\nplease ' }, defaultConfig, { generate, validate: vi.fn() }, signal());
    expect(generate).toHaveBeenCalledTimes(2); expect(generate.mock.calls[1]?.[3]).toBe(image);
    expect(generate.mock.calls[0]?.[1]).toBe('Solve this\nplease'); expect(generate.mock.calls[1]?.[0]).toContain('CRITICAL');
  });
  it('rejects invalid, empty, mismatched and oversized input before sending', () => {
    expect(() => sanitizeQuestion({ image: { ...image, data: new Uint8Array() } })).toThrow('empty');
    expect(() => sanitizeQuestion({ image: { ...image, mimeType: 'image/jpeg' } })).toThrow('valid PNG or JPEG');
    expect(() => sanitizeQuestion({ image: { ...image, data: new Uint8Array(MAX_IMAGE_BYTES + 1) } })).toThrow('too large');
    expect(() => sanitizeQuestion({ image, text: 'x'.repeat(20001) })).toThrow('too long');
  });
  it('publishes processing and ready without leaking image bytes into shared state', async () => {
    const publish = vi.fn(); const generate = vi.fn().mockResolvedValue('{"type":"mcq","answer":"B"}');
    const controller = new Controller(defaultConfig, () => ({ image }), () => ({ generate, validate: vi.fn() }), publish);
    await controller.trigger();
    expect(publish.mock.calls.map(call => call[0].phase)).toEqual(['processing', 'ready']);
    expect(controller.state.answer).toEqual({ type: 'mcq', answer: 'B' });
    expect(controller.state).not.toHaveProperty('image'); expect(JSON.stringify(controller.state)).not.toContain('mimeType');
  });
});
describe('vision providers', () => {
  const output = '{"type":"descriptive","answer":"Four"}';
  it('uses the supported Groq vision model with an inline image and JSON mode', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: output } }] })));
    expect(await new GroqProvider('synthetic-key', transport).generate('system', 'Solve', signal(), image)).toBe(output);
    const body = JSON.parse(String(transport.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe(GROQ_VISION_MODEL); expect(body.reasoning_effort).toBe('none');
    expect(body.messages[1].content).toEqual([{ type: 'text', text: 'Solve' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + Buffer.from(image.data).toString('base64') } }]);
    expect(body.response_format.type).toBe('json_object');
  });
  it('uploads Gemini images with the session push ID and attaches the returned reference', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('"SNlM0e":"synthetic-token","qKIAYe":"synthetic-push"'))
      .mockResolvedValueOnce(new Response('/contrib_service/synthetic-image'))
      .mockResolvedValueOnce(new Response(JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [['rcid', [output]]]])]])));
    expect(await new GeminiWebProvider('__Secure-1PSID=synthetic-cookie', transport).generate('system', 'Solve', signal(), image)).toBe(output);
    const upload = transport.mock.calls[1]!;
    expect(upload[0]).toBe('https://content-push.googleapis.com/upload');
    expect((upload[1]?.headers as Record<string, string>)['Push-ID']).toBe('synthetic-push');
    const file = (upload[1]?.body as FormData).get('file') as File;
    expect(file.name).toBe('question.png'); expect(file.type).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(image.data);
    const form = new URLSearchParams(String(transport.mock.calls[2]?.[1]?.body));
    const payload = JSON.parse(JSON.parse(form.get('f.req')!)[1]);
    expect(payload[0][3]).toEqual([[['/contrib_service/synthetic-image'], 'question.png']]); expect(payload[45]).toBe(1);
  });
  it('rejects invalid Gemini upload responses without echoing server content', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('"SNlM0e":"token"')).mockResolvedValueOnce(new Response('<html>PRIVATE_PROVIDER_DATA</html>'));
    await expect(new GeminiWebProvider('__Secure-1PSID=synthetic-cookie', transport).generate('s', 'q', signal(), image)).rejects.toThrow('image upload failed');
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
