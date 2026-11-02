import { describe, expect, it, vi } from 'vitest';
const sent: any[] = [];
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail: async (m: any) => sent.push(m) }) } }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { value: { store: { name: 'Loja Teste', supportEmail: 'suporte@loja.com', document: '' } } } }), insert: async () => ({}), then: (r: any) => r({ count: 0 }) };
    return { from: () => q };
  },
}));
process.env.PUBLIC_URL = 'https://checkout.loja.com';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-test-key-test-key';
process.env.SMTP_HOST = 'smtp.test';
process.env.SMTP_USER = 'vendas@loja.com';
process.env.SMTP_PASS = 'x';
process.env.NODE_ENV = 'test';
const { sendRecoveryEmail, unsubscribeSig } = await import('./email.js');

describe('e-mail de recuperação', () => {
  it('sai com texto, Reply-To, descadastro de 1 clique e assunto pessoal', async () => {
    const ok = await sendRecoveryEmail({ orderId: 'o1', to: 'Maria@x.com', name: 'maria souza', productName: 'Pack Etiquetas', extras: ['Bônus'], totalCents: 1999, url: 'https://checkout.loja.com/checkout?produto_id=1&recover=abc', guaranteeDays: 7 });
    expect(ok).toBe(true);
    const m = sent[0];
    expect(m.subject).toBe('Maria, seu pedido de Pack Etiquetas ficou pendente');
    expect(m.from.name).toBe('Loja Teste');
    expect(m.replyTo).toBe('suporte@loja.com');
    expect(m.text).toContain('Concluir meu pedido: https://checkout.loja.com/checkout');
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(m.headers['List-Unsubscribe']).toContain(unsubscribeSig('maria@x.com'));
    expect(m.html).not.toMatch(/URGENTE|GRÁTIS|!!!/);
    if (process.env.EMAIL_PREVIEW) (await import('node:fs')).writeFileSync(process.env.EMAIL_PREVIEW, m.html);
  });
});
