import { beforeEach, describe, expect, it, vi } from 'vitest';

const zone: Record<string, string[][]> = {};
vi.mock('node:dns/promises', () => ({
  default: {
    resolveTxt: async (n: string) => {
      if (!zone[n]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return zone[n];
    },
    resolveMx: async (n: string) => (zone[`MX:${n}`] ? [{ exchange: 'mx1.hostinger.com', priority: 5 }] : []),
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

async function run(envVars: Record<string, string>) {
  vi.resetModules();
  Object.assign(process.env, { PUBLIC_URL: 'https://x.com', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key-test-key-test-key', NODE_ENV: 'test', SMTP_HOST: 'smtp.hostinger.com', SMTP_PASS: 'x', MAIL_FROM: '', ...envVars });
  const { emailDeliverability } = await import('./deliverability.js');
  return emailDeliverability();
}
const status = (r: any, id: string) => r.checks.find((c: any) => c.id === id)?.status;

describe('verificador anti-spam', () => {
  beforeEach(() => Object.keys(zone).forEach((k) => delete zone[k]));

  it('domínio bem configurado tira 10', async () => {
    zone['loja.com.br'] = [['v=spf1 include:_spf.mail.hostinger.com ~all']];
    zone['hostingermail1._domainkey.loja.com.br'] = [['v=DKIM1; k=rsa; p=MIGf...']];
    zone['_dmarc.loja.com.br'] = [['v=DMARC1; p=none']];
    zone['MX:loja.com.br'] = [['x']];
    const r = await run({ SMTP_USER: 'vendas@loja.com.br' });
    expect(r.score).toBe(10);
    expect(r.checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('sem DKIM e DMARC: aponta os dois e entrega o registro do DMARC pronto', async () => {
    zone['loja.com.br'] = [['v=spf1 include:_spf.mail.hostinger.com ~all']];
    const r = await run({ SMTP_USER: 'vendas@loja.com.br' });
    expect(status(r, 'dkim')).toBe('error');
    expect(status(r, 'dmarc')).toBe('error');
    expect(r.checks.find((c) => c.id === 'dmarc')!.record).toMatchObject({ type: 'TXT', name: '_dmarc' });
    expect(r.score).toBeLessThan(9);
  });

  it('e-mail gratuito, remetente desalinhado e SPF duplicado são erros', async () => {
    zone['gmail.com'] = [['v=spf1 redirect=_spf.google.com']];
    expect(status(await run({ SMTP_USER: 'loja@gmail.com' }), 'free')).toBe('error');
    zone['loja.com.br'] = [['v=spf1 include:a ~all'], ['v=spf1 include:_spf.mail.hostinger.com ~all']];
    const r = await run({ SMTP_USER: 'vendas@loja.com.br', MAIL_FROM: 'contato@outra.com.br' });
    expect(status(r, 'align')).toBe('error');
    const r2 = await run({ SMTP_USER: 'vendas@loja.com.br' });
    expect(status(r2, 'spf')).toBe('error');
    expect(r2.checks.find((c) => c.id === 'spf')!.detail).toMatch(/2 registros SPF/);
  });

  it('SPF sem a Hostinger sugere o registro corrigido', async () => {
    zone['loja.com.br'] = [['v=spf1 include:_spf.google.com ~all']];
    const r = await run({ SMTP_USER: 'vendas@loja.com.br' });
    expect(r.checks.find((c) => c.id === 'spf')!.record!.value).toBe('v=spf1 include:_spf.google.com include:_spf.mail.hostinger.com ~all');
  });
});
