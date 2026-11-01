import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
process.env.PUBLIC_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-test-key-test-key';
process.env.NODE_ENV = 'test';
const { validatePfx } = await import('./gateways.js');

function makeP12(pass: string): Buffer | null {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p12-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=teste'], { stdio: 'ignore' });
    execFileSync('openssl', ['pkcs12', '-export', '-inkey', `${dir}/k.pem`, '-in', `${dir}/c.pem`, '-out', `${dir}/c.p12`, '-passout', `pass:${pass}`], { stdio: 'ignore' });
    return fs.readFileSync(`${dir}/c.p12`);
  } catch {
    return null;
  }
}

describe('validação do certificado .p12 da Efí', () => {
  const p12 = makeP12('');
  const p12pass = makeP12('segredo');
  it.skipIf(!p12)('aceita certificado válido sem senha', () => expect(validatePfx(p12!, '')).toBeNull());
  it.skipIf(!p12pass)('aceita com a senha certa e recusa a errada', () => {
    expect(validatePfx(p12pass!, 'segredo')).toBeNull();
    expect(validatePfx(p12pass!, 'errada')).toMatch(/senha|inválido/i);
  });
  it('recusa arquivo que não é certificado', () => expect(validatePfx(Buffer.from('nao sou um p12'.repeat(20)), '')).not.toBeNull());
});
