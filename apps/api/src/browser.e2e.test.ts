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
