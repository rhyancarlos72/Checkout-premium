/**
 * Venda de ponta a ponta com banco em memória, Woovi, Spedy e PayTracking falsos:
 * checkout → cotação com bump/cupom → Pix → webhook → pago (1 vez só) → entrega,
 * nota fiscal única, PayTracking → upsell → Pix vencido renovado em um toque.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeClient, db } from './test/fakeSupabase.js';

vi.mock('@supabase/supabase-js', () => ({ createClient: () => createFakeClient() }));

// ---------- serviços externos falsos
const charges = new Map<string, { status: string; value: number; body?: any }>();
const spedyCalls: any[] = [];
const ptCalls: { event: string; body: any; headers: http.IncomingHttpHeaders }[] = [];
const waSent: { instance: string; body: any }[] = [];
let evoDown = false; // simula a Evolution fora do ar
// Efí API de Cobranças simulada (cartão)
const efiCharges = new Map<string, { status: string; body: any; total: number }>();
let efiSeq = 9000;
const ptB: { event: string; body: any }[] = []; // PayTracking do produtor B (marketplace)
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : null;
    const json = (s: number, v: unknown) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
    if (req.method === 'POST' && req.url === '/woovi/api/v1/charge') {
      charges.set(body.correlationID, { status: 'ACTIVE', value: body.value, body });
      // cartão (type CREDIT_CARD): a Woovi não devolve brCode
      return json(200, { charge: { correlationID: body.correlationID, ...(body.type === 'CREDIT_CARD' ? {} : { brCode: `00020101PIX-${body.correlationID}`, qrCodeImage: 'https://x/qr.png' }), expiresDate: new Date(Date.now() + body.expiresIn * 1000).toISOString() } });
    }
    const sf = req.url!.match(/^\/woovi\/api\/v1\/charge\/([^/]+)\/card\/smartform$/);
    if (req.method === 'POST' && sf) return json(200, { checkoutUrl: `https://woovi.test/card/${sf[1]}` });
    if (req.method === 'GET' && req.url!.startsWith('/woovi/api/v1/charge/')) {
      const id = decodeURIComponent(req.url!.split('/').pop()!);
      const c = charges.get(id);
      return c ? json(200, { charge: { status: c.status, value: c.value } }) : json(404, { error: 'not found' });
    }
    if (req.url === '/spedy/service-invoices' && req.method === 'POST') {
      spedyCalls.push(body);
      return json(201, { id: `inv-${spedyCalls.length}`, status: 'enqueued' });
    }
    if (req.url!.startsWith('/evo/instance/connectionState/')) return json(200, { instance: { state: 'open' } });
    if (req.url!.startsWith('/evo/message/sendText/')) {
      if (evoDown) return json(502, { error: 'bad gateway' });
      waSent.push({ instance: decodeURIComponent(req.url!.split('/').pop()!), body });
      return json(201, { key: { id: 'x' } });
    }
    if (req.url === '/cob/v1/authorize' && req.method === 'POST') {
      return req.headers.authorization?.startsWith('Basic ') ? json(200, { access_token: 'efi-tok', expires_in: 600, token_type: 'Bearer' }) : json(401, { error_description: 'credenciais' });
    }
    if (req.url === '/cob/v1/charge/card' && req.method === 'POST') {
      if (req.headers.authorization !== 'Bearer efi-tok') return json(401, {});
      const id = String(++efiSeq);
      const tok = String(body.payment_token);
      const status = tok.includes('refuse') ? 'unpaid' : tok.includes('challenge') ? 'waiting' : 'approved';
      efiCharges.set(id, { status, body, total: body.items[0].value });
      return json(200, {
        installments: body.installments, installment_value: body.items[0].value, charge_id: Number(id), status, total: body.items[0].value,
        ...(status === 'unpaid' ? { refusal: { reason: 'G4 - Transação não autorizada.', retry: true } } : {}),
        ...(status === 'waiting' ? { tds_challenge: { form_data: { method: 'POST', action_url: 'https://acs.banco.test/3ds', creq: 'CREQ123', threeDSSessionData: 'SESS456' }, html_template: '<html></html>' } } : {}),
      });
    }
    const efiGet = req.url!.match(/^\/cob\/v1\/charge\/(\d+)$/);
    if (efiGet && req.method === 'GET') {
      const c = efiCharges.get(efiGet[1]);
      return c ? json(200, { code: 200, data: { charge_id: Number(efiGet[1]), total: c.total, status: c.status } }) : json(404, { detail: 'not found' });
    }
    const efiNotif = req.url!.match(/^\/cob\/v1\/notification\/([\w-]+)$/);
    if (efiNotif && req.method === 'GET') {
      const id = efiNotif[1].replace('notif-', '');
      const c = efiCharges.get(id);
      return c ? json(200, { code: 200, data: [{ identifiers: { charge_id: Number(id) }, status: { current: 'new' } }, { identifiers: { charge_id: Number(id) }, status: { current: c.status } }] }) : json(404, { detail: 'token inválido' });
    }
    if (req.url === '/paytracking-b') {
      ptB.push({ event: body?.event, body });
      return json(200, { ok: true });
    }
    if (req.url === '/paytracking') {
      ptCalls.push({ event: body?.event, body, headers: req.headers });
      return json(200, { ok: true });
    }
    json(404, {});
  });
});

let base = '';
let ext = '';
let server: http.Server;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'User-Agent': 'e2e-test', 'X-Forwarded-For': '187.10.20.30' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const settle = () => new Promise((r) => setTimeout(r, 150));

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  ext = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PUBLIC_URL: 'https://checkout.loja.com',
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key-test-key-test-key',
    WOOVI_API_URL: `${ext}/woovi`,
    JOBS_ENABLED: 'false',
  });

  // ---------- dados da loja
  const now = new Date().toISOString();
  db.settings = [
    { key: 'gateways', value: { woovi: { appId: 'APP-ID-TESTE' } } },
    { key: 'invoices', value: { enabled: true, type: 'service', apiKey: 'spedy-key', apiUrl: `${ext}/spedy`, deductCents: 50 } },
    { key: 'whatsapp', value: { enabled: true, apiUrl: `${ext}/evo`, instances: [{ name: 'checkout1', token: 't1', active: true }, { name: 'checkout2', token: 't2', active: true }], approved: { enabled: true }, recovery: { enabled: true, firstMinutes: 20, secondMinutes: 180, thirdMinutes: 720, includePix: true } } },
    { key: 'webhooks', value: { items: [{ id: 'w1', name: 'PayTracking', preset: 'paytracking', url: `${ext}/paytracking`, token: 'tok', secret: 'seg', events: ['sale.pending', 'sale.approved', 'sale.canceled'], active: true, created_at: now }] } },
  ];
  db.products = [
    { id: '00000000-0000-4000-8000-000000000001', number: 1001, name: 'Pack Etiquetas', price_cents: 1999, active: true, delivery_type: 'link', delivery_url: 'https://drive.google.com/main', created_at: now },
    { id: '00000000-0000-4000-8000-000000000002', number: 1002, name: 'Bônus Capas', price_cents: 990, active: true, delivery_type: 'link', delivery_url: 'https://drive.google.com/bump', created_at: now },
    { id: '00000000-0000-4000-8000-000000000003', number: 1003, name: 'Kit Convites', price_cents: 2990, active: true, delivery_type: 'link', delivery_url: 'https://drive.google.com/up', created_at: now },
  ];
  db.checkouts = [{ id: '00000000-0000-4000-8000-0000000000c1', product_id: '00000000-0000-4000-8000-000000000001', slug: '8931442', name: 'Checkout', price_cents: 1999, active: true, provider: 'woovi', pix_expires_minutes: 30, theme: {}, fields: { phone: true, document: false }, tracking: {}, created_at: now }];
  db.order_bumps = [{ id: '00000000-0000-4000-8000-0000000000b1', product_id: '00000000-0000-4000-8000-000000000002', title: 'Leve também: Bônus Capas', price_cents: 990, compare_at_cents: 1990, active: true, created_at: now }];
  db.checkout_bumps = [{ checkout_id: '00000000-0000-4000-8000-0000000000c1', bump_id: '00000000-0000-4000-8000-0000000000b1', sort: 0 }];
  db.coupons = [{ id: '00000000-0000-4000-8000-0000000000aa', code: 'DEZ', type: 'percent', value: 10, used_count: 0, min_cents: 0, active: true, created_at: now }];
  db.upsells = [{ id: '00000000-0000-4000-8000-0000000000dd', product_id: '00000000-0000-4000-8000-000000000001', offer_product_id: '00000000-0000-4000-8000-000000000003', title: null, price_cents: 790, compare_at_cents: 2990, active: true, created_at: now }];

  const { createApp } = await import('./app.js');
  const { refreshGateways } = await import('./services/gateways.js');
  await refreshGateways(true);
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server?.close();
  fake.close();
});

describe('venda completa', () => {
  let token = '';
  let orderId = '';

  it('abre o checkout com o order bump', async () => {
    const r = await api('GET', '/api/public/checkouts/8931442');
    expect(r.status).toBe(200);
    expect(r.body.product.name).toBe('Pack Etiquetas');
    expect(r.body.bumps).toHaveLength(1);
  });

  it('cota com bump e cupom', async () => {
    const r = await api('POST', '/api/public/checkouts/8931442/quote', { bump_ids: ['00000000-0000-4000-8000-0000000000b1'], coupon_code: 'dez' });
    expect(r.status).toBe(200);
    expect(r.body.subtotal_cents).toBe(2989);
    expect(r.body.total_cents).toBe(2989 - Math.round(2989 * 0.1));
  });

  it('gera o Pix com QR Code local e devolve a página do pedido pronta', async () => {
    const r = await api('POST', '/api/public/orders', {
      checkout_slug: '8931442',
      customer: { name: 'maria souza', email: 'Maria@X.com', phone: '(11) 98888-7777' },
      bump_ids: ['00000000-0000-4000-8000-0000000000b1'],
      coupon_code: 'DEZ',
      tracking: { utm_source: 'FB', fbclid: 'IwAR0', fbp: 'fb.1.1700000000000.123456789', external_id: 'visitante-1', initiate_checkout_event_id: 'ic_1', add_payment_info_event_id: 'api_1', purchase_event_id: 'purchase_1', geo_city: 'Hackeado' },
    });
    expect(r.status).toBe(201);
    token = r.body.token;
    expect(token).toMatch(/^[a-f0-9]{48}$/);
    expect(r.body.order.pix_code).toMatch(/^00020101PIX-/);
    expect(r.body.order.pix_qr_image).toMatch(/^data:image\/png;base64,/);
    expect(r.body.order.total_cents).toBe(2690);
    expect(r.body.order.external_id).toBe('visitante-1');
    const o = db.orders.find((x) => x.public_token === token)!;
    orderId = o.id;
    expect(o.ip).toBe('187.10.20.30');
    expect(o.tracking.geo_city).toBeUndefined(); // geo só vem do servidor
    expect(db.order_items.filter((i) => i.order_id === o.id)).toHaveLength(2);
    expect(charges.get(o.id)?.value).toBe(2690);
    // validade real do Pix: 2 horas (padrão de Integrações), não os 15 min do cronômetro da página
    const ttl = (new Date(o.expires_at).getTime() - Date.now()) / 60000;
    expect(ttl).toBeGreaterThan(118);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('envia sale.pending à PayTracking com o ID de 7 dígitos e telefone com 55', async () => {
    await settle();
    const p = ptCalls.find((c) => c.event === 'sale.pending')!;
    expect(p).toBeTruthy();
    expect(p.body.product_id).toMatch(/^\d{7}$/);
    expect(p.body.customer.phone).toBe('5511988887777');
    expect(p.body.customer.email).toBe('maria@x.com');
    expect(p.body.tracking.event_id).toBe('ic_1');
    expect(p.headers['x-paytrack-signature']).toMatch(/^sha256=/);
    expect(p.headers.authorization).toBe('Bearer tok');
  });

  it('pedido pendente mostra o Pix; antes de pagar não há entrega', async () => {
    const r = await api('GET', `/api/public/orders/${token}`);
    expect(r.body.status).toBe('pending');
    expect(r.body.pix_code).toBeTruthy();
    expect(r.body.delivery).toEqual([]);
  });

  it('webhook falso (gateway ainda ACTIVE) NÃO aprova', async () => {
    await api('POST', '/api/webhooks/woovi', { event: 'OPENPIX:CHARGE_COMPLETED', charge: { correlationID: orderId } });
    await settle();
    expect(db.orders.find((x) => x.id === orderId)!.status).toBe('pending');
    expect(db.invoices ?? []).toHaveLength(0);
  });

  it('pagamento confirmado no gateway aprova, emite UMA nota e manda sale.approved', async () => {
    charges.get(orderId)!.status = 'COMPLETED';
    await api('POST', '/api/webhooks/woovi', { event: 'OPENPIX:CHARGE_COMPLETED', charge: { correlationID: orderId } });
    await settle();
    await settle();
    const o = db.orders.find((x) => x.id === orderId)!;
    expect(o.status).toBe('paid');
    expect(db.coupons[0].used_count).toBe(1);
    expect(spedyCalls).toHaveLength(1);
    expect(spedyCalls[0].amount).toBe(26.4); // 26,90 − 0,50
    expect(spedyCalls[0].description).toContain('Pack Etiquetas + Leve também: Bônus Capas');
    expect(spedyCalls[0].integrationId).toBe(orderId);
    expect(db.invoices.filter((i) => i.order_id === orderId)).toHaveLength(1);
    const ap = ptCalls.filter((c) => c.event === 'sale.approved');
    expect(ap).toHaveLength(1);
    expect(ap[0].body.tracking.event_id).toBe('purchase_1');
    expect(ap[0].body.product_ids).toHaveLength(2);
  });

  it('webhook repetido não duplica nota, evento nem contagem do cupom', async () => {
    await api('POST', '/api/webhooks/woovi', { event: 'OPENPIX:CHARGE_COMPLETED', charge: { correlationID: orderId } });
    await api('POST', '/api/webhooks/woovi', { event: 'OPENPIX:CHARGE_COMPLETED', charge: { correlationID: orderId } });
    await settle();
    expect(spedyCalls).toHaveLength(1);
    expect(ptCalls.filter((c) => c.event === 'sale.approved')).toHaveLength(1);
    expect(db.coupons[0].used_count).toBe(1);
    expect(db.events.filter((e) => e.order_id === orderId && e.type === 'purchase')).toHaveLength(1);
  });

  it('WhatsApp de entrega sai com o nome do cliente e os links do Drive', async () => {
    await new Promise((r) => setTimeout(r, 4000)); // o envio tem pausa natural
    const m = waSent.find((w) => w.body?.number?.startsWith('5511988887777') || w.body?.number?.startsWith('551188887777'));
    expect(m).toBeTruthy();
    const text = m!.body.text ?? m!.body.textMessage?.text;
    expect(text).toContain('Maria');
    expect(text).toContain('https://drive.google.com/main');
    expect(text).toContain('https://drive.google.com/bump');
  }, 10_000);

  it('página do pedido pago: sem Pix, com entrega de cada produto e oferta de upsell', async () => {
    const r = await api('GET', `/api/public/orders/${token}`);
    expect(r.body.status).toBe('paid');
    expect(r.body.pix_code).toBeNull();
    expect(r.body.delivery.map((d: any) => d.url)).toEqual(['https://drive.google.com/main', 'https://drive.google.com/bump']);
    expect(r.body.upsell).toMatchObject({ title: 'Kit Convites', price_cents: 790 });
  });

  let upToken = '';
  it('upsell aceito gera Pix só do adicional; clicar de novo não duplica', async () => {
    const r = await api('POST', `/api/public/orders/${token}/upsell`);
    expect(r.status).toBe(200);
    upToken = r.body.token;
    expect(upToken).not.toBe(token);
    expect(r.body.order.total_cents).toBe(790);
    expect(r.body.order.items).toEqual([{ kind: 'main', name: 'Kit Convites', price_cents: 790 }]);
    expect(r.body.order.upsell).toBeNull();
    const again = await api('POST', `/api/public/orders/${token}/upsell`);
    expect(again.body.token).toBe(upToken);
    const up = db.orders.find((x) => x.public_token === upToken)!;
    expect(up.tracking.upsell_of).toBe(orderId);
    expect(up.tracking.purchase_event_id).not.toBe('purchase_1');
  });

  it('upsell pago entrega o produto oferecido e tira a oferta do pedido original', async () => {
    const up = db.orders.find((x) => x.public_token === upToken)!;
    charges.get(up.id)!.status = 'COMPLETED';
    await api('POST', '/api/webhooks/woovi', { charge: { correlationID: up.id } });
    await settle();
    const r = await api('GET', `/api/public/orders/${upToken}`);
    expect(r.body.status).toBe('paid');
    expect(r.body.delivery[0].url).toBe('https://drive.google.com/up');
    expect(spedyCalls).toHaveLength(2); // nota própria para a venda do upsell
    const orig = await api('GET', `/api/public/orders/${token}`);
    expect(orig.body.upsell).toBeNull();
  });
});

describe('recuperação pelo WhatsApp', () => {
  it('3 lembretes (20 min, 3 h, 12 h — o 3º é o último), link curto do Pix e copia e cola; nunca um 4º', async () => {
    const r = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Carla Dias', email: 'carla@x.com', phone: '11933332222' }, bump_ids: [], tracking: {} });
    const o = db.orders.find((x) => x.public_token === r.body.token)!;
    o.created_at = new Date(Date.now() - 25 * 60_000).toISOString();
    const { sendWhatsAppRecoveries } = await import('./services/whatsapp.js');
    const before = waSent.length;
    await sendWhatsAppRecoveries();
    const msgs = waSent.slice(before).filter((w) => String(w.body?.number ?? '').includes('33332222'));
    expect(msgs).toHaveLength(1);
    const text = msgs[0].body.text ?? msgs[0].body.textMessage?.text;
    // link curto e exclusivo (ex.: https://checkout.loja.com/r/aZ3kQg8) em vez do token de 48 caracteres
    const short = text.match(/https:\/\/checkout\.loja\.com\/r\/([0-9A-Za-z]+)/);
    expect(short).toBeTruthy();
    expect(short![1].length).toBeLessThanOrEqual(9);
    expect(text).not.toContain(r.body.token);
    expect(text).not.toContain('utm_');
    // ao abrir, leva para o Pix desta venda com a origem registrada
    const go = await fetch(`${base}/r/${short![1]}`, { redirect: 'manual' });
    expect(go.status).toBe(302);
    expect(go.headers.get('location')).toBe(`/pedido/${r.body.token}?utm_source=whatsapp&utm_medium=recovery`);
    expect(text).toContain(o.pix_code);
    expect(text).toContain('*Pack Etiquetas*'); // nome do produto no lembrete
    expect(text).toMatch(/Carla/);
    await sendWhatsAppRecoveries();
    const mine = () => waSent.slice(before).filter((w) => String(w.body?.number ?? '').includes('33332222'));
    expect(mine()).toHaveLength(1); // ainda não deu o tempo do 2º
    o.created_at = new Date(Date.now() - 200 * 60_000).toISOString(); // 3h20
    await sendWhatsAppRecoveries();
    expect(mine()).toHaveLength(2);
    const second = mine()[1].body.text ?? mine()[1].body.textMessage?.text;
    expect(second).not.toMatch(/último/i);
    o.created_at = new Date(Date.now() - 13 * 60 * 60_000).toISOString(); // 13h
    await sendWhatsAppRecoveries();
    expect(mine()).toHaveLength(3);
    const third = mine()[2].body.text ?? mine()[2].body.textMessage?.text;
    expect(third).toMatch(/SAIR/);
    o.created_at = new Date(Date.now() - 40 * 60 * 60_000).toISOString();
    await sendWhatsAppRecoveries();
    expect(mine()).toHaveLength(3); // nunca um 4º
  }, 15_000);
});

describe('Pix substituído e pago mesmo assim', () => {
  it('pedido cancelado (Pix trocado) que recebe o pagamento é reaberto, pago e entregue', async () => {
    const r = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Davi Reis', email: 'davi@x.com', phone: '11944443333' }, bump_ids: [], tracking: {} });
    const o = db.orders.find((x) => x.public_token === r.body.token)!;
    o.status = 'canceled';
    o.error = 'Substituído pelo pedido 9999999';
    charges.get(o.id)!.status = 'COMPLETED';
    await api('POST', '/api/webhooks/woovi', { charge: { correlationID: o.id } });
    await settle();
    expect(o.status).toBe('paid');
    const pub = await api('GET', `/api/public/orders/${r.body.token}`);
    expect(pub.body.delivery.length).toBeGreaterThan(0);
  });
});

describe('recuperação independente do WhatsApp', () => {
  it('Evolution fora do ar: o lembrete vai por e-mail (um por tentativa, sem repetir)', async () => {
    const r = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Bia Souza', email: 'bia@x.com', phone: '11955554444' }, bump_ids: [], tracking: {} });
    const o = db.orders.find((x) => x.public_token === r.body.token)!;
    o.created_at = new Date(Date.now() - 25 * 60_000).toISOString();
    const { sendWhatsAppRecoveries } = await import('./services/whatsapp.js');
    const { sendRecoveries } = await import('./services/jobs.js');
    const emails = () => db.integration_logs.filter((l) => l.integration === 'email' && l.order_id === o.id && String(l.event).startsWith('recovery'));
    evoDown = true;
    try {
      await sendWhatsAppRecoveries();
      expect(emails()).toHaveLength(1); // 1º lembrete foi por e-mail
      expect(emails()[0].event).toBe('recovery');
      expect(o.recovery_sent_at).toBeTruthy(); // a rotina de e-mail não manda outro igual
      const wa = db.integration_logs.find((l) => l.integration === 'whatsapp' && l.order_id === o.id && l.event === 'recovery_1')!;
      expect(wa.ok).toBe(false);
      o.created_at = new Date(Date.now() - 40 * 60_000).toISOString();
      await sendRecoveries();
      await sendWhatsAppRecoveries();
      expect(emails()).toHaveLength(1);
      o.created_at = new Date(Date.now() - 200 * 60_000).toISOString(); // 3h20 → 2º lembrete
      await sendWhatsAppRecoveries();
      expect(emails()).toHaveLength(2);
      expect(emails()[1].event).toBe('recovery_2');
    } finally {
      evoDown = false;
    }
  }, 15_000);
});

describe('Pix vencido renovado em um toque', () => {
  it('gera novo Pix da mesma compra e o link antigo leva ao novo', async () => {
    const r = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'João Lima', email: 'joao@x.com', phone: '11977776666' }, bump_ids: [], tracking: {} });
    const t1 = r.body.token;
    const o1 = db.orders.find((x) => x.public_token === t1)!;
    o1.expires_at = new Date(Date.now() - 60_000).toISOString();
    const ren = await api('POST', `/api/public/orders/${t1}/renew`);
    expect(ren.status).toBe(200);
    expect(ren.body.renewed).toBe(true);
    expect(ren.body.token).not.toBe(t1);
    expect(ren.body.order.total_cents).toBe(1999);
    expect(ren.body.order.pix_code).toBeTruthy();
    expect(db.orders.find((x) => x.id === o1.id)!.status).toBe('canceled');
    const old = await api('POST', `/api/public/orders/${t1}/renew`);
    expect(old.body.token).toBe(ren.body.token); // link antigo → Pix atual (ainda válido)
  });
  it('Pix ainda válido não é recriado', async () => {
    const r = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Ana Paula', email: 'ana@x.com', phone: '11966665555' }, bump_ids: [], tracking: {} });
    const ren = await api('POST', `/api/public/orders/${r.body.token}/renew`);
    expect(ren.body.renewed).toBe(false);
    expect(ren.body.token).toBe(r.body.token);
  });
});

describe('limite antiabuso não bloqueia vendas reais', () => {
  it('vários compradores no mesmo IP (CGNAT de operadora) compram normalmente', async () => {
    for (let i = 0; i < 12; i++) {
      const r = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: `Cliente ${i} Silva`, email: `cliente${i}@x.com`, phone: '11955554444' }, bump_ids: [], tracking: {} });
      expect(r.status).toBe(201);
    }
  });
  it('o mesmo comprador repetindo muitas vezes é limitado', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Robo Repetido', email: 'robo@x.com', phone: '11944443333' }, bump_ids: [], tracking: {} })).status);
    expect(codes.slice(0, 6).every((c) => c === 201)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});

describe('validações do checkout', () => {
  it('recusa telefone inválido, e-mail inválido e cupom inexistente', async () => {
    expect((await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Teste Nome', email: 't@x.com', phone: '123' }, tracking: {} })).status).toBe(400);
    expect((await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Teste Nome', email: 'invalido', phone: '11988887777' }, tracking: {} })).status).toBe(400);
    const q = await api('POST', '/api/public/checkouts/8931442/quote', { bump_ids: [], coupon_code: 'NAOEXISTE' });
    expect(q.body.coupon_error).toBeTruthy();
  });
  it('checkout inexistente responde 404 e token inválido é recusado', async () => {
    expect((await api('GET', '/api/public/checkouts/nao-existe')).status).toBe(404);
    expect((await api('GET', '/api/public/orders/xyz')).status).toBe(400);
  });
  it('rotas do painel exigem login', async () => {
    expect((await api('GET', '/api/admin/orders')).status).toBe(401);
    expect((await api('GET', '/api/admin/gateways')).status).toBe(401);
    // excluir cobrança também exige login (e só o dono pode)
    const before = db.orders.length;
    expect((await api('DELETE', `/api/admin/orders/${db.orders[0].id}`)).status).toBe(401);
    expect(db.orders.length).toBe(before);
  });
});

describe('criar cadastro (tela de login)', () => {
  it('registra o pedido para aprovação, sem criar acesso', async () => {
    const r = await api('POST', '/api/auth/request-access', { name: 'Pedro Alves', email: 'Pedro@X.com', phone: '11999990000', company: 'Loja do Pedro', message: 'Sou afiliado' });
    expect(r.status).toBe(200);
    const row = (db.access_requests ?? []).find((x) => x.email === 'pedro@x.com')!;
    expect(row).toMatchObject({ name: 'Pedro Alves', company: 'Loja do Pedro', ip: '187.10.20.30' });
    expect(row.status ?? 'pending').toBe('pending');
    expect((db.admins ?? []).length).toBe(0); // ninguém vira admin sozinho
  });
  it('pedido repetido não duplica e robô (campo invisível) é ignorado', async () => {
    const again = await api('POST', '/api/auth/request-access', { name: 'Pedro Alves', email: 'pedro@x.com' });
    expect(again.body.already).toBe(true);
    await api('POST', '/api/auth/request-access', { name: 'Robo Spam', email: 'spam@x.com', website: 'http://spam' });
    expect((db.access_requests ?? []).some((x) => x.email === 'spam@x.com')).toBe(false);
  });
  it('valida nome e e-mail', async () => {
    expect((await api('POST', '/api/auth/request-access', { name: 'A', email: 'x' })).status).toBe(400);
  });
});

describe('link curto do pedido', () => {
  it('código adulterado ou inventado não abre pedido nenhum', async () => {
    const { shortOrderCode } = await import('./lib/core.js');
    const o = db.orders[0];
    const code = shortOrderCode(o.number);
    const ok = await fetch(`${base}/p/${code}`, { redirect: 'manual' });
    expect(ok.headers.get('location')).toBe(`/pedido/${o.public_token}`);
    const tampered = code.slice(0, 4) + (code[4] === 'A' ? 'B' : 'A') + code.slice(5);
    expect((await fetch(`${base}/r/${tampered}`, { redirect: 'manual' })).headers.get('location')).toBe('/');
    expect((await fetch(`${base}/r/00000${'1'}`, { redirect: 'manual' })).headers.get('location')).toBe('/');
  });
});

describe('Pix sem duplicar para a mesma pessoa', () => {
  const buyer = { name: 'Bruna Costa', email: 'bruna@x.com', phone: '11922221111' };
  it('mesmo valor devolve o MESMO Pix; valor diferente gera outra cobrança e mantém a anterior', async () => {
    const a = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: buyer, bump_ids: [], tracking: {} });
    const b = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { ...buyer, email: 'BRUNA@x.com' }, bump_ids: [], tracking: {} });
    expect(b.body.token).toBe(a.body.token);
    expect(b.body.order.pix_code).toBe(a.body.order.pix_code);
    expect(db.orders.filter((o) => o.customer_id === db.orders.find((x) => x.public_token === a.body.token)!.customer_id && o.status === 'pending')).toHaveLength(1);

    // valor diferente (com order bump): cobrança nova e a anterior CONTINUA pendente
    const withBump = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: buyer, bump_ids: ['00000000-0000-4000-8000-0000000000b1'], tracking: {} });
    expect(withBump.body.token).not.toBe(a.body.token);
    await settle();
    expect(db.orders.find((x) => x.public_token === a.body.token)!.status).toBe('pending');
    expect(db.orders.find((x) => x.public_token === withBump.body.token)!.status).toBe('pending');
    // voltar ao valor sem bump reaproveita a primeira cobrança (continua só uma de cada valor)
    const back = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: buyer, bump_ids: [], tracking: {} });
    expect(back.body.token).toBe(a.body.token);
  });
  it('mesmo valor com Pix vencido: gera novo e substitui o antigo (só uma cobrança)', async () => {
    const buyer2 = { name: 'Caio Reis', email: 'caio@x.com', phone: '11911110000' };
    const a = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: buyer2, bump_ids: [], tracking: {} });
    db.orders.find((x) => x.public_token === a.body.token)!.expires_at = new Date(Date.now() - 1000).toISOString();
    const b = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: buyer2, bump_ids: [], tracking: {} });
    expect(b.body.token).not.toBe(a.body.token);
    // mesmo valor com Pix vencido: a nova substitui a antiga (fica só uma cobrança desse valor)
    await settle();
    expect(db.orders.find((x) => x.public_token === a.body.token)!.status).toBe('canceled');
    expect(db.orders.filter((x) => x.customer_id === db.orders.find((y) => y.public_token === b.body.token)!.customer_id && x.status === 'pending')).toHaveLength(1);
  });
});

describe('cobranças de valores diferentes da mesma pessoa', () => {
  it('ficam as duas no painel, mas a recuperação no WhatsApp lembra só da mais recente', async () => {
    const buyer = { name: 'Diego Lopes', email: 'diego@x.com', phone: '11900009999' };
    const a = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: buyer, bump_ids: [], tracking: {} });
    const b = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: buyer, bump_ids: ['00000000-0000-4000-8000-0000000000b1'], tracking: {} });
    expect(a.body.token).not.toBe(b.body.token);
    const oa = db.orders.find((x) => x.public_token === a.body.token)!;
    const ob = db.orders.find((x) => x.public_token === b.body.token)!;
    expect([oa.status, ob.status]).toEqual(['pending', 'pending']);
    oa.created_at = new Date(Date.now() - 30 * 60_000).toISOString();
    ob.created_at = new Date(Date.now() - 25 * 60_000).toISOString();
    const { sendWhatsAppRecoveries } = await import('./services/whatsapp.js');
    const before = waSent.length;
    await sendWhatsAppRecoveries();
    const mine = waSent.slice(before).filter((w) => String(w.body?.number ?? '').includes('00009999'));
    expect(mine).toHaveLength(1);
    expect(db.events.filter((e) => e.type === 'wa_recovery' && e.order_id === ob.id)).toHaveLength(1);
    expect(db.events.filter((e) => e.type === 'wa_recovery' && e.order_id === oa.id)).toHaveLength(0);
  }, 20_000);
});

describe('área de membros', () => {
  const P1 = '00000000-0000-4000-8000-000000000001';
  const P2 = '00000000-0000-4000-8000-000000000002';
  const P3 = '00000000-0000-4000-8000-000000000003';
  const mem = async (method: string, path: string, session?: string, body?: unknown) => {
    const r = await fetch(`${base}/api/members${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '187.10.20.99', ...(session ? { Authorization: `Member ${session}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };

  it('comprou o produto + order bump: entra pelo link do pedido, vê os 2 cursos e o terceiro bloqueado em "Cursos adicionais"', async () => {
    const saved = db.products.map((p) => ({ ...p }));
    const savedCk = [...db.checkouts];
    try {
      for (const p of db.products) p.members_enabled = true;
      db.checkouts.push({ id: '00000000-0000-4000-8000-0000000000c3', product_id: P3, slug: '7777777', name: 'Kit', price_cents: 2990, active: true, provider: 'woovi', theme: {}, fields: {}, tracking: {}, created_at: new Date().toISOString() });
      const now = new Date().toISOString();
      db.member_sections = [
        { id: '00000000-0000-4000-8000-00000000e001', product_id: P1, title: 'Sessão 1', sort: 0, created_at: now },
        { id: '00000000-0000-4000-8000-00000000e002', product_id: P2, title: 'Bônus', sort: 0, created_at: now },
        { id: '00000000-0000-4000-8000-00000000e003', product_id: P3, title: 'Convites', sort: 0, created_at: now },
      ];
      db.member_modules = [
        { id: '00000000-0000-4000-8000-00000000f001', product_id: P1, section_id: '00000000-0000-4000-8000-00000000e001', title: 'Comece aqui', subtitle: 'Preparando a base', cover_url: 'https://img/1.webp', sort: 0, created_at: now },
        { id: '00000000-0000-4000-8000-00000000f002', product_id: P1, section_id: '00000000-0000-4000-8000-00000000e001', title: 'Facebook Ads', subtitle: null, cover_url: null, sort: 1, created_at: now },
        { id: '00000000-0000-4000-8000-00000000f003', product_id: P2, section_id: '00000000-0000-4000-8000-00000000e002', title: 'Capas', subtitle: null, cover_url: null, sort: 0, created_at: now },
        { id: '00000000-0000-4000-8000-00000000f004', product_id: P3, section_id: '00000000-0000-4000-8000-00000000e003', title: 'Convites', subtitle: null, cover_url: 'https://img/3.webp', sort: 0, created_at: now },
      ];
      db.member_lessons = [
        { id: '00000000-0000-4000-8000-00000000a001', product_id: P1, module_id: '00000000-0000-4000-8000-00000000f001', title: 'Boas-vindas', video_url: 'https://youtu.be/abc', attachments: [{ name: 'PDF', url: 'https://x/a.pdf' }], sort: 0, created_at: now },
        { id: '00000000-0000-4000-8000-00000000a002', product_id: P1, module_id: '00000000-0000-4000-8000-00000000f001', title: 'Primeiros passos', video_url: null, attachments: [], sort: 1, created_at: now },
        { id: '00000000-0000-4000-8000-00000000a003', product_id: P3, module_id: '00000000-0000-4000-8000-00000000f004', title: 'Secreta', video_url: 'https://youtu.be/zzz', attachments: [], sort: 0, created_at: now },
      ];

      const r = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Lia Alves', email: 'lia@x.com', phone: '11922221111' }, bump_ids: ['00000000-0000-4000-8000-0000000000b1'], tracking: {} });
      const token = r.body.token;
      // antes de pagar: sem acesso
      expect((await mem('POST', '/login/order', undefined, { token })).status).toBe(403);
      const o = db.orders.find((x) => x.public_token === token)!;
      charges.get(o.id)!.status = 'COMPLETED';
      await api('POST', '/api/webhooks/woovi', { charge: { correlationID: o.id } });
      await settle();
      // a entrega aponta para a área de membros
      const pub = await api('GET', `/api/public/orders/${token}`);
      expect(pub.body.delivery[0].url).toBe(`https://checkout.loja.com/membros/entrar?o=${token}`);

      // conta do aluno criada na hora: login (e-mail) + senha aleatória no WhatsApp de entrega
      const wa = waSent.map((w) => String(w.body?.text ?? '')).find((t) => t.includes('lia@x.com'))!;
      expect(wa).toMatch(/Senha: \*[A-Za-z2-9]{4}-[A-Za-z2-9]{4}\*/);
      expect(wa).toContain('https://checkout.loja.com/membros/login');
      const senha = wa.match(/Senha: \*([^*]+)\*/)![1];
      expect(db.member_accounts.filter((a) => a.customer_id === o.customer_id)).toHaveLength(1);
      expect(db.member_accounts[0].password_hash).not.toContain(senha); // só o hash fica salvo
      expect((await mem('POST', '/login', undefined, { email: 'lia@x.com', password: 'errada-123' })).status).toBe(400);
      const byPass = await mem('POST', '/login', undefined, { email: 'LIA@x.com', password: senha });
      expect(byPass.status).toBe(200);
      // nova compra com área de membros: mesma conta e mesma senha
      const { ensureMemberAccess } = await import('./services/members.js');
      expect((await ensureMemberAccess(o.id))!.password).toBe(senha);
      // aluno troca a senha: a antiga para de funcionar e a nova entra
      expect((await mem('POST', '/password', byPass.body.token, { password: '123' })).status).toBe(400);
      expect((await mem('POST', '/password', byPass.body.token, { password: 'minhaSenhaNova' })).status).toBe(204);
      expect((await mem('POST', '/login', undefined, { email: 'lia@x.com', password: senha })).status).toBe(400);
      expect((await mem('POST', '/login', undefined, { email: 'lia@x.com', password: 'minhaSenhaNova' })).status).toBe(200);
      expect((await ensureMemberAccess(o.id))!.password).toBeNull(); // não reenviamos senha que o aluno escolheu

      const login = await mem('POST', '/login/order', undefined, { token });
      expect(login.status).toBe(200);
      const s = login.body.token;
      expect((await mem('GET', '/me')).status).toBe(401);
      expect((await mem('GET', '/me', 'falso.token')).status).toBe(401);
      const home = await mem('GET', '/me', s);
      expect(home.status).toBe(200);
      expect(home.body.courses.map((c: any) => c.name).sort()).toEqual(['Bônus Capas', 'Pack Etiquetas']); // bump vira curso
      const main = home.body.courses.find((c: any) => c.id === P1);
      expect(main.sections[0].modules.map((m: any) => m.title)).toEqual(['Comece aqui', 'Facebook Ads']);
      expect(main.progress).toEqual({ total: 2, completed: 0 });
      expect(home.body.extras).toHaveLength(1);
      expect(home.body.extras[0]).toMatchObject({ name: 'Kit Convites', checkout_url: '/checkout?produto_id=7777777', cover_url: 'https://img/3.webp' });

      // vitrine escolhida no painel: ordem, título, selo e preço próprios; quem já tem o produto não vê
      db.settings.push({ key: 'members', value: { offersTitle: 'Leve também', offersSubtitle: 'Só para alunos', offers: [{ product_id: P3, title: 'Kit Convites VIP', badge: 'Novo', description: '+100 modelos' }, { product_id: P1, title: 'Já comprado' }] } });
      const vit = await mem('GET', '/me', s);
      expect(vit.body.offers).toEqual({ title: 'Leve também', subtitle: 'Só para alunos' });
      expect(vit.body.extras).toHaveLength(1);
      expect(vit.body.extras[0]).toMatchObject({ name: 'Kit Convites VIP', badge: 'Novo', description: '+100 modelos', price_cents: 2990, checkout_url: '/checkout?produto_id=7777777' });
      db.settings = db.settings.filter((x) => x.key !== 'members');

      const mod = await mem('GET', '/modules/00000000-0000-4000-8000-00000000f001', s);
      expect(mod.body.lessons.map((l: any) => l.title)).toEqual(['Boas-vindas', 'Primeiros passos']);
      expect(mod.body.next_module.title).toBe('Facebook Ads');
      // curso não comprado: bloqueado
      expect((await mem('GET', '/modules/00000000-0000-4000-8000-00000000f004', s)).status).toBe(403);
      expect((await mem('POST', '/lessons/00000000-0000-4000-8000-00000000a003/progress', s, { done: true })).status).toBe(403);

      expect((await mem('POST', '/lessons/00000000-0000-4000-8000-00000000a001/progress', s, { done: true })).status).toBe(204);
      const after = await mem('GET', '/me', s);
      expect(after.body.courses.find((c: any) => c.id === P1).progress).toEqual({ total: 2, completed: 1 });

      // login por código: só gera código para quem é aluno; código errado é recusado
      expect((await mem('POST', '/login/code', undefined, { email: 'lia@x.com' })).status).toBe(200);
      expect((db.member_login_codes ?? []).filter((c) => c.email === 'lia@x.com')).toHaveLength(1);
      expect((await mem('POST', '/login/code', undefined, { email: 'ninguem@x.com' })).status).toBe(200);
      expect((db.member_login_codes ?? []).filter((c) => c.email === 'ninguem@x.com')).toHaveLength(0);
      const { hashCode } = await import('./services/members.js');
      db.member_login_codes.find((c) => c.email === 'lia@x.com')!.code_hash = hashCode('lia@x.com', '482913'); // código "recebido" no e-mail
      expect((await mem('POST', '/login/verify', undefined, { email: 'lia@x.com', code: '000000' })).status).toBe(400);
      const ok = await mem('POST', '/login/verify', undefined, { email: 'LIA@x.com', code: '482913' });
      expect(ok.status).toBe(200);
      expect((await mem('GET', '/me', ok.body.token)).body.courses).toHaveLength(2);
      expect((await mem('POST', '/login/verify', undefined, { email: 'lia@x.com', code: '482913' })).status).toBe(400); // uso único
    } finally {
      db.products = saved;
      db.checkouts = savedCk;
    }
  }, 15_000);
});


// =============================================================================
// MARKETPLACE: isolamento entre produtores, isenção da Prime e comissões
// =============================================================================
describe('marketplace multiusuário', () => {
  const OWNER_ORG = '0a000000-0000-4000-8000-000000000001';
  const B_ORG = '0b000000-0000-4000-8000-000000000002';
  const OWNER_USER = '0a000000-0000-4000-8000-0000000000aa';
  const B_USER = '0b000000-0000-4000-8000-0000000000bb';
  const B_PRODUCT = '0b000000-0000-4000-8000-0000000000p1'.replace('p1', 'a1');
  const B_BUMP_PRODUCT = '0b000000-0000-4000-8000-0000000000a2';
  const B_BUMP = '0b000000-0000-4000-8000-0000000000b1';
  const as = async (who: 'owner' | 'b', method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer tok-${who}`, 'X-Forwarded-For': '187.10.20.77' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  let bSlug = '';

  beforeAll(async () => {
    const now = new Date().toISOString();
    // migração: organização proprietária com todos os dados atuais + produtor B aprovado
    db.organizations = [
      { id: OWNER_ORG, name: 'Prime', status: 'active', is_platform_owner: true, split_enabled: true, pix_provider: null, recipient: {}, created_at: now },
      { id: B_ORG, name: 'Produtor B', status: 'active', is_platform_owner: false, split_enabled: false, pix_provider: null, recipient: {}, created_at: now },
    ];
    for (const t of ['products', 'checkouts', 'order_bumps', 'checkout_bumps', 'coupons', 'orders', 'events', 'upsells', 'invoices']) for (const r of db[t] ?? []) r.org_id ??= OWNER_ORG;
    db.admins = [{ user_id: OWNER_USER, role: 'owner', email: 'dono@prime.com' }];
    db.org_members = [{ org_id: OWNER_ORG, user_id: OWNER_USER, role: 'owner', email: 'dono@prime.com' }, { org_id: B_ORG, user_id: B_USER, role: 'owner', email: 'b@produtor.com' }];
    db.fee_policies = [{ id: 'fp-1', org_id: null, fixed_cents: 99, percent_bps: 0, bump_cents: 40, gateway_fee_payer: 'producer', refund_policy: 'keep_fee', created_at: '2026-01-01T00:00:00.000Z' }];
    db.ledger_entries = [];
    const { supabase } = await import('./lib/core.js');
    (supabase as any).auth.getUser = async (t: string) =>
      t === 'tok-owner' ? { data: { user: { id: OWNER_USER, email: 'dono@prime.com', factors: [] } }, error: null } : t === 'tok-b' ? { data: { user: { id: B_USER, email: 'b@produtor.com', factors: [] } }, error: null } : { data: { user: null }, error: { message: 'x' } };
    const { clearOwnerCache, clearOrgCache } = await import('./lib/tenant.js');
    clearOwnerCache();
    clearOrgCache();
    const { clearAuthCache } = await import('./middleware/auth.js');
    clearAuthCache();
  });

  it('produtor cria o próprio produto e não enxerga nada da Prime', async () => {
    const created = await as('b', 'POST', '/api/admin/products', { name: 'Curso do B', price_cents: 990, delivery_type: 'link', delivery_url: 'https://drive.google.com/b', active: true });
    expect(created.status).toBe(201);
    const p = db.products.find((x) => x.name === 'Curso do B')!;
    expect(p.org_id).toBe(B_ORG);
    bSlug = created.body.checkout.slug;
    expect(db.checkouts.find((c) => c.slug === bSlug)!.org_id).toBe(B_ORG);
    // bump do B (produto e bump dele)
    db.products.push({ id: B_BUMP_PRODUCT, org_id: B_ORG, number: 9001, name: 'Bônus do B', price_cents: 490, active: true, delivery_type: 'link', delivery_url: 'https://drive.google.com/b2', created_at: new Date().toISOString() });
    db.order_bumps.push({ id: B_BUMP, org_id: B_ORG, product_id: B_BUMP_PRODUCT, title: 'Bônus do B', price_cents: 490, active: true, created_at: new Date().toISOString() });
    db.checkout_bumps.push({ checkout_id: db.checkouts.find((c) => c.slug === bSlug)!.id, bump_id: B_BUMP, sort: 0, org_id: B_ORG });

    const mine = await as('b', 'GET', '/api/admin/products');
    expect(mine.body.map((x: any) => x.name).sort()).toEqual(['Bônus do B', 'Curso do B']);
    const ownerList = await as('owner', 'GET', '/api/admin/products');
    expect(ownerList.body.map((x: any) => x.name)).not.toContain('Curso do B');
    // ids da Prime na URL não funcionam para o produtor
    expect((await as('b', 'GET', '/api/admin/products/00000000-0000-4000-8000-000000000001')).status).toBe(404);
    const ownerOrder = db.orders.find((o) => o.org_id === OWNER_ORG)!;
    expect((await as('b', 'POST', `/api/admin/orders/${ownerOrder.id}/sync`)).status).toBe(404);
    expect((await as('b', 'GET', '/api/admin/orders')).body.data).toHaveLength(0);
    // configurações globais e da plataforma: só o Super Admin
    for (const path of ['/api/admin/gateways', '/api/admin/whatsapp', '/api/admin/platform/producers', '/api/admin/team', '/api/admin/integrations']) expect((await as('b', 'GET', path)).status).toBe(403);
    expect((await as('owner', 'GET', '/api/admin/platform/producers')).status).toBe(200);
    const me = await as('b', 'GET', '/api/admin/me');
    expect(me.body).toMatchObject({ superAdmin: false, org: { id: B_ORG, owner: false, sellingEnabled: false } });
    expect((await as('owner', 'GET', '/api/admin/me')).body).toMatchObject({ superAdmin: true, org: { id: OWNER_ORG, owner: true } });
  });

  it('venda do produtor fica bloqueada até o Super Admin liberar o recebimento', async () => {
    const r = await api('POST', '/api/public/orders', { checkout_slug: bSlug, customer: { name: 'Caio Lima', email: 'caio@x.com', phone: '11911112222' }, bump_ids: [], tracking: {} });
    expect(r.status).toBe(503);
    // liberar exige gateway + recebedor
    expect((await as('owner', 'PUT', `/api/admin/platform/producers/${B_ORG}`, { split_enabled: true })).status).toBe(400);
    const ok = await as('owner', 'PUT', `/api/admin/platform/producers/${B_ORG}`, { pix_provider: 'woovi', recipient: { pix_key: 'b@produtor.com', name: 'Produtor B' }, split_enabled: true });
    expect(ok.status).toBe(200);
    // a conta proprietária não pode ser suspensa
    expect((await as('owner', 'PUT', `/api/admin/platform/producers/${OWNER_ORG}`, { status: 'suspended' })).status).toBe(400);
    expect(db.audit_logs.some((a) => a.action === 'producer.update' && a.target === B_ORG)).toBe(true);
  });

  it('comissão: R$ 0,99 por venda + R$ 0,40 por bump para o produtor; webhook repetido não duplica', async () => {
    // PayTracking do produtor (tokens isolados): só ele recebe as vendas dele
    expect((await as('b', 'POST', '/api/admin/webhooks', { name: 'PT do B', preset: 'paytracking', url: `${ext}/paytracking-b`, token: 'tok-b', secret: '', events: ['sale.pending', 'sale.approved'], active: true })).status).toBeLessThan(300);
    expect(db.settings.find((x) => x.key === `webhooks@${B_ORG}`)).toBeTruthy();
    expect(db.settings.find((x) => x.key === 'webhooks')!.value.items.map((w: any) => w.url)).not.toContain(`${ext}/paytracking-b`);

    const ptOwnerBefore = ptCalls.length;
    const r = await api('POST', '/api/public/orders', { checkout_slug: bSlug, customer: { name: 'Caio Lima', email: 'caio@x.com', phone: '11911112222' }, bump_ids: [B_BUMP], tracking: {} });
    expect(r.status).toBe(201);
    const o = db.orders.find((x) => x.public_token === r.body.token)!;
    expect(o.org_id).toBe(B_ORG);
    expect(o.total_cents).toBe(1480);
    expect(o.platform_fee_cents).toBe(99 + 40);
    expect(o.fee_snapshot).toMatchObject({ owner_exempt: false, fixedCents: 99, bumpCents: 40 });
    // split na Woovi: a parte do produtor (total − comissão) vai direto para a chave Pix dele
    expect(charges.get(o.id)!.body.splits).toEqual([{ pixKey: 'b@produtor.com', value: 1480 - 139 }]);
    expect(o.split_status).toBe('pending');
    expect(o.split_info).toMatchObject({ gateway: 'woovi' });
    charges.get(o.id)!.status = 'COMPLETED';
    await api('POST', '/api/webhooks/woovi', { charge: { correlationID: o.id } });
    await api('POST', '/api/webhooks/woovi', { charge: { correlationID: o.id } }); // repetido
    await settle();
    expect(o.status).toBe('paid');
    const led = db.ledger_entries.filter((l) => l.order_id === o.id);
    expect(led.map((l) => [l.type, l.amount_cents]).sort()).toEqual([['platform_fee', -139], ['sale', 1480]]);
    // rastreamento: foi para o PayTracking do B e não para o da Prime
    expect(ptB.some((p) => p.event === 'sale.approved' && p.body.transaction_id === o.id)).toBe(true);
    expect(ptCalls.slice(ptOwnerBefore).some((p) => p.body.transaction_id === o.id)).toBe(false);
    // WhatsApp da plataforma não é usado para vendas de produtores
    expect(waSent.some((w) => String(w.body?.number ?? '').includes('911112222'))).toBe(false);

    const fin = await as('b', 'GET', '/api/admin/finance');
    expect(fin.body).toMatchObject({ owner: false, gross_cents: 1480, platform_fees_cents: 139, net_estimated_cents: 1341 });
  });

  it('Prime (proprietária) não paga comissão em nenhum cenário', async () => {
    const r = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Dona Prime', email: 'cliente-prime@x.com', phone: '11933334444' }, bump_ids: ['00000000-0000-4000-8000-0000000000b1'], tracking: {} });
    const o = db.orders.find((x) => x.public_token === r.body.token)!;
    expect(o.org_id).toBe(OWNER_ORG);
    expect(o.platform_fee_cents).toBe(0);
    expect(o.fee_snapshot.owner_exempt).toBe(true);
    charges.get(o.id)!.status = 'COMPLETED';
    await api('POST', '/api/webhooks/woovi', { charge: { correlationID: o.id } });
    await settle();
    expect(db.ledger_entries.filter((l) => l.order_id === o.id).map((l) => l.type)).toEqual(['sale']);
    expect(charges.get(o.id)!.body.splits).toBeUndefined(); // venda da Prime: sem split, recebe como sempre
    const fin = await as('owner', 'GET', '/api/admin/finance');
    expect(fin.body.owner).toBe(true);
    expect(fin.body.platform_fees_cents).toBe(0);
    // ninguém cria tabela de taxas para a conta proprietária
    expect((await as('owner', 'POST', '/api/admin/platform/fees', { org_id: OWNER_ORG, fixed_cents: 500, percent_bps: 0, bump_cents: 0 })).status).toBe(400);
    // produtor não cria taxas nem mexe em produtores
    expect((await as('b', 'POST', '/api/admin/platform/fees', { org_id: null, fixed_cents: 0, percent_bps: 0, bump_cents: 0 })).status).toBe(403);
  });

  it('nova tabela de taxas vale para as próximas vendas; as antigas mantêm a taxa da época', async () => {
    const before = db.orders.filter((x) => x.org_id === B_ORG).map((x) => [x.id, x.platform_fee_cents]);
    expect((await as('owner', 'POST', '/api/admin/platform/fees', { org_id: null, fixed_cents: 150, percent_bps: 100, bump_cents: 50 })).status).toBe(201);
    const r = await api('POST', '/api/public/orders', { checkout_slug: bSlug, customer: { name: 'Bia Nova', email: 'bia-nova@x.com', phone: '11955556666' }, bump_ids: [], tracking: {} });
    const o = db.orders.find((x) => x.public_token === r.body.token)!;
    expect(o.platform_fee_cents).toBe(150 + Math.round(990 * 0.01)); // R$ 1,50 + 1%
    for (const [id, fee] of before) expect(db.orders.find((x) => x.id === id)!.platform_fee_cents).toBe(fee);
  });

  it('cupom vale só no produtor que o criou', async () => {
    db.coupons.push({ id: '0b000000-0000-4000-8000-0000000000c9', org_id: B_ORG, code: 'BFIVE', type: 'fixed', value: 500, used_count: 0, min_cents: 0, active: true, created_at: new Date().toISOString() });
    expect((await api('POST', `/api/public/checkouts/${bSlug}/quote`, { bump_ids: [], coupon_code: 'BFIVE' })).body.discount_cents).toBe(500);
    expect((await api('POST', '/api/public/checkouts/8931442/quote', { bump_ids: [], coupon_code: 'BFIVE' })).body.coupon_error).toBeTruthy();
    expect((await api('POST', `/api/public/checkouts/${bSlug}/quote`, { bump_ids: [], coupon_code: 'DEZ' })).body.coupon_error).toBeTruthy();
  });

  it('cartão de crédito (Woovi): só quando o Super Admin liga; CPF obrigatório; página segura da Woovi; produtor sem split de cartão não vende no cartão', async () => {
    // desligado: não aparece e não é aceito
    expect((await api('GET', '/api/public/checkouts/8931442')).body.payment.card).toBeNull();
    expect((await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Lia Card', email: 'lia-card@x.com', phone: '11944445555', document: '52998224725' }, bump_ids: [], tracking: {}, payment_method: 'card' })).status).toBe(400);
    // produtor não liga o cartão
    expect((await as('b', 'PUT', '/api/admin/gateways/card', { enabled: true, provider: 'woovi', maxInstallments: 3 })).status).toBe(403);
    const on = await as('owner', 'PUT', '/api/admin/gateways/card', { enabled: true, provider: 'woovi', maxInstallments: 3 });
    expect(on.status).toBe(200);
    expect((await api('GET', '/api/public/checkouts/8931442')).body.payment.card).toEqual({ maxInstallments: 3, provider: 'woovi', efi: null });
    expect((await api('GET', `/api/public/checkouts/${bSlug}`)).body.payment.card).toBeNull(); // produtor: sem split de cartão
    // sem CPF: recusado
    expect((await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Lia Card', email: 'lia-card@x.com', phone: '11944445555' }, bump_ids: [], tracking: {}, payment_method: 'card' })).status).toBe(400);
    const r = await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Lia Card', email: 'lia-card@x.com', phone: '11944445555', document: '529.982.247-25' }, bump_ids: [], tracking: {}, payment_method: 'card' });
    expect(r.status).toBe(201);
    expect(r.body.order).toMatchObject({ payment_method: 'card', pix_code: null });
    expect(r.body.order.card_url).toBe(`https://woovi.test/card/${db.orders.find((x) => x.public_token === r.body.token)!.id}`);
    const o = db.orders.find((x) => x.public_token === r.body.token)!;
    expect(charges.get(o.id)!.body).toMatchObject({ type: 'CREDIT_CARD', cardInstallments: 3, customer: { taxID: '52998224725' } });
    expect((await api('GET', `/api/public/orders/${r.body.token}`)).body).toMatchObject({ payment_method: 'card', card_url: o.card_checkout_url });
    charges.get(o.id)!.status = 'COMPLETED';
    await api('POST', '/api/webhooks/woovi', { charge: { correlationID: o.id } });
    await settle();
    expect(o.status).toBe('paid');
    expect(db.ledger_entries.find((l) => l.order_id === o.id && l.type === 'sale')!.data).toMatchObject({ method: 'card' });
    // produtor no cartão: recusado (sem split de cartão)
    expect((await api('POST', '/api/public/orders', { checkout_slug: bSlug, customer: { name: 'Rui Card', email: 'rui-card@x.com', phone: '11944446666', document: '52998224725' }, bump_ids: [], tracking: {}, payment_method: 'card' })).status).toBe(400);
    await as('owner', 'PUT', '/api/admin/gateways/card', { enabled: false, provider: 'woovi', maxInstallments: 1 });
  });

  it('cartão pela Efí: token do navegador, aprovado na hora, recusado com motivo, verificação do banco + notificação, repasse ao produtor', async () => {
    process.env.EFI_COBRANCAS_URL = `${ext}/cob`;
    const g = db.settings.find((x) => x.key === 'gateways')!;
    g.value = { ...g.value, efi: { clientId: 'cid', clientSecret: 'csec', payeeCode: 'PAYEE-PRIME' } };
    const { refreshGateways } = await import('./services/gateways.js');
    await refreshGateways(true);
    expect((await as('owner', 'PUT', '/api/admin/gateways/card', { enabled: true, provider: 'efi', maxInstallments: 6 })).status).toBe(200);
    const pub = await api('GET', '/api/public/checkouts/8931442');
    expect(pub.body.payment.card).toEqual({ maxInstallments: 6, provider: 'efi', efi: { payeeCode: 'PAYEE-PRIME', sandbox: false } });
    const buy = (email: string, token: string, extra: any = {}) =>
      api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Bruno Efí', email, phone: '11955554444', document: '52998224725' }, bump_ids: [], tracking: {}, payment_method: 'card', card: { payment_token: token, tds_identifier: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6', installments: 3 }, ...extra });
    // sem o token do cartão: recusado (o número do cartão nunca vem para o servidor)
    expect((await api('POST', '/api/public/orders', { checkout_slug: '8931442', customer: { name: 'Bruno Efí', email: 'b1@x.com', phone: '11955554444', document: '52998224725' }, bump_ids: [], tracking: {}, payment_method: 'card' })).status).toBe(400);

    // aprovado na hora → pago, entregue e no livro-razão como cartão
    const ok = await buy('b-ok@x.com', 'tok-approve-1234567890');
    expect(ok.status).toBe(201);
    expect(ok.body.order.status).toBe('paid');
    const o1 = db.orders.find((x) => x.public_token === ok.body.token)!;
    expect(o1).toMatchObject({ status: 'paid', provider: 'efi', payment_method: 'card' });
    const sent = efiCharges.get(o1.provider_charge_id)!.body;
    expect(sent).toMatchObject({ installments: 3, payment_token: 'tok-approve-1234567890', customer: { cpf: '52998224725', email: 'b-ok@x.com', phone_number: '11955554444' }, metadata: { custom_id: o1.id, notification_url: 'https://checkout.loja.com/api/webhooks/efi-card' }, tds_info: { tds_identifier: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6', challenge_callback_url: `https://checkout.loja.com/api/public/orders/${o1.public_token}/3ds-return` } });
    expect(sent.items[0].marketplace).toBeUndefined(); // venda da Prime: sem repasse
    expect(db.ledger_entries.find((l) => l.order_id === o1.id && l.type === 'sale')!.data).toMatchObject({ method: 'card' });

    // recusado → 402 com o motivo; pedido falhou
    const no = await buy('b-no@x.com', 'tok-refuse-1234567890');
    expect(no.status).toBe(402);
    expect(no.body.error).toMatch(/G4 - Transação não autorizada/);
    expect(db.orders.filter((x) => db.customers.find((c) => c.id === x.customer_id)?.email === 'b-no@x.com').every((x) => x.status === 'failed')).toBe(true);

    // banco pede verificação (3DS) → pendente com os dados do desafio; a notificação da Efí aprova
    const ch = await buy('b-3ds@x.com', 'tok-challenge-1234567890');
    expect(ch.status).toBe(201);
    expect(ch.body.order).toMatchObject({ status: 'pending', tds_challenge: { action_url: 'https://acs.banco.test/3ds', creq: 'CREQ123', threeDSSessionData: 'SESS456' } });
    const o3 = db.orders.find((x) => x.public_token === ch.body.token)!;
    const back = await fetch(`${base}/api/public/orders/${o3.public_token}/3ds-return`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'cres=abc' });
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe(`/pedido/${o3.public_token}`);
    // notificação falsa (token que a Efí não conhece): nada muda
    await fetch(`${base}/api/webhooks/efi-card`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'notification=notif-999999' });
    await settle();
    expect(o3.status).toBe('pending');
    efiCharges.get(o3.provider_charge_id)!.status = 'paid';
    await fetch(`${base}/api/webhooks/efi-card`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `notification=notif-${o3.provider_charge_id}` });
    await settle();
    expect(o3.status).toBe('paid');

    // estorno/chargeback na Efí depois de pago → reembolsado + livro-razão
    efiCharges.get(o1.provider_charge_id)!.status = 'contested';
    await fetch(`${base}/api/webhooks/efi-card`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `notification=notif-${o1.provider_charge_id}` });
    await settle();
    expect(o1.status).toBe('refunded');
    expect(db.ledger_entries.some((l) => l.order_id === o1.id && l.type === 'chargeback')).toBe(true);

    // produtor: cartão só com o repasse para a conta Efí dele liberado pelo Super Admin
    expect((await api('GET', `/api/public/checkouts/${bSlug}`)).body.payment.card).toBeNull();
    expect((await as('owner', 'PUT', `/api/admin/platform/producers/${B_ORG}`, { card_split_enabled: true })).status).toBe(400); // sem payee_code
    expect((await as('owner', 'PUT', `/api/admin/platform/producers/${B_ORG}`, { recipient: { pix_key: 'b@produtor.com', name: 'Produtor B', payee_code: 'PAYEE-B' }, card_split_enabled: true })).status).toBe(200);
    expect((await api('GET', `/api/public/checkouts/${bSlug}`)).body.payment.card).toMatchObject({ provider: 'efi' });
    const pb = await api('POST', '/api/public/orders', { checkout_slug: bSlug, customer: { name: 'Tina Cartão', email: 'tina@x.com', phone: '11966665555', document: '52998224725' }, bump_ids: [], tracking: {}, payment_method: 'card', card: { payment_token: 'tok-approve-b-1234567', tds_identifier: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6', installments: 1 } });
    expect(pb.status).toBe(201);
    const ob = db.orders.find((x) => x.public_token === pb.body.token)!;
    expect(efiCharges.get(ob.provider_charge_id)!.body.items[0].marketplace).toEqual({ mode: 1, repasses: [{ payee_code: 'PAYEE-B', fixed: ob.total_cents - ob.platform_fee_cents }] });
    expect(ob.status).toBe('paid');

    await as('owner', 'PUT', '/api/admin/gateways/card', { enabled: false, provider: 'woovi', maxInstallments: 1 });
    delete process.env.EFI_COBRANCAS_URL;
  });

  it('editar o preço do produto muda o preço do checkout (mesmo com "preço neste checkout" antigo)', async () => {
    const ck = db.checkouts.find((c) => c.slug === '8931442')!;
    ck.price_cents = 100; // preço próprio antigo no checkout (R$ 1,00)
    expect((await api('GET', '/api/public/checkouts/8931442')).body.price_cents).toBe(100);
    const r = await as('owner', 'PUT', '/api/admin/products/00000000-0000-4000-8000-000000000001', { name: 'Pack Etiquetas', price_cents: 390 });
    expect(r.status).toBe(200);
    expect(ck.price_cents).toBeNull();
    expect((await api('GET', '/api/public/checkouts/8931442')).body.price_cents).toBe(390);
    expect((await api('POST', '/api/public/checkouts/8931442/quote', { bump_ids: [] })).body.total_cents).toBe(390);
    // salvar o produto sem mudar o preço não mexe num preço próprio definido depois
    ck.price_cents = 250;
    await as('owner', 'PUT', '/api/admin/products/00000000-0000-4000-8000-000000000001', { name: 'Pack Etiquetas', price_cents: 390 });
    expect(ck.price_cents).toBe(250);
    ck.price_cents = null;
    await as('owner', 'PUT', '/api/admin/products/00000000-0000-4000-8000-000000000001', { name: 'Pack Etiquetas', price_cents: 1999 });
  });

  it('produtor suspenso perde o acesso na hora', async () => {
    expect((await as('owner', 'PUT', `/api/admin/platform/producers/${B_ORG}`, { status: 'suspended' })).status).toBe(200);
    const me = await as('b', 'GET', '/api/admin/me');
    expect(me.status).toBe(403);
    expect(me.body.error).toMatch(/suspensa/);
    expect((await api('POST', '/api/public/orders', { checkout_slug: bSlug, customer: { name: 'José Souza', email: 'ze@x.com', phone: '11977778888' }, bump_ids: [], tracking: {} })).status).toBe(403);
  });
});
