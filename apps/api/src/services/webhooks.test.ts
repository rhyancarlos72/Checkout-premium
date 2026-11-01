import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
process.env.PUBLIC_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-test-key-test-key';
process.env.NODE_ENV = 'test';
const { testWebhook } = await import('./paytracking.js');

let received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let status = 200;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ headers: req.headers, body });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { ok: true, signature: 'valid' } : { error: 'unauthorized', reason: 'invalid_token' }));
  });
});
let url = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as any).port}/api/webhook.php`;
});
afterAll(() => server.close());

describe('webhook de saída (formato PayTracking)', () => {
  it('envia Bearer token e assinatura HMAC verificável', async () => {
    received = [];
    status = 200;
    const r = await testWebhook({ url, token: 'tok_123', secret: 's3cr3t' });
    expect(r.ok).toBe(true);
    const [req] = received;
    expect(req.headers.authorization).toBe('Bearer tok_123');
    const ts = String(req.headers['x-paytrack-timestamp']);
    const expected = 'sha256=' + crypto.createHmac('sha256', 's3cr3t').update(`${ts}.${req.body}`).digest('hex');
    expect(req.headers['x-paytrack-signature']).toBe(expected);
    expect(JSON.parse(req.body)).toMatchObject({ event: 'connection_test' });
    expect(req.headers['x-paytrack-test']).toBe('1');
  });
  it('sem segredo não envia assinatura', async () => {
    received = [];
    await testWebhook({ url, token: 'tok', secret: '' });
    expect(received[0].headers['x-paytrack-signature']).toBeUndefined();
  });
  it('explica token inválido (401)', async () => {
    status = 401;
    const r = await testWebhook({ url, token: 'errado', secret: '' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Token inválido/);
  });
});
