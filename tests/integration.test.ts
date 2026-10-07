import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Controller } from '../apps/desktop/controller';
import { startBridge } from '../apps/desktop/bridge';
import { Storage, type Cipher } from '../apps/desktop/storage';
import { defaultConfig } from '../packages/schemas';
import type { AIProvider } from '../packages/core';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port unavailable');
  const port = address.port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
describe('desktop bridge and clipboard requests', () => {
  it('authenticates requests, rejects websites, serves shared state and reads only desktop clipboard', async () => {
    const clipboard = vi.fn(() => 'Capital of France?');
    const generate = vi.fn().mockResolvedValue('{"type":"descriptive","answer":"Paris"}');
    const controller = new Controller(defaultConfig, clipboard, () => ({ generate, validate: vi.fn() }), vi.fn());
    const token = randomBytes(32).toString('hex'); const port = await freePort();
    servers.push(await startBridge(controller, () => token, vi.fn(), port));
    const base = `http://127.0.0.1:${port}`; const headers = { Authorization: `Bearer ${token}` };
    expect((await fetch(`${base}/v1/state`)).status).toBe(401);
    expect((await fetch(`${base}/v1/state`, { headers: { ...headers, Origin: 'https://evil.test' } })).status).toBe(403);
    expect((await fetch(`${base}/v1/trigger`, { method: 'POST', headers })).status).toBe(202);
    await vi.waitFor(() => expect(controller.state.phase).toBe('ready'));
    const response = await fetch(`${base}/v1/state`, { headers: { ...headers, Origin: `chrome-extension://${'a'.repeat(32)}` } });
    const state = await response.json(); expect(state.answer.answer).toBe('Paris'); expect(clipboard).toHaveBeenCalledTimes(1); expect(generate.mock.calls[0]?.[1]).toBe('Capital of France?');
    expect(JSON.stringify(state)).not.toContain(token);
  });
  it('hides responses while user sharing mode is active', async () => {
    const config = { ...defaultConfig, visibility: 'sharing' as const, sharing: true };
    const controller = new Controller(config, () => 'Question?', () => ({ generate: async () => '{"type":"descriptive","answer":"private"}', validate: async () => {} }), vi.fn());
    await controller.trigger(); const port = await freePort(); servers.push(await startBridge(controller, () => 'token', vi.fn(), port));
    const res = await fetch(`http://127.0.0.1:${port}/v1/state`, { headers: { Authorization: 'Bearer token' } });
    expect(await res.json()).not.toHaveProperty('answer');
  });
  it.each([true, false])('keeps the desktop answer while protecting the browser when capture exclusion is %s', async captureProtection => {
    const config = { ...defaultConfig, visibility: 'always' as const, sharing: true, captureProtection };
    const controller = new Controller(config, () => 'Question?', () => ({ generate: async () => '{"type":"descriptive","answer":"local answer"}', validate: async () => {} }), vi.fn());
    await controller.trigger();
    const port = await freePort(); servers.push(await startBridge(controller, () => 'token', vi.fn(), port));
    const response = await fetch('http://127.0.0.1:' + port + '/v1/state', { headers: { Authorization: 'Bearer token' } });
    const state = await response.json();
    expect(controller.state.answer).toEqual({ type: 'descriptive', answer: 'local answer' });
    expect(state.answer).toEqual(captureProtection ? undefined : controller.state.answer);
    expect(state.phase).toBe(captureProtection ? 'idle' : 'ready');
  });
  it('copies only the current validated code and rejects arbitrary or stale payloads', async () => {
    const code = 'def add(a, b):\n    return a + b\n'; const copy = vi.fn().mockResolvedValue(undefined);
    const controller = new Controller(defaultConfig, () => 'Write a program to add two numbers', () => ({ generate: async () => JSON.stringify({ type: 'code', language: 'python', code }), validate: async () => {} }), vi.fn());
    await controller.trigger(); const port = await freePort(); servers.push(await startBridge(controller, () => 'token', vi.fn(), port, copy));
    const endpoint = `http://127.0.0.1:${port}/v1/copy`; const headers = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };
    expect((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ requestId: controller.state.requestId, text: 'untrusted' }) })).status).toBe(400);
    expect(copy).not.toHaveBeenCalled();
    expect((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ requestId: controller.state.requestId }) })).status).toBe(200); expect(copy).toHaveBeenCalledExactlyOnceWith(code);
    controller.configure(defaultConfig);
    expect((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ requestId: 1 }) })).status).toBe(409); expect(copy).toHaveBeenCalledTimes(1);
  });
  it('ignores empty clipboard and debounces duplicate triggers', async () => {
    const generate = vi.fn(); const clipboard = vi.fn(() => '  ');
    const controller = new Controller(defaultConfig, clipboard, () => ({ generate, validate: vi.fn() }), vi.fn());
    await controller.trigger(); expect(controller.state.phase).toBe('idle'); expect(generate).not.toHaveBeenCalled();
    await controller.trigger(); expect(clipboard).toHaveBeenCalledTimes(1);
  });
  it('cancels old requests and does not reveal stale responses after switching providers', async () => {
    let resolve: (value: string) => void = () => {};
    const provider: AIProvider = { generate: () => new Promise<string>(r => { resolve = r; }), validate: vi.fn() };
    const controller = new Controller(defaultConfig, () => 'Question?', () => provider, vi.fn());
    const pending = controller.trigger(); await vi.waitFor(() => expect(controller.state.phase).toBe('processing')); controller.configure({ ...defaultConfig, provider: 'gemini' });
    resolve('{"type":"descriptive","answer":"stale"}'); await pending;
    expect(controller.state.phase).toBe('idle'); expect(controller.state.config.provider).toBe('gemini'); expect(controller.state.answer).toBeUndefined();
  });
  it('contains provider errors without exposing stack traces', async () => {
    const controller = new Controller(defaultConfig, () => 'Question?', () => { throw new Error('sensitive-internal-details'); }, vi.fn());
    await controller.trigger(); expect(controller.state.error).toBe('AI connection failed'); expect(JSON.stringify(controller.state)).not.toContain('sensitive');
  });
  it('discards an async clipboard read invalidated by a settings change', async () => {
    let resolveClipboard: (value: string) => void = () => {};
    const generate = vi.fn();
    const controller = new Controller(defaultConfig, () => new Promise<string>(resolve => { resolveClipboard = resolve; }), () => ({ generate, validate: vi.fn() }), vi.fn());
    const request = controller.trigger(); controller.configure({ ...defaultConfig, provider: 'gemini' });
    resolveClipboard('Question?'); await request;
    expect(generate).not.toHaveBeenCalled(); expect(controller.state.phase).toBe('idle');
  });
});
describe('credential storage', () => {
  // Unit seam for the OS cipher; the smoke suite separately exercises real DPAPI.
  const cipher: Cipher = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text.split('').reverse().join('')), decryptString: buffer => buffer.toString().split('').reverse().join('') };
  it('stores only encrypted secrets and supports removal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-assistant-vault-'));
    try {
      const storage = new Storage(directory, cipher); storage.setSecret('groq', 'synthetic-test-key');
      expect(readFileSync(join(directory, 'vault.json'), 'utf8')).not.toContain('synthetic-test-key');
      expect(storage.getSecret('groq')).toBe('synthetic-test-key'); expect(storage.hasSecret('groq')).toBe(true);
      storage.saveConfig(defaultConfig); expect(storage.loadConfig()).toEqual(defaultConfig);
      storage.removeSecret('groq'); expect(storage.getSecret('groq')).toBeUndefined();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('fails closed when OS secure storage is unavailable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-assistant-vault-'));
    try { const storage = new Storage(directory, { ...cipher, isEncryptionAvailable: () => false }); expect(() => storage.setSecret('groq', 'test')).toThrow('unavailable'); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
