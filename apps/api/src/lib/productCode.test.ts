import { describe, expect, it, vi } from 'vitest';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
process.env.PUBLIC_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-test-key-test-key';
process.env.NODE_ENV = 'test';
const { productCode } = await import('./core.js');

describe('ID único do produto', () => {
  it('tem 7 dígitos e é estável', () => {
    expect(productCode(1001)).toMatch(/^\d{7}$/);
    expect(productCode(1001)).toBe(productCode(1001));
    expect(productCode(null)).toBe('');
  });
  it('nunca repete entre 1.001 e 500.000 produtos', () => {
    const seen = new Set<string>();
    for (let n = 1001; n <= 500_000; n++) seen.add(productCode(n));
    expect(seen.size).toBe(500_000 - 1001 + 1);
  });
  it('produtos seguidos não ficam com IDs parecidos', () => {
    expect(Math.abs(Number(productCode(1002)) - Number(productCode(1001)))).toBeGreaterThan(1000);
  });
});
