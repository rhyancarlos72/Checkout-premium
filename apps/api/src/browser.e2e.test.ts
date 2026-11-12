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
const efiCharges = new Map<string, { status: string; body: any; total: number }>();
let efiSeq = 7000;
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : null;
    const json = (s: number, v: unknown) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
    if (req.url === '/cob/v1/authorize') return json(200, { access_token: 'efi-tok', expires_in: 600 });
    if (req.url === '/cob/v1/charge/card' && req.method === 'POST') {
      const id = String(++efiSeq);
      const status = String(body.payment_token).includes('challenge') ? 'waiting' : 'approved';
      efiCharges.set(id, { status, body, total: body.items[0].value });
      return json(200, { charge_id: Number(id), status, total: body.items[0].value, installments: body.installments, ...(status === 'waiting' ? { tds_challenge: { form_data: { action_url: 'https://acs.banco.test/3ds', creq: 'CREQ', threeDSSessionData: 'SESS' } } } : {}) });
    }
    const eg = req.url!.match(/^\/cob\/v1\/charge\/(\d+)$/);
    if (eg) {
      const c = efiCharges.get(eg[1]);
      return c ? json(200, { data: { charge_id: Number(eg[1]), status: c.status, total: c.total } }) : json(404, {});
    }
    const sf = req.url!.match(/^\/woovi\/api\/v1\/charge\/([^/]+)\/card\/smartform$/);
    if (req.method === 'POST' && sf) return json(200, { checkoutUrl: `https://woovi.test/card/${sf[1]}` });
    if (req.method === 'POST' && req.url === '/woovi/api/v1/charge' && body.type === 'CREDIT_CARD') {
      charges.set(body.correlationID, { status: 'ACTIVE', value: body.value, body } as any);
      return json(200, { charge: { correlationID: body.correlationID, expiresDate: new Date(Date.now() + body.expiresIn * 1000).toISOString() } });
    }
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
let ext = '';
let server: http.Server;
let browser: any;
const report: string[] = [];
const ok = (msg: string) => report.push(`✅ ${msg}`);

beforeAll(async () => {
  if (!RUN) return;
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  ext = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
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
      p.on('pageerror', (e: Error) => errors.push(e.message + ' @ ' + (e.stack ?? '').split('\n').slice(0, 4).join(' / ')));
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
      // a página do Pix abre no topo (o botão foi clicado lá embaixo no checkout)
      expect(await p.evaluate(() => window.scrollY)).toBe(0);
      const qrTop = await p.locator('img[alt="QR Code Pix"]').evaluate((el) => el.getBoundingClientRect().top);
      ok(`[${label}] página do Pix abre no topo (QR Code a ${Math.round(qrTop)} px do topo da tela)`);
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/pix-topo-${label}.png` });
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

// pôster SVG (capa 2:3) servido no lugar das imagens externas
const poster = (n: number, label: string, color = '#0b2a8a') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}"/><stop offset=".55" stop-color="#050816"/><stop offset="1" stop-color="#000"/></linearGradient></defs><rect width="600" height="900" fill="url(#g)"/><text x="300" y="250" fill="#fff" font-family="sans-serif" font-size="34" letter-spacing="10" text-anchor="middle">TEMA</text><text x="300" y="520" fill="#fff" font-family="sans-serif" font-size="260" text-anchor="middle">${n}</text><text x="300" y="690" fill="#fff" font-family="sans-serif" font-size="34" letter-spacing="8" text-anchor="middle">${label}</text></svg>`;

describe.skipIf(!RUN)('área de membros no navegador', () => {
  const P1 = '00000000-0000-4000-8000-000000000001';
  const P2 = '00000000-0000-4000-8000-000000000002';
  const P3 = '00000000-0000-4000-8000-000000000003';
  let orderToken = '';

  beforeAll(async () => {
    const now = new Date().toISOString();
    for (const p of db.products) p.members_enabled = true;
    db.checkouts.push({ id: '00000000-0000-4000-8000-0000000000c3', product_id: P3, slug: '7777777', name: 'Kit', price_cents: 2990, active: true, provider: 'woovi', pix_expires_minutes: 120, theme: {}, fields: { phone: true }, tracking: {}, created_at: now });
    const sec = (id: string, product_id: string, title: string, sort: number) => ({ id, product_id, title, sort, created_at: now });
    db.member_sections = [sec('00000000-0000-4000-8000-00000000e001', P1, 'Sessão 1', 0), sec('00000000-0000-4000-8000-00000000e002', P1, 'Sessão 2', 1), sec('00000000-0000-4000-8000-00000000e003', P2, 'Bônus', 0), sec('00000000-0000-4000-8000-00000000e004', P3, 'Convites', 0)];
    const labels = ['COMECE AQUI', 'FACEBOOK ADS', 'NICHOS EM ALTA', 'OFERTA LOWTICKET', 'CRIATIVOS', 'ESCALA', 'BÔNUS'];
    const subs = ['Preparando a base', 'Facebook ads', 'Nichos que vendem + hacks', 'lowticket rápido + escala', 'Criação de criativos', 'Escala com segurança', 'Bônus exclusivos'];
    db.member_modules = [
      ...labels.map((l, i) => ({ id: `00000000-0000-4000-8000-00000000f0${String(i + 10)}`, product_id: P1, section_id: '00000000-0000-4000-8000-00000000e001', title: l, subtitle: subs[i], cover_url: `https://img.test/p${i + 1}.svg`, sort: i, created_at: now })),
      ...[0, 1, 2].map((i) => ({ id: `00000000-0000-4000-8000-00000000f0${String(i + 20)}`, product_id: P1, section_id: '00000000-0000-4000-8000-00000000e002', title: `Avançado ${i + 1}`, subtitle: `Aula avançada ${i + 1}`, cover_url: i === 2 ? null : `https://img.test/q${i + 1}.svg`, sort: i, created_at: now })),
      { id: '00000000-0000-4000-8000-00000000f030', product_id: P2, section_id: '00000000-0000-4000-8000-00000000e003', title: 'Capas prontas', subtitle: 'Bônus do order bump', cover_url: 'https://img.test/b1.svg', sort: 0, created_at: now },
      { id: '00000000-0000-4000-8000-00000000f040', product_id: P3, section_id: '00000000-0000-4000-8000-00000000e004', title: 'Convites', subtitle: null, cover_url: 'https://img.test/x1.svg', sort: 0, created_at: now },
    ];
    db.member_lessons = [
      { id: '00000000-0000-4000-8000-00000000a001', product_id: P1, module_id: '00000000-0000-4000-8000-00000000f010', title: 'Boas-vindas e como usar a área', description: 'Assista até o fim: aqui você entende o passo a passo do curso.', video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', duration: '6 min', attachments: [{ name: 'Checklist em PDF', url: 'https://x.test/a.pdf' }], sort: 0, created_at: now },
      { id: '00000000-0000-4000-8000-00000000a002', product_id: P1, module_id: '00000000-0000-4000-8000-00000000f010', title: 'Configurando sua conta', description: null, video_url: 'https://vimeo.com/123456789', duration: '12 min', attachments: [], sort: 1, created_at: now },
      { id: '00000000-0000-4000-8000-00000000a003', product_id: P1, module_id: '00000000-0000-4000-8000-00000000f010', title: 'Primeira campanha', description: null, video_url: null, duration: '9 min', attachments: [], sort: 2, created_at: now },
    ];
    // compra com order bump já paga
    const r = await fetch(`${base}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.1.1.1' }, body: JSON.stringify({ checkout_slug: '8931442', customer: { name: 'Rhyan Carlos', email: 'aluno@x.com', phone: '11977776655' }, bump_ids: ['00000000-0000-4000-8000-0000000000b1'], tracking: {} }) }).then((x) => x.json());
    orderToken = r.token;
    await pay(db.orders.find((o) => o.public_token === orderToken)!.id);
    await new Promise((res) => setTimeout(res, 200));
  });

  for (const [label, viewport] of [['computador', { width: 1440, height: 900 }], ['celular', { width: 390, height: 844 }]] as const) {
    it(`aluno entra pelo link da compra e assiste às aulas (${label})`, async () => {
      db.member_progress = []; // cada tela começa do zero
      const ctx = await browser.newContext({ viewport, locale: 'pt-BR' });
      const p = await ctx.newPage();
      const errors: string[] = [];
      p.on('pageerror', (e: Error) => errors.push(e.message + ' @ ' + (e.stack ?? '').split('\n').slice(0, 4).join(' / ')));
      p.on('console', (m: any) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
      const covers: Record<string, string> = { p1: poster(1, 'COMECE AQUI'), p2: poster(2, 'FACEBOOK ADS'), p3: poster(3, 'NICHOS'), p4: poster(4, 'LOWTICKET'), p5: poster(5, 'CRIATIVOS'), p6: poster(6, 'ESCALA'), p7: poster(7, 'BÔNUS'), q1: poster(1, 'AVANÇADO', '#14532d'), q2: poster(2, 'AVANÇADO', '#14532d'), b1: poster(1, 'CAPAS', '#7c2d12'), x1: poster(1, 'CONVITES', '#4c1d95') };
      await p.route('https://img.test/**', (route: any) => route.fulfill({ contentType: 'image/svg+xml', body: covers[route.request().url().split('/').pop()!.replace('.svg', '')] ?? poster(0, '?') }));
      await p.route(/youtube-nocookie|vimeo/, (route: any) => route.fulfill({ contentType: 'text/html', body: '<body style="margin:0;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;font:20px sans-serif">▶ player do vídeo</body>' }));

      // página de acesso: botão da área de membros
      await p.goto(`${base}/pedido/${orderToken}`);
      await p.getByText(/Espere! Seu pedido|Pagamento aprovado!/).first().waitFor({ timeout: 15_000 });
      const no = p.getByRole('button', { name: /Não, obrigado/ });
      if (await no.count()) await no.click();
      const enter = p.getByRole('link', { name: /Entrar na área de membros/ }).first();
      await enter.waitFor();
      ok(`[${label}] página de acesso mostra "Entrar na área de membros"`);

      await p.goto(`${base}/membros/entrar?o=${orderToken}`);
      await p.getByText('Seu curso').waitFor({ timeout: 15_000 });
      expect(await p.getByText('Pack Etiquetas Escolares').count()).toBeGreaterThan(0);
      expect(await p.getByText('Bônus Capas').count()).toBeGreaterThan(0); // order bump vira curso
      await p.getByText('Cursos adicionais').waitFor();
      expect(await p.locator('a[href="/checkout?produto_id=7777777"]').count()).toBe(1);
      ok(`[${label}] área de membros: curso principal + curso do order bump liberados, Kit Convites bloqueado em "Cursos adicionais"`);
      await p.waitForTimeout(400);
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/membros-${label}.png` });
      await p.getByText('Cursos adicionais').scrollIntoViewIfNeeded();
      await p.waitForTimeout(300);
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/membros-extras-${label}.png` });
      expect(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);

      // abre o módulo 1, assiste e conclui
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.getByRole('link', { name: /Assistir|Continuar/ }).first().click();
      await p.getByRole('heading', { name: 'Boas-vindas e como usar a área' }).waitFor();
      expect(await p.locator('iframe[src*="youtube-nocookie.com/embed/dQw4w9WgXcQ"]').count()).toBe(1);
      await p.getByRole('link', { name: 'Checklist em PDF' }).waitFor();
      await p.waitForTimeout(300);
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/membros-aula-${label}.png` });
      await p.getByRole('button', { name: /Próxima/ }).click();
      await p.getByRole('heading', { name: 'Configurando sua conta' }).waitFor();
      expect(await p.locator('iframe[src^="https://player.vimeo.com/video/123456789"]').count()).toBe(1);
      ok(`[${label}] aula com YouTube e Vimeo incorporados, materiais e "Próxima" (marca a anterior como concluída)`);
      await p.getByRole('link', { name: 'Voltar ao início' }).click();
      await p.getByText('33% concluído').first().waitFor();
      ok(`[${label}] progresso do curso atualizado (33% concluído, botão vira "Continuar")`);
      await p.getByText('Continue assistindo').waitFor();
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/membros-continuar-${label}.png` });
      // sai e entra de novo com e-mail + senha (a senha gerada na compra)
      const { ensureMemberAccess } = await import('./services/members.js');
      const acc = (await ensureMemberAccess(db.orders.find((o) => o.public_token === orderToken)!.id))!;
      expect(acc.password).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
      await p.getByRole('button', { name: /Sair/ }).click();
      await p.getByLabel('E-mail').fill('aluno@x.com');
      await p.getByLabel('Senha', { exact: true }).fill('senha-errada');
      await p.getByRole('button', { name: /^Entrar$/ }).click();
      await p.getByText('E-mail ou senha incorretos').waitFor();
      await p.getByLabel('Senha', { exact: true }).fill(acc.password!);
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/membros-login-${label}.png` });
      await p.getByRole('button', { name: /^Entrar$/ }).click();
      await p.getByText('Seu curso').waitFor();
      ok(`[${label}] login do aluno com e-mail + senha gerada na compra (senha errada é recusada)`);
      expect(errors).toEqual([]);
      await ctx.close();
    }, 90_000);
  }
});

describe.skipIf(!RUN)('painel: aba Área de membros', () => {
  it('lista os produtos e abre o editor do curso com seções, módulos e aulas', async () => {
    const { supabase } = await import('./lib/core.js');
    const uid = '00000000-0000-4000-8000-0000000000ad';
    db.admins = [{ user_id: uid, role: 'owner', email: 'dono@loja.com' }];
    (supabase as any).auth.getUser = async (t: string) => (t.startsWith('eyJ') ? { data: { user: { id: uid, email: 'dono@loja.com', factors: [] } }, error: null } : { data: { user: null }, error: { message: 'x' } });
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: uid, email: 'dono@loja.com', aal: 'aal1', exp, role: 'authenticated' })}.sig`;
    const session = { access_token: jwt, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: { id: uid, email: 'dono@loja.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, factors: [] } };
    for (const [label, viewport] of [['computador', { width: 1440, height: 1000 }], ['celular', { width: 390, height: 844 }]] as const) {
      const ctx = await browser.newContext({ viewport, locale: 'pt-BR' });
      await ctx.addInitScript((s: string) => localStorage.setItem('sb-fake-auth-token', s), JSON.stringify(session));
      const p = await ctx.newPage();
      await p.route('https://fake.supabase.co/**', (r: any) => r.fulfill({ json: {} }));
      await p.route('https://img.test/**', (route: any) => route.fulfill({ contentType: 'image/svg+xml', body: poster(1, 'MÓDULO') }));
      const errors: string[] = [];
      p.on('pageerror', (e: Error) => errors.push(e.message));
      await p.goto(`${base}/admin/area-de-membros`);
      await p.getByRole('heading', { name: 'Área de membros' }).waitFor({ timeout: 15_000 });
      await p.getByText('Pack Etiquetas Escolares').first().waitFor();
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/admin-membros-${label}.png` });
      await p.locator('.grid > *').filter({ hasText: 'Pack Etiquetas Escolares' }).getByRole('button', { name: /Montar curso/ }).click();
      await p.getByText('Banner de destaque').waitFor();
      await p.getByText('Sessão 1').first().waitFor();
      await p.waitForTimeout(300);
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/admin-curso-${label}.png`, fullPage: label === 'computador' });
      // cria uma seção e abre um módulo
      await p.getByLabel('Nome da nova seção').fill('Sessão Extra');
      await p.getByRole('button', { name: /Nova seção/ }).click();
      await p.getByText('Sessão Extra').first().waitFor();
      await p.getByText('COMECE AQUI').first().click();
      await p.getByText(/Aulas \(3\)/).waitFor();
      await p.waitForTimeout(300);
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/admin-modulo-${label}.png` });
      ok(`[${label}] painel: aba Área de membros lista produtos, abre o curso, cria seção e mostra as aulas do módulo`);
      if (label === 'computador') {
        // marketplace ligado: Plataforma (Super Admin) e Financeiro
        const OWNER = '0a000000-0000-4000-8000-000000000001';
        db.organizations = [
          { id: OWNER, name: 'Prime Tecnologia', status: 'active', is_platform_owner: true, split_enabled: true, recipient: {}, created_at: new Date().toISOString() },
          { id: '0b000000-0000-4000-8000-000000000002', name: 'Loja da Ana', document: '12.345.678/0001-90', status: 'active', is_platform_owner: false, split_enabled: false, recipient: {}, created_at: new Date().toISOString() },
        ];
        for (const t of ['products', 'checkouts', 'order_bumps', 'checkout_bumps', 'coupons', 'orders', 'events', 'upsells', 'member_sections', 'member_modules', 'member_lessons']) for (const r of db[t] ?? []) r.org_id ??= OWNER;
        db.org_members = [{ org_id: '0b000000-0000-4000-8000-000000000002', user_id: 'x', role: 'owner', email: 'ana@loja.com' }];
        db.fee_policies = [{ id: 'fp1', org_id: null, fixed_cents: 99, percent_bps: 0, bump_cents: 40, gateway_fee_payer: 'producer', refund_policy: 'keep_fee', created_at: new Date().toISOString() }];
        db.ledger_entries = db.orders.filter((o) => o.status === 'paid').map((o) => ({ id: `l-${o.id}`, org_id: OWNER, order_id: o.id, type: 'sale', amount_cents: o.total_cents, data: { provider: 'woovi' }, created_at: new Date().toISOString() }));
        const t = await import('./lib/tenant.js');
        t.clearOwnerCache();
        (await import('./middleware/auth.js')).clearAuthCache();
        await p.goto(`${base}/admin/plataforma`);
        await p.getByText('Loja da Ana').waitFor({ timeout: 15_000 });
        await p.waitForTimeout(300);
        if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/admin-plataforma.png` });
        await p.getByRole('button', { name: 'Taxas' }).click();
        await p.getByText('Nova tabela de taxas').waitFor();
        await p.waitForTimeout(300);
        if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/admin-taxas.png` });
        await p.goto(`${base}/admin/financeiro`);
        await p.getByText('Conta proprietária · isenta de taxas da plataforma').waitFor({ timeout: 15_000 });
        await p.waitForTimeout(300);
        if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/admin-financeiro.png` });
        ok('[computador] Plataforma (produtores, taxas) e Financeiro com isenção da conta proprietária');
        delete db.organizations;
        t.clearOwnerCache();
        (await import('./middleware/auth.js')).clearAuthCache();

        // vitrine de produtos adicionais: escolhe o Kit Convites, muda o título e salva
        await p.goto(`${base}/admin/area-de-membros`);
        await p.getByRole('button', { name: 'Produtos adicionais' }).click();
        await p.getByText('Vitrine de produtos adicionais').waitFor();
        const opt = await p.getByLabel('Produto para oferecer').locator('option', { hasText: 'Kit Convites' }).getAttribute('value');
        await p.getByLabel('Produto para oferecer').selectOption(opt!);
        await p.getByRole('button', { name: /Adicionar à vitrine/ }).click();
        await p.getByPlaceholder('Kit Convites').fill('Kit Convites VIP');
        await p.getByPlaceholder('Exclusivo').fill('Novo');
        await p.waitForTimeout(300);
        if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/admin-vitrine.png` });
        await p.getByRole('button', { name: 'Salvar vitrine' }).click();
        await p.getByText('Vitrine salva').waitFor();
        const cfg = db.settings.find((x) => x.key === 'members')!.value;
        expect(cfg.offers).toHaveLength(1);
        expect(cfg.offers[0]).toMatchObject({ title: 'Kit Convites VIP', badge: 'Novo' });
        ok('[computador] painel: vitrine de produtos adicionais escolhida e salva');
        db.settings = db.settings.filter((x) => x.key !== 'members');

        // Produtos: entrega padrão = link; escolher "Área de membros" cria o curso sozinho
        await p.goto(`${base}/admin/produtos`);
        await p.getByRole('button', { name: /Novo produto/ }).first().click();
        expect(await p.locator('select').first().inputValue()).toBe('link');
        await p.getByRole('dialog').locator('input').first().fill('Curso Novo de Teste');
        await p.getByPlaceholder('97,00').fill('47,00');
        await p.locator('select').first().selectOption('members');
        await p.getByText('A área de membros deste produto é criada automaticamente.').waitFor();
        if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/admin-produto-membros.png` });
        await p.getByRole('button', { name: /^Salvar$/ }).click();
        await p.getByText('Curso Novo de Teste').first().waitFor();
        const np = db.products.find((x) => x.name === 'Curso Novo de Teste')!;
        expect(np.members_enabled).toBe(true);
        expect(np.delivery_type).toBe('none');
        expect(db.member_sections.filter((x) => x.product_id === np.id).map((x) => x.title)).toEqual(['Sessão 1']);
        ok('[computador] Produtos: entrega padrão é o link; "Área de membros" cria o curso automaticamente (Sessão 1)');
      }
      expect(errors).toEqual([]);
      await ctx.close();
    }
  }, 90_000);
});

describe.skipIf(!RUN)('cartão de crédito no checkout', () => {
  for (const [label, viewport] of [['computador', { width: 1366, height: 900 }], ['celular', { width: 390, height: 844 }]] as const) {
    it(`cliente escolhe Cartão, informa o CPF e vai para a página segura (${label})`, async () => {
      const g = db.settings.find((x) => x.key === 'gateways')!;
      g.value = { ...g.value, card: { enabled: true, provider: 'woovi', maxInstallments: 3 } };
      const { refreshGateways } = await import('./services/gateways.js');
      await refreshGateways(true);
      (await import('./services/orders.js')).clearCheckoutCache();
      const ctx = await browser.newContext({ viewport, locale: 'pt-BR' });
      const p = await ctx.newPage();
      const errors: string[] = [];
      p.on('pageerror', (e: Error) => errors.push(e.message));
      await p.route('https://woovi.test/**', (r: any) => r.fulfill({ contentType: 'text/html', body: '<h1>Página segura da Woovi</h1>' }));
      await p.goto(`${base}/checkout?produto_id=8931442`);
      await p.getByRole('button', { name: 'Cartão' }).click();
      await p.getByText('Em até 3x sem juros').waitFor();
      await p.getByPlaceholder('Seu nome completo').fill('Carlos Cartão');
      await p.getByPlaceholder('Seu melhor e-mail').fill(`carlos-${label}@x.com`);
      await p.getByPlaceholder('(00) 00000-0000').fill('11977776666');
      const cpf = p.getByPlaceholder('000.000.000-00');
      await cpf.scrollIntoViewIfNeeded();
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/cartao-checkout-${label}.png` });
      // sem CPF: barrado
      await p.locator('button[type="submit"]:visible').first().click();
      await p.getByText('Informe seu CPF').waitFor();
      await cpf.fill('52998224725');
      expect(await cpf.inputValue()).toBe('529.982.247-25');
      await p.locator('button[type="submit"]:visible').first().click();
      await p.waitForURL(/woovi\.test\/card\//, { timeout: 15_000 });
      const order = db.orders.find((o) => o.customer_id && db.customers.find((c) => c.id === o.customer_id)?.email === `carlos-${label}@x.com`)!;
      expect(order.payment_method).toBe('card');
      expect((charges.get(order.id) as any).body).toMatchObject({ type: 'CREDIT_CARD', cardInstallments: 3, customer: { taxID: '52998224725' } });
      ok(`[${label}] cartão: botão ao lado do Pix, CPF obrigatório, cobrança CREDIT_CARD em até 3x e ida para a página segura da Woovi`);
      // voltar: a página do pedido mostra "Pagar com cartão" e aprova sozinha
      await p.goBack();
      await p.getByText('Aguardando pagamento no cartão').waitFor({ timeout: 15_000 });
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/cartao-pedido-${label}.png` });
      await pay(order.id);
      await p.getByText(/Pagamento aprovado!|Espere! Seu pedido/).first().waitFor({ timeout: 15_000 });
      ok(`[${label}] cartão aprovado: a página do pedido atualizou sozinha`);
      expect(errors).toEqual([]);
      await ctx.close();
      g.value = { ...g.value, card: { enabled: false } };
      await refreshGateways(true);
      (await import('./services/orders.js')).clearCheckoutCache();
    }, 90_000);
  }
});

// biblioteca da Efí simulada no navegador (a de verdade fala com a Efí)
const fakeEfiLib = () => {
  const st: any = {};
  const api: any = {
    setCardNumber: (n: string) => ((st.n = n), api),
    verifyCardBrand: async () => 'visa',
    setAccount: (a: string) => ((st.a = a), api),
    setEnvironment: (e: string) => ((st.e = e), api),
    setBrand: () => api,
    setTotal: (t: number) => ((st.t = t), api),
    getInstallments: async () => ({ installments: [1, 2, 3].map((n) => ({ installment: n, has_interest: false, value: Math.round(st.t / n) })) }),
    setCreditCardData: (d: any) => ((st.d = d), api),
    getPaymentToken: async () => {
      (window as any).__efiLast = { ...st.d, account: st.a, env: st.e };
      return { payment_token: `${String(st.d.holderName).includes('BANCO') ? 'tok-challenge' : 'tok-approve'}-1234567890`, card_mask: 'XXXXXXXXXXXX0087', tds_identifier: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6' };
    },
  };
  (window as any).__efiTest = { CreditCard: api };
};

describe.skipIf(!RUN)('cartão pela Efí no checkout', () => {
  for (const [label, viewport] of [['computador', { width: 1366, height: 900 }], ['celular', { width: 390, height: 844 }]] as const) {
    it(`campos do cartão no checkout, token da Efí, aprovado na hora e verificação do banco (${label})`, async () => {
      process.env.EFI_COBRANCAS_URL = `${ext}/cob`;
      const g = db.settings.find((x) => x.key === 'gateways')!;
      g.value = { ...g.value, efi: { clientId: 'cid', clientSecret: 'cs', payeeCode: 'PAYEE-PRIME', sandbox: true }, card: { enabled: true, provider: 'efi', maxInstallments: 3 } };
      const { refreshGateways } = await import('./services/gateways.js');
      await refreshGateways(true);
      (await import('./services/orders.js')).clearCheckoutCache();
      const ctx = await browser.newContext({ viewport, locale: 'pt-BR' });
      await ctx.addInitScript(fakeEfiLib);
      const p = await ctx.newPage();
      const errors: string[] = [];
      p.on('pageerror', (e: Error) => errors.push(e.message));
      await p.route('https://acs.banco.test/**', (r: any) => r.fulfill({ contentType: 'text/html', body: '<h1>Confirme no app do banco</h1>' }));
      const fill = async (name: string, email: string) => {
        await p.goto(`${base}/checkout?produto_id=8931442`);
        await p.getByRole('button', { name: 'Cartão' }).click();
        await p.getByPlaceholder('Seu nome completo').fill('Diana Souza');
        await p.getByPlaceholder('Seu melhor e-mail').fill(email);
        await p.getByPlaceholder('(00) 00000-0000').fill('11966665555');
        await p.getByPlaceholder('000.000.000-00').fill('52998224725');
        await p.getByPlaceholder('0000 0000 0000 0000').fill('4485785674290087');
        await p.getByPlaceholder('COMO ESTÁ NO CARTÃO').fill(name);
        await p.getByPlaceholder('MM/AA').fill('0530');
        await p.getByPlaceholder('123').fill('123');
      };
      await fill('DIANA SOUZA', `diana-${label}@x.com`);
      expect(await p.getByPlaceholder('0000 0000 0000 0000').inputValue()).toBe('4485 7856 7429 0087');
      expect(await p.getByPlaceholder('MM/AA').inputValue()).toBe('05/30');
      await p.locator('select').last().selectOption('3');
      await p.getByPlaceholder('MM/AA').scrollIntoViewIfNeeded();
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/efi-cartao-${label}.png` });
      await p.locator('button[type="submit"]:visible').first().click();
      await p.getByText(/Pagamento aprovado!|Espere! Seu pedido/).first().waitFor({ timeout: 15_000 });
      const lib = await p.evaluate(() => (window as any).__efiLast);
      expect(lib).toMatchObject({ account: 'PAYEE-PRIME', env: 'sandbox', holderDocument: '52998224725', expirationMonth: '05', expirationYear: '2030', enable3ds: true, totalValue: 1999 });
      const o = db.orders.find((x) => db.customers.find((c) => c.id === x.customer_id)?.email === `diana-${label}@x.com`)!;
      expect(o).toMatchObject({ status: 'paid', provider: 'efi', payment_method: 'card' });
      // o número do cartão nunca chegou ao servidor: só o token
      expect(JSON.stringify(efiCharges.get(o.provider_charge_id)!.body)).not.toContain('4485785674290087');
      expect(efiCharges.get(o.provider_charge_id)!.body).toMatchObject({ payment_token: 'tok-approve-1234567890', installments: 3 });
      ok(`[${label}] cartão Efí: campos no checkout, token gerado no navegador (número nunca vai ao servidor), 3x, aprovado na hora`);

      // banco pede verificação → tela do banco; ao voltar, "confirmando com o banco" e aprova pela Efí
      await fill('DIANA BANCO SOUZA', `diana3ds-${label}@x.com`);
      await p.locator('button[type="submit"]:visible').first().click();
      await p.waitForURL(/acs\.banco\.test/, { timeout: 15_000 });
      const o2 = db.orders.find((x) => db.customers.find((c) => c.id === x.customer_id)?.email === `diana3ds-${label}@x.com`)!;
      expect(o2.status).toBe('pending');
      await p.goto(`${base}/pedido/${o2.public_token}`);
      await p.getByText('Confirmando o pagamento com o seu banco…').waitFor({ timeout: 15_000 });
      efiCharges.get(o2.provider_charge_id)!.status = 'paid';
      await p.getByText(/Pagamento aprovado!|Espere! Seu pedido/).first().waitFor({ timeout: 20_000 });
      ok(`[${label}] cartão Efí com verificação do banco (3DS): foi para a tela do banco e aprovou ao voltar`);
      expect(errors).toEqual([]);
      await ctx.close();
      g.value = { ...g.value, card: { enabled: false } };
      await refreshGateways(true);
      (await import('./services/orders.js')).clearCheckoutCache();
      delete process.env.EFI_COBRANCAS_URL;
    }, 120_000);
  }
});

describe.skipIf(!RUN)('Pixel com cidade/estado do visitante', () => {
  it('PageView e InitiateCheckout vão com cidade e UF calculadas pelo IP no servidor', async () => {
    const { clearCheckoutCache } = await import('./services/orders.js');
    const c = db.checkouts.find((x) => x.slug === '8931442')!;
    const before = c.tracking;
    c.tracking = { metaPixelId: '111222333' };
    clearCheckoutCache();
    const ctx = await browser.newContext({ locale: 'pt-BR', extraHTTPHeaders: { 'X-Forwarded-For': '187.10.20.77' } });
    // biblioteca do Pixel simulada: as chamadas ficam na fila do fbq para conferirmos
    await ctx.route('**/fbevents.js', (r: any) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    const p = await ctx.newPage();
    try {
      await p.goto(`${base}/checkout?produto_id=8931442`, { waitUntil: 'load' });
      await p.getByText('Pack Etiquetas Escolares').first().waitFor();
      const calls = () => p.evaluate(() => (window as any).fbq.queue.map((a: any[]) => JSON.parse(JSON.stringify(a))));
      const first = await calls();
      expect(first[0]).toEqual(['init', '111222333', expect.objectContaining({ country: 'br', ct: 'maua', st: 'sp' })]);
      expect(first[1]).toEqual(['track', 'PageView']);
      await p.fill('input[autocomplete=name]', 'Maria Souza');
      await p.fill('input[type=email]', 'maria.geo@teste.com');
      await p.waitForFunction(() => (window as any).fbq.queue.some((a: any[]) => a[1] === 'InitiateCheckout'));
      const all = await calls();
      const ic = all.findIndex((a: any[]) => a[1] === 'InitiateCheckout');
      const lastInit = all.slice(0, ic).filter((a: any[]) => a[0] === 'init').pop();
      expect(lastInit[2]).toMatchObject({ em: 'maria.geo@teste.com', fn: 'maria', ln: 'souza', ct: 'maua', st: 'sp', country: 'br' });
      ok('Pixel: PageView e InitiateCheckout com cidade (maua) e UF (sp) pelo IP');
    } finally {
      c.tracking = before;
      clearCheckoutCache();
      await ctx.close();
    }
  });
});

describe.skipIf(!RUN)('página do Pix aberta pelo link', () => {
  it('mostra o QR Code e o copia e cola sem esperar a API (pedido já vem no HTML)', async () => {
    const created = await fetch(`${base}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '187.10.20.99' }, body: JSON.stringify({ checkout_slug: '8931442', customer: { name: 'Lia Link', email: 'lia.link@teste.com', phone: '11977776666' }, bump_ids: [], tracking: {} }) }).then((r) => r.json());
    const o = db.orders.find((x) => x.public_token === created.token);
    expect(o?.pix_code).toBeTruthy();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'pt-BR' });
    const p = await ctx.newPage();
    // API do pedido lenta de propósito: se a página dependesse dela, o QR demoraria 4 s
    await p.route(/\/api\/public\/orders\/[a-f0-9]{48}$/, async (r: any) => {
      await new Promise((res) => setTimeout(res, 4000));
      await r.continue().catch(() => {});
    });
    try {
      const t0 = Date.now();
      await p.goto(`${base}/pedido/${o!.public_token}`, { waitUntil: 'commit' });
      await p.locator('img[alt="QR Code Pix"]').waitFor({ timeout: 3500 });
      const ms = Date.now() - t0;
      expect(ms).toBeLessThan(3000);
      expect(await p.getByText(o!.pix_code, { exact: true }).count()).toBe(1);
      await p.getByText('Aguardando pagamento').waitFor();
      ok(`página do Pix pelo link: QR Code na tela em ${ms} ms mesmo com a API lenta`);
    } finally {
      await ctx.close();
    }
  });
});
