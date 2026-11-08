/**
 * Checkup de ponta a ponta NO NAVEGADOR (Chromium real): o cliente abre o checkout, erra e corrige
 * os dados, marca o order bump, aplica cupom, gera o Pix, paga (Woovi simulada) e vê o acesso.
 * Banco em memória + Woovi/PayTracking falsos. Rode com: BROWSER_E2E=1 npx vitest run src/browser.e2e.test.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeClient, db } from './test/fakeSupabase.js';

vi.mock('@supabase/supabase-js', () => ({ createClient: () => createFakeClient() }));
const RUN = !!process.env.BROWSER_E2E;

const charges = new Map<string, { status: string; value: number }>();
const pt: string[] = [];
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : null;
    const json = (s: number, v: unknown) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
    if (req.method === 'POST' && req.url === '/woovi/api/v1/charge') {
      charges.set(body.correlationID, { status: 'ACTIVE', value: body.value });
      return json(200, { charge: { correlationID: body.correlationID, brCode: `00020101021226PIX${body.correlationID.slice(0, 8)}5204000053039865802BR6304ABCD`, expiresDate: new Date(Date.now() + body.expiresIn * 1000).toISOString() } });
    }
    if (req.method === 'GET' && req.url!.startsWith('/woovi/api/v1/charge/')) {
      const c = charges.get(decodeURIComponent(req.url!.split('/').pop()!));
      return c ? json(200, { charge: { status: c.status, value: c.value } }) : json(404, {});
    }
    if (req.url === '/paytracking') {
      pt.push(body?.event);
      return json(200, { ok: true });
    }
    json(404, {});
  });
});

let base = '';
let server: http.Server;
let browser: any;
const report: string[] = [];
const ok = (msg: string) => report.push(`✅ ${msg}`);

beforeAll(async () => {
  if (!RUN) return;
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const ext = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  Object.assign(process.env, { NODE_ENV: 'test', PUBLIC_URL: 'http://127.0.0.1', SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key-test-key-test-key', SUPABASE_ANON_KEY: 'anon-key-anon-key-anon-key', WOOVI_API_URL: `${ext}/woovi`, JOBS_ENABLED: 'false' });
  const now = new Date().toISOString();
  db.settings = [
    { key: 'gateways', value: { woovi: { appId: 'APP' }, pixExpiresMinutes: 120 } },
    { key: 'general', value: { store: { name: 'Loja Teste', supportEmail: 'suporte@loja.com', document: '12.345.678/0001-90', pixReceiver: 'Prime Tecnologia' } } },
    { key: 'webhooks', value: { items: [{ id: 'w1', name: 'PayTracking', preset: 'paytracking', url: `${ext}/paytracking`, token: 't', secret: 's', events: ['sale.pending', 'sale.approved'], active: true, created_at: now }] } },
  ];
  db.products = [
    { id: '00000000-0000-4000-8000-000000000001', number: 1001, name: 'Pack Etiquetas Escolares', description: 'Mais de 200 artes editáveis.', price_cents: 1999, active: true, delivery_type: 'link', delivery_url: 'https://drive.google.com/acesso-principal', created_at: now },
    { id: '00000000-0000-4000-8000-000000000002', number: 1002, name: 'Bônus Capas', price_cents: 990, active: true, delivery_type: 'link', delivery_url: 'https://drive.google.com/acesso-bonus', created_at: now },
    { id: '00000000-0000-4000-8000-000000000003', number: 1003, name: 'Kit Convites', price_cents: 2990, active: true, delivery_type: 'link', delivery_url: 'https://drive.google.com/acesso-upsell', created_at: now },
  ];
  db.checkouts = [{ id: '00000000-0000-4000-8000-0000000000c1', product_id: '00000000-0000-4000-8000-000000000001', slug: '8931442', name: 'Checkout', price_cents: 1999, active: true, provider: 'woovi', pix_expires_minutes: 120, theme: { compareAtCents: 4990 }, fields: { phone: true, document: false }, tracking: {}, created_at: now }];
  db.order_bumps = [{ id: '00000000-0000-4000-8000-0000000000b1', product_id: '00000000-0000-4000-8000-000000000002', title: 'Bônus Capas', description: 'Capas prontas.', price_cents: 990, compare_at_cents: 1990, active: true, created_at: now }];
  db.checkout_bumps = [{ checkout_id: '00000000-0000-4000-8000-0000000000c1', bump_id: '00000000-0000-4000-8000-0000000000b1', sort: 0 }];
  db.coupons = [{ id: '00000000-0000-4000-8000-0000000000aa', code: 'DEZ', type: 'percent', value: 10, used_count: 0, min_cents: 0, active: true, created_at: now }];
  db.upsells = [{ id: '00000000-0000-4000-8000-0000000000dd', product_id: '00000000-0000-4000-8000-000000000001', offer_product_id: '00000000-0000-4000-8000-000000000003', title: null, price_cents: 790, compare_at_cents: 2990, active: true, created_at: now }];
  const { createApp } = await import('./app.js');
  const { refreshGateways } = await import('./services/gateways.js');
  await refreshGateways(true);
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { chromium } = createRequire(import.meta.url)('playwright');
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.close();
  fake.close();
  if (report.length) console.log(`\n===== CHECKUP DO CHECKOUT =====\n${report.join('\n')}\n`);
});

const pay = async (orderId: string) => {
  charges.get(orderId)!.status = 'COMPLETED';
  await fetch(`${base}/api/webhooks/woovi`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'OPENPIX:CHARGE_COMPLETED', charge: { correlationID: orderId } }) });
};

describe.skipIf(!RUN)('checkup do checkout no navegador', () => {
  for (const [label, viewport] of [['computador', { width: 1366, height: 900 }], ['celular', { width: 390, height: 844 }]] as const) {
    it(`compra completa no ${label}`, async () => {
      const ctx = await browser.newContext({ viewport, locale: 'pt-BR' });
      const p = await ctx.newPage();
      const errors: string[] = [];
      p.on('pageerror', (e: Error) => errors.push(e.message));
      p.on('console', (m: any) => m.type() === 'error' && !/favicon|fbevents|ERR_/.test(m.text()) && errors.push(m.text()));
      const email = `cliente.${label}@teste.com`;

      // 1) abre o checkout (HTML já traz os dados do produto)
      const t0 = Date.now();
      await p.goto(`${base}/checkout?produto_id=8931442`, { waitUntil: 'load' });
      await p.getByText('Pack Etiquetas Escolares').first().waitFor();
      ok(`[${label}] checkout abriu em ${Date.now() - t0} ms com produto, preço e order bump`);
      expect(await p.getByText('R$ 19,99').count()).toBeGreaterThan(0);
      expect(await p.getByText('Aproveite e leve junto com desconto').count()).toBe(1);
      expect(await p.title()).toContain('Pack Etiquetas Escolares');

      // 2) validação: envia vazio e com dados inválidos
      const submit = p.locator('form#ck-form button[type=submit]').first();
      await submit.click();
      await p.getByText('Informe seu nome completo').first().waitFor();
      await p.fill('input[autocomplete=name]', 'Maria');
      await p.fill('input[type=email]', 'maria@');
      await p.fill('input[inputmode=tel]', '1199');
      await submit.click();
      await p.getByText('Informe nome e sobrenome').waitFor();
      await p.getByText('Digite um e-mail válido').waitFor();
      await p.getByText('Informe o celular com DDD').waitFor();
      ok(`[${label}] campos vazios/inválidos são barrados com mensagem clara`);

      // 3) preenche certo (telefone com +55) e confere a máscara
      await p.fill('input[autocomplete=name]', 'Maria Souza');
      await p.fill('input[type=email]', email);
      await p.fill('input[inputmode=tel]', '');
      await p.locator('input[inputmode=tel]').pressSequentially('+55 11 98888-7777');
      expect(await p.inputValue('input[inputmode=tel]')).toBe('(11) 98888-7777');
      ok(`[${label}] telefone digitado com +55 vira (11) 98888-7777`);

      // 4) order bump + cupom
      await p.getByRole('button', { name: /Sim! Quero levar junto/ }).first().click();
      await p.getByText('Adicionado! Você garantiu esta oferta').waitFor();
      await p.locator('button:visible', { hasText: 'Adicionar cupom de desconto' }).first().click();
      await p.locator('input[placeholder="CÓDIGO"]:visible').first().fill('dez');
      await p.locator('button:visible', { hasText: 'Aplicar' }).first().click();
      await p.locator('text=R$ 26,90 >> visible=true').first().waitFor(); // (19,99 + 9,90) − 10%
      ok(`[${label}] order bump marcado e cupom DEZ aplicado: total R$ 26,90`);

      // 5) gera o Pix
      await submit.click();
      await p.waitForURL(/\/pedido\/[a-f0-9]{48}/, { timeout: 15_000 });
      const token = p.url().split('/pedido/')[1];
      const order = db.orders.find((o) => o.public_token === token)!;
      await p.getByText('Aguardando pagamento').waitFor();
      expect(await p.getByText('R$ 26,90').count()).toBeGreaterThan(0);
      expect(await p.locator('img[alt="QR Code Pix"]').count()).toBe(1);
      expect(await p.getByText(order.pix_code).count()).toBe(1);
      await p.getByText('Prime Tecnologia').first().waitFor();
      const clock = await p.locator('text=/\\d{2}:\\d{2}/').first().textContent();
      expect(Number(clock!.split(':')[0])).toBeLessThanOrEqual(15);
      expect((new Date(order.expires_at).getTime() - Date.now()) / 60000).toBeGreaterThan(118);
      expect(charges.get(order.id)?.value).toBe(2690);
      expect(db.order_items.filter((i) => i.order_id === order.id)).toHaveLength(2);
      ok(`[${label}] Pix gerado: QR Code + copia e cola, R$ 26,90 na Woovi, cronômetro ${clock} (Pix válido por 2 h), "Pagamento para Prime Tecnologia"`);

      // 6) copiar código
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      await p.getByRole('button', { name: /Copiar código Pix/ }).click();
      await p.getByText('Código copiado!').waitFor();
      ok(`[${label}] botão "Copiar código Pix" funciona`);

      // 7) mesma compra de novo → mesmo Pix (sem duplicar)
      const again = await fetch(`${base}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkout_slug: '8931442', customer: { name: 'Maria Souza', email, phone: '11988887777' }, bump_ids: ['00000000-0000-4000-8000-0000000000b1'], coupon_code: 'DEZ', tracking: {} }) }).then((r) => r.json());
      expect(again.token).toBe(token);
      ok(`[${label}] gerar de novo a mesma compra devolve o MESMO Pix`);

      // 8) paga → a página muda sozinha para aprovado + upsell
      await pay(order.id);
      await p.getByText('Espere! Seu pedido pode ficar ainda melhor').waitFor({ timeout: 15_000 });
      ok(`[${label}] pagamento confirmado: a página mudou sozinha e mostrou o upsell`);
      await p.getByRole('button', { name: /Não, obrigado/ }).click();
      await p.getByText('Pagamento aprovado!').waitFor();
      expect(await p.locator('a[href="https://drive.google.com/acesso-principal"]').count()).toBe(1);
      expect(await p.locator('a[href="https://drive.google.com/acesso-bonus"]').count()).toBe(1);
      ok(`[${label}] recusar o upsell mostra a página de acesso com os links do produto e do order bump`);
      expect(db.orders.find((o) => o.id === order.id)!.status).toBe('paid');
      expect(pt).toContain('sale.approved');
      ok(`[${label}] pedido marcado como pago e venda enviada à PayTracking`);

      // 9) sem estouro de layout e sem erros
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(overflow).toBe(false);
      expect(errors).toEqual([]);
      ok(`[${label}] sem rolagem lateral e sem erros no console`);
      await ctx.close();
    }, 90_000);
  }
});
