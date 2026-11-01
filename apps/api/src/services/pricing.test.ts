import { describe, expect, it } from 'vitest';
import { checkCoupon, computeTotals, type CouponRow } from './pricing.js';

const base: CouponRow = { id: 'c1', code: 'OFF10', type: 'percent', value: 10, max_uses: null, used_count: 0, min_cents: 0, checkout_id: null, expires_at: null, active: true };

describe('checkCoupon', () => {
  it('aplica desconto percentual', () => expect(checkCoupon(base, 'k', 19700)).toEqual({ ok: true, discountCents: 1970 }));
  it('aplica desconto fixo limitado ao subtotal', () => expect(checkCoupon({ ...base, type: 'fixed', value: 50000 }, 'k', 1000)).toEqual({ ok: true, discountCents: 1000 }));
  it('recusa cupom expirado', () => expect(checkCoupon({ ...base, expires_at: '2020-01-01T00:00:00Z' }, 'k', 1000).ok).toBe(false));
  it('recusa cupom esgotado', () => expect(checkCoupon({ ...base, max_uses: 2, used_count: 2 }, 'k', 1000).ok).toBe(false));
  it('recusa cupom de outro checkout', () => expect(checkCoupon({ ...base, checkout_id: 'outro' }, 'k', 1000).ok).toBe(false));
  it('recusa abaixo do mínimo', () => expect(checkCoupon({ ...base, min_cents: 5000 }, 'k', 1000).ok).toBe(false));
  it('recusa inativo/nulo', () => {
    expect(checkCoupon(null, 'k', 1000).ok).toBe(false);
    expect(checkCoupon({ ...base, active: false }, 'k', 1000).ok).toBe(false);
  });
});

describe('computeTotals', () => {
  it('soma produto + bumps', () => {
    const t = computeTotals([{ kind: 'main', name: 'A', price_cents: 9700 }, { kind: 'bump', name: 'B', price_cents: 1990 }], 0);
    expect(t).toEqual({ subtotalCents: 11690, discountCents: 0, totalCents: 11690 });
  });
  it('nunca gera total zero ou negativo', () => {
    const t = computeTotals([{ kind: 'main', name: 'A', price_cents: 1000 }], 99999);
    expect(t.totalCents).toBe(1);
  });
});
