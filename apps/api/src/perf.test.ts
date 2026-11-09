/**
 * Mede quantas consultas ao banco cada etapa do checkout faz (cada uma = ida e volta ao Supabase).
 * Rode com: PERF=1 npx vitest run src/perf.test.ts
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { beforeAll, describe, it, vi } from 'vitest';
import { createFakeClient, db, queryLog } from './test/fakeSupabase.js';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => createFakeClient() }));
const RUN = !!process.env.PERF;
let base = '';
const charges = new Map<string, any>();
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : null;
    const json = (s: number, v: unknown) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
    if (req.url === '/woovi/api/v1/charge') return charges.set(body.correlationID, body), json(200, { charge: { correlationID: body.correlationID, brCode: '000201PIX', expiresDate: new Date(Date.now() + 7200e3).toISOString() } });
    json(200, {});
  });
});
beforeAll(async () => {
  if (!RUN) return;
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const ext = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  Object.assign(process.env, { NODE_ENV: 'test', PUBLIC_URL: 'https://checkout.loja.com', SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key-test-key-test-key', WOOVI_API_URL: `${ext}/woovi`, JOBS_ENABLED: 'false' });
  const now = new Date().toISOString();
  const OWN = '0a000000-0000-4000-8000-000000000001';
  db.organizations = [{ id: OWN, name: 'Prime', status: 'active', is_platform_owner: true, split_enabled: true, recipient: {}, created_at: now }];
  db.settings = [{ key: 'gateways', value: { woovi: { appId: 'APP' } } }, { key: 'general', value: { store: { name: 'Loja' } } }];
  db.products = [{ id: '00000000-0000-4000-8000-000000000001', org_id: OWN, number: 1001, name: 'Pack', price_cents: 1999, active: true, delivery_type: 'link', delivery_url: 'https://x', created_at: now }];
  db.checkouts = [{ id: '00000000-0000-4000-8000-0000000000c1', org_id: OWN, product_id: '00000000-0000-4000-8000-000000000001', slug: '8931442', name: 'C', active: true, provider: 'woovi', theme: { bannerUrl: 'https://img/b.webp' }, fields: { phone: true }, tracking: {}, created_at: now }];
  db.order_bumps = [];
  db.checkout_bumps = [];
  db.fee_policies = [];
  const { createApp } = await import('./app.js');
  await (await import('./services/gateways.js')).refreshGateways(true);
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

describe.skipIf(!RUN)('consultas ao banco por etapa', () => {
  it('mede', async () => {
    const step = async (label: string, fn: () => Promise<unknown>, clear = true) => {
      if (clear) (await import('./services/orders.js')).clearCheckoutCache();
      queryLog.length = 0;
      const t = Date.now();
      await fn();
      process.stderr.write(`\n${label.padEnd(46)} ${String(queryLog.length).padStart(2)} consultas  [${queryLog.join(', ')}]  ${Date.now() - t}ms`);
    };
    const j = (path: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.text());
    await step('HTML do checkout (cache frio)', () => j('/checkout?produto_id=8931442'));
    await step('HTML do checkout (cache quente)', () => j('/checkout?produto_id=8931442'), false);
    await step('API dados do checkout (cache quente)', () => j('/api/public/checkouts/8931442'), false);
    await step('API dados do checkout (cache frio)', () => j('/api/public/checkouts/8931442'));
    await step('Cotação (bump/cupom)', () => j('/api/public/checkouts/8931442/quote', 'POST', { bump_ids: [] }), false);
    let token = '';
    await step('Finalizar compra (gerar Pix)', async () => (token = JSON.parse(await j('/api/public/orders', 'POST', { checkout_slug: '8931442', customer: { name: 'Ana Souza', email: 'ana@x.com', phone: '11999998888' }, bump_ids: [], tracking: {} })).token), false);
    await new Promise((r) => setTimeout(r, 300));
    await step('Página do Pix (cada consulta de status)', () => j(`/api/public/orders/${token}`), false);
    await step('Evento page_view', () => j('/api/public/events', 'POST', { checkout_slug: '8931442', type: 'page_view' }), false);
  });
});
