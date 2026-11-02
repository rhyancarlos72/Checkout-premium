import { describe, expect, it, vi } from 'vitest';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
process.env.PUBLIC_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-test-key-test-key';
process.env.NODE_ENV = 'test';
const inv = await import('./invoices.js');

const order = {
  id: '6f1c2c1e-0000-4000-8000-000000000001',
  number: 1001,
  total_cents: 2990, // 19,99 + bump 9,91
  customer: { name: 'Maria Souza', email: 'maria@x.com', phone: '(11) 98888-7777', document: null },
  items: [
    { kind: 'main', name: 'Pack Etiquetas', price_cents: 1999 },
    { kind: 'bump', name: 'Bônus Capas', price_cents: 991 },
  ],
};
const s = inv.invoiceSettingsSchema.parse({ apiKey: 'k' });

describe('Spedy: uma nota por venda', () => {
  it('NFS-e: valor total com order bumps menos R$ 0,50, descrição única e idempotência', () => {
    const p = inv.buildServicePayload(order, s);
    expect(p.amount).toBe(29.4);
    expect(p.total.invoiceAmount).toBe(29.4);
    expect(p.description).toContain('Pack Etiquetas + Bônus Capas');
    expect(p.integrationId).toBe(order.id);
    expect(p.receiver.phoneNumber).toBe('5511988887777');
    expect(p.federalServiceCode).toBe('1.09');
  });
  it('NF-e: um único item com o valor da venda inteira', () => {
    const p = inv.buildProductPayload(order, inv.invoiceSettingsSchema.parse({ type: 'product', apiKey: 'k', deductCents: 0 }));
    expect(p.items).toHaveLength(1);
    expect(p.items[0].amount).toBe(29.9);
    expect(p.total.invoiceValue).toBe(29.9);
    expect(p.payments[0]).toEqual({ type: 'pix', value: 29.9 });
    expect(p.integrationId).toBe(order.id);
  });
  it('mapeia status da Spedy', () => {
    expect(inv.mapSpedyStatus('authorized')).toBe('issued');
    expect(inv.mapSpedyStatus('enqueued')).toBe('processing');
    expect(inv.mapSpedyStatus('rejected')).toBe('error');
    expect(inv.mapSpedyStatus('canceled')).toBe('canceled');
  });
});
