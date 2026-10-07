import { describe, expect, it, vi } from 'vitest';
import { answerQuestion, classify, HotkeyGate, parseAnswer, promptFor, sanitizeInput, type AIProvider } from '../packages/core';
import { configSchema, defaultConfig, parseCookies } from '../packages/schemas';

describe('clipboard pipeline', () => {
  it('normalizes line endings and removes control characters', () => { expect(sanitizeInput('  A\r\nB\u0000 ')).toBe('A\nB'); });
  it('rejects empty and oversized text', () => { expect(() => sanitizeInput('  ')).toThrow('No text'); expect(() => sanitizeInput('x'.repeat(20001))).toThrow('too long'); });
  it.each([
    ['Capital of France?\nA. Berlin\nB. Paris\nC. Rome', 'mcq'],
    ['Which is true?\n1) first\n2) second', 'mcq'],
    ['Write a Python program to reverse a string', 'code'],
    ['Implement a function to add two numbers', 'code'],
    ['Write a program to add numbers.\n1. Read the inputs\n2. Print the sum', 'code'],
    ['What is photosynthesis?', 'descriptive'],
    ['Explain what a code of conduct means', 'descriptive']
  ])('classifies %s', (text, type) => expect(classify(text)).toBe(type));
  it('gives MCQ precedence over code questions', () => expect(classify('What will this program print?\nA. 1\nB. 2')).toBe('mcq'));
  it('does not misclassify duplicate option labels', () => expect(classify('A. Introduction\nA. Summary')).toBe('descriptive'));
});
describe('response validation and prompting', () => {
  it('accepts a valid response and removes unwanted explanations', () => expect(parseAnswer('{"type":"mcq","answer":"B","text":"Paris","explanation":"France"}', 'mcq', defaultConfig, 'A. Rome\nB. Paris')).toEqual({ type: 'mcq', answer: 'B', text: 'Paris' }));
  it('rejects nonexistent labels, wrong types and wrong languages', () => {
    expect(() => parseAnswer('{"type":"mcq","answer":"D"}', 'mcq', defaultConfig, 'A. Rome\nB. Paris')).toThrow('invalid option');
    expect(() => parseAnswer('{"type":"descriptive","answer":"text"}', 'code', defaultConfig)).toThrow('invalid');
    expect(() => parseAnswer('{"type":"code","language":"java","code":"x"}', 'code', defaultConfig)).toThrow('invalid');
  });
  it('preserves raw code and rejects fenced snippets', () => {
    const code = 'def add(a, b):\n    return a + b\n';
    expect(parseAnswer(JSON.stringify({ type: 'code', language: 'python', code }), 'code', defaultConfig)).toEqual({ type: 'code', language: 'python', code });
    expect(() => parseAnswer(JSON.stringify({ type: 'code', language: 'python', code: '```python\nx\n```' }), 'code', defaultConfig)).toThrow();
  });
  it('does not accept extra model fields or executable markup as an object', () => {
    expect(() => parseAnswer('{"type":"descriptive","answer":"fine","run":"evil"}', 'descriptive', defaultConfig)).toThrow();
    expect(() => parseAnswer('<script>alert(1)</script>', 'descriptive', defaultConfig)).toThrow();
  });
  it('uses configured language, comments and explanation preferences', () => {
    expect(promptFor('code', { ...defaultConfig, language: 'go' })).toContain('Use go');
    expect(promptFor('code', defaultConfig)).toContain('Do not include comments');
    expect(promptFor('mcq', { ...defaultConfig, explanations: true })).toContain('Include a short explanation');
  });
  it('retries invalid model output once with stricter format', async () => {
    const generate = vi.fn().mockResolvedValueOnce('invalid').mockResolvedValueOnce('{"type":"descriptive","answer":"Paris"}');
    const provider: AIProvider = { generate, validate: vi.fn() };
    await expect(answerQuestion('Capital of France?', defaultConfig, provider, new AbortController().signal)).resolves.toEqual({ type: 'descriptive', answer: 'Paris' });
    expect(generate).toHaveBeenCalledTimes(2); expect(generate.mock.calls[1]?.[0]).toContain('CRITICAL');
  });
  it('stops after two invalid outputs', async () => {
    const generate = vi.fn().mockResolvedValue('invalid');
    await expect(answerQuestion('Question?', defaultConfig, { generate, validate: vi.fn() }, new AbortController().signal)).rejects.toThrow('invalid response');
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
describe('cookie and settings safety', () => {
  it('accepts only explicitly supplied JSON objects and arrays', () => {
    expect(parseCookies('{"__Secure-1PSID":"synthetic-test-cookie"}')).toHaveProperty('__Secure-1PSID');
    expect(parseCookies('[{"name":"__Secure-1PSID","value":"synthetic-test-cookie","domain":".google.com"}]')).toHaveProperty('__Secure-1PSID');
  });
  it.each(['not-json', '{}', 'null', '[]', '{"__Secure-1PSID":"x\\r\\nheader"}', '{"bad;name":"value","__Secure-1PSID":"x"}', '[{"name":"__Secure-1PSID","value":"x","domain":"evil.test"}]'])('rejects unsafe cookies %s', value => expect(() => parseCookies(value)).toThrow());
  it('validates shortcuts and excludes unknown settings', () => { expect(configSchema.safeParse({ shortcut: 'Ctrl+Alt+Shift+F12' }).success).toBe(true); expect(configSchema.safeParse({ shortcut: 'V' }).success).toBe(false); expect(configSchema.safeParse({ apiKey: 'secret' }).success).toBe(false); });
});
describe('passive hotkey gate', () => {
  it('triggers once per key press, ignoring repeat', () => { const gate = new HotkeyGate(); expect(gate.down(47, true)).toBe(true); expect(gate.down(47, true)).toBe(false); gate.up(47); expect(gate.down(47, true)).toBe(true); });
  it('does not trigger when modifiers are missing', () => { const gate = new HotkeyGate(); expect(gate.down(47, false)).toBe(false); gate.up(47); expect(gate.down(47, true)).toBe(true); gate.reset(); expect(gate.down(47, true)).toBe(true); });
});
