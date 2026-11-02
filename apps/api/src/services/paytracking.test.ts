import { describe, expect, it, vi } from 'vitest';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
process.env.PUBLIC_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-test-key-test-key';
process.env.NODE_ENV = 'test';
const { productCode } = await import('../lib/core.js');
const { buildPayload } = await import('./paytracking.js');
const { clientIp, geoFromHeaders, phoneE164BR } = await import('../lib/core.js');

const order = {
  id: 'o1',
  number: 5,
  provider: 'efi',
  total_cents: 2990,
  created_at: new Date().toISOString(),
  ip: null,
  user_agent: null,
  tracking: { fbclid: 'AbC123', fbclid_at: '1700000000000', fbp: 'fb.1.1700000000000.123456789', utm_source: 'FB', src: 'x', initiate_checkout_event_id: 'ic_1', add_payment_info_event_id: 'api_1', purchase_event_id: 'purchase_1', geo_city: 'Fortaleza', geo_state: 'CE', geo_zip: '60000000', geo_country: 'BR' } as Record<string, any>,
  checkout_slug: '8939361',
  customer_id: 'cust-1',
  customer: { name: 'Maria Souza', email: ' M@X.com ', phone: '(11) 98888-7777', document: null },
  items: [
    { kind: 'main', name: 'Pack', price_cents: 1999, product_id: 'uuid-main', bump_id: null, product: { number: 1002 } },
    { kind: 'bump', name: 'Extra', price_cents: 991, product_id: 'uuid-bump', bump_id: 'b1', product: { number: 1003 } },
  ],
};

describe('PayTracking: ID do produto casa com o pixel', () => {
  it('envia o ID de 7 dígitos do painel como product_id', () => {
    const p = buildPayload(order, 'sale.approved');
    expect(p.product_id).toBe(productCode(1002));
    expect(p.product_id).toMatch(/^\d{7}$/);
    expect(p.product_uuid).toBe('uuid-main');
    expect(p.product_ids).toEqual([productCode(1002), productCode(1003)]);
    expect(p.products[1].id).toBe(productCode(1003));
  });
});

describe('taxa de correspondência (dados enviados)', () => {
  it('telefone com 55, e-mail normalizado, external_id estável, fbc pelo horário do clique', () => {
    const p = buildPayload(order, 'sale.approved');
    expect(p.customer.phone).toBe('5511988887777');
    expect(p.customer.email).toBe('m@x.com');
    expect(p.customer.external_id).toBe('cust-1');
    expect(p.tracking.fbc).toBe('fb.1.1700000000000.AbC123');
    expect(p.tracking.fbp).toBe('fb.1.1700000000000.123456789');
    expect(p.content_ids).toHaveLength(2);
    expect(p.num_items).toBe(2);
    expect(p.tracking.src).toBe('x');
  });
  it('phoneE164BR e IP real atrás de proxy', () => {
    expect(phoneE164BR('11 98888-7777')).toBe('5511988887777');
    expect(phoneE164BR('5511988887777')).toBe('5511988887777');
    expect(phoneE164BR('123')).toBeNull();
    expect(clientIp({ ip: '10.0.0.5', headers: { 'x-forwarded-for': '10.0.0.2, 187.10.20.30, 172.16.0.1' } })).toBe('187.10.20.30');
    expect(clientIp({ ip: '10.0.0.5', headers: { 'cf-connecting-ip': '2804:14c::1' } })).toBe('2804:14c::1');
    expect(clientIp({ ip: '::ffff:189.1.2.3', headers: {} })).toBe('189.1.2.3');
  });
});

describe('deduplicação e localização', () => {
  it('leva os IDs de todos os eventos, cidade/estado/CEP e action_source', () => {
    const p = buildPayload(order, 'sale.approved');
    expect(p.tracking.event_id).toBe('purchase_1');
    expect(p.tracking.initiate_checkout_event_id).toBe('ic_1');
    expect(p.tracking.add_payment_info_event_id).toBe('api_1');
    expect(buildPayload(order, 'sale.pending').tracking.event_id).toBe('ic_1');
    expect(p.customer.city).toBe('Fortaleza');
    expect(p.customer.state).toBe('CE');
    expect(p.customer.zip).toBe('60000000');
    expect(p.action_source).toBe('website');
  });
  it('lê a localização dos cabeçalhos da CDN', () => {
    expect(geoFromHeaders({ 'cf-ipcity': 'S%C3%A3o%20Paulo', 'cf-region-code': 'SP', 'cf-postal-code': '01000-000', 'cf-ipcountry': 'br' })).toEqual({ geo_city: 'São Paulo', geo_state: 'SP', geo_zip: '01000000', geo_country: 'BR' });
    expect(geoFromHeaders({})).toEqual({});
  });
});
