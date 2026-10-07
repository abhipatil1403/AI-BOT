import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { HOST, PORT } from '../../packages/protocol';
import type { Controller } from './controller';
import { copyRequestSchema, hideBrowserOverlay } from '../../packages/schemas';

export function startBridge(controller: Controller, token: () => string, openSettings: () => void, port = PORT, copyCode?: (code: string) => Promise<void>): Promise<Server> {
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (host !== `${HOST}:${port}` || (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))) { res.writeHead(403).end(); return; }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const expected = Buffer.from(`Bearer ${token()}`);
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(401).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/v1/state') {
      const state = controller.state;
      const hidden = hideBrowserOverlay(state.config);
      res.end(JSON.stringify(hidden ? { ...state, phase: 'idle', answer: undefined, error: undefined } : state));
    } else if (req.method === 'POST' && req.url === '/v1/trigger') {
      void controller.trigger(); res.writeHead(202).end('{}');
    } else if (req.method === 'POST' && req.url === '/v1/settings') {
      openSettings(); res.end('{}');
    } else if (req.method === 'POST' && req.url === '/v1/dismiss') {
      try {
        let body = '';
        for await (const chunk of req) { body += String(chunk); if (body.length > 128) { res.writeHead(413).end('{}'); return; } }
        const parsed = copyRequestSchema.safeParse(JSON.parse(body));
        if (!parsed.success) { res.writeHead(400).end('{}'); return; }
        if (!controller.dismiss(parsed.data.requestId)) { res.writeHead(409).end('{}'); return; }
        res.end('{}');
      } catch { res.writeHead(400).end('{}'); }
    } else if (req.method === 'POST' && req.url === '/v1/copy') {
      if (!copyCode) { res.writeHead(405).end('{}'); return; }
      try {
        let body = '';
        for await (const chunk of req) {
          body += String(chunk);
          if (body.length > 128) { res.writeHead(413).end('{}'); return; }
        }
        const parsed = copyRequestSchema.safeParse(JSON.parse(body));
        if (!parsed.success) { res.writeHead(400).end('{}'); return; }
        const state = controller.state;
        if (state.requestId !== parsed.data.requestId || state.phase !== 'ready' || state.answer?.type !== 'code') { res.writeHead(409).end('{}'); return; }
        // Only validated, current model code can be copied. Clients send an ID,
        // never arbitrary clipboard text. Electron preserves the raw snippet.
        await copyCode(state.answer.code); res.end('{}');
      } catch { res.writeHead(400).end('{}'); }
    } else { res.writeHead(404).end('{}'); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 20;
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, HOST, () => { server.removeListener('error', reject); resolve(server); }); });
}
