import { describe, expect, it, vi } from 'vitest';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
process.env.PUBLIC_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-test-key-test-key';
process.env.NODE_ENV = 'test';
const { isValidCpf, isValidCnpj } = await import('./core.js');
const { signPayTracking } = await import('../services/paytracking.js');

describe('documentos', () => {
  it('valida CPF', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('123')).toBe(false);
  });
  it('valida CNPJ', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-80')).toBe(false);
  });
});

describe('PayTracking', () => {
  it('assina igual ao paytracking.php (hash_hmac sha256 de "ts.body")', () => {
    const { signature } = signPayTracking('{"a":1}', 'segredo', '1700000000');
    expect(signature).toBe('sha256=' + require('node:crypto').createHmac('sha256', 'segredo').update('1700000000.{"a":1}').digest('hex'));
  });
});
