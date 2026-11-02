import { describe, expect, it, vi } from 'vitest';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
process.env.PUBLIC_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-test-key-test-key';
process.env.NODE_ENV = 'test';
const { productCode } = await import('../lib/core.js');
const { buildPayload } = await import('./paytracking.js');

const order = {
  id: 'o1',
  number: 5,
  provider: 'efi',
  total_cents: 2990,
  created_at: new Date().toISOString(),
  ip: null,
  user_agent: null,
  tracking: {},
  checkout_slug: '8939361',
  customer: { name: 'Maria Souza', email: 'm@x.com', phone: null, document: null },
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
