import { describe, expect, it, vi } from 'vitest';
import { maskPhone, nationalPhone } from '../../web/src/lib/format.js';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
process.env.PUBLIC_URL = 'https://x.com';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-test-key-test-key';
process.env.NODE_ENV = 'test';
const { normalizePhoneBR } = await import('./services/whatsapp.js');

/** Simula a pessoa digitando caractere por caractere no campo (máscara aplicada a cada tecla). */
const type = (text: string) => [...text].reduce((val, ch) => maskPhone(val + ch), '');

describe('telefone com ou sem 55 no checkout', () => {
  const formas = ['11988887777', '(11) 98888-7777', '5511988887777', '+55 11 98888-7777', '+55 (11) 98888-7777', '55 11 98888 7777', '005511988887777', '011988887777'];
  it.each(formas)('colado "%s" vira (11) 98888-7777 e chega no WhatsApp como 5511988887777', (raw) => {
    expect(maskPhone(raw)).toBe('(11) 98888-7777');
    expect(normalizePhoneBR(nationalPhone(maskPhone(raw)))).toBe('5511988887777');
  });
  it.each(['5511988887777', '+5511988887777', '11988887777', '551188887777'])('digitado "%s" tecla por tecla', (raw) => {
    const final = type(raw);
    expect(normalizePhoneBR(nationalPhone(final))).toBe(raw.endsWith('1188887777') && raw.length === 12 ? '551188887777' : '5511988887777');
  });
  it('DDD 55 (RS) sem código do país continua funcionando', () => {
    expect(maskPhone('55991234567')).toBe('(55) 99123-4567');
    expect(normalizePhoneBR(nationalPhone('55991234567'))).toBe('5555991234567');
    expect(maskPhone('+55 55 99123-4567')).toBe('(55) 99123-4567');
  });
  it('servidor aceita o número salvo com ou sem 55', () => {
    for (const v of ['11988887777', '5511988887777', '+55 11 98888-7777', '005511988887777', '55551198888777'.slice(0, 0) + '555511988887777']) expect(normalizePhoneBR(v)).toBe('5511988887777');
  });
});
