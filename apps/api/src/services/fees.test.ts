import { describe, expect, it } from 'vitest';
process.env.PUBLIC_URL ??= 'https://checkout.loja.com';
process.env.SUPABASE_URL ??= 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-key-test-key-test-key';
const { computeFee } = await import('./fees.js');

const policy = { fixed_cents: 99, percent_bps: 0, bump_cents: 40 };
const main = { kind: 'main', price_cents: 990 };
const bump = { kind: 'bump', price_cents: 490 };

describe('motor de taxas', () => {
  it('produtor comum: R$ 0,99 por venda + R$ 0,40 por order bump', () => {
    expect(computeFee(policy, [main], 990, false).platformFeeCents).toBe(99);
    expect(computeFee(policy, [main, bump], 1480, false).platformFeeCents).toBe(139);
    expect(computeFee(policy, [main, bump, bump], 1970, false).platformFeeCents).toBe(179);
  });
  it('conta proprietária: R$ 0,00 em qualquer cenário', () => {
    expect(computeFee(policy, [main, bump, bump], 1970, true).platformFeeCents).toBe(0);
    expect(computeFee({ fixed_cents: 5000, percent_bps: 5000, bump_cents: 5000 }, [main, bump], 1480, true).platformFeeCents).toBe(0);
  });
  it('percentual em centavos inteiros e nunca maior que a venda', () => {
    expect(computeFee({ fixed_cents: 0, percent_bps: 250, bump_cents: 0 }, [main], 1999, false).platformFeeCents).toBe(50); // 2,5% de 19,99
    expect(computeFee({ fixed_cents: 99, percent_bps: 0, bump_cents: 40 }, [main], 50, false).platformFeeCents).toBe(50);
  });
  it('sem política: sem comissão', () => {
    expect(computeFee(null, [main], 990, false).platformFeeCents).toBe(0);
  });
});
