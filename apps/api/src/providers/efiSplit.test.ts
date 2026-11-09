import { describe, expect, it } from 'vitest';
process.env.PUBLIC_URL ??= 'https://checkout.loja.com';
process.env.SUPABASE_URL ??= 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-key-test-key-test-key';
const { EfiProvider } = await import('./efi.js');

/** Efí: split Pix só entre contas Efí, com valores fixos que fecham o total (dev.efipay.com.br/docs/api-pix/split-de-pagamento-pix). */
function fakeEfi(failLink = false) {
  const p: any = new EfiProvider();
  const calls: { method: string; path: string; body?: any }[] = [];
  p.authed = async (method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    if (path === '/v2/gn/split/config') return { id: 'cfg123', status: 'ATIVA' };
    if (path.startsWith('/v2/cob/') && method === 'PUT') return { txid: path.split('/').pop(), pixCopiaECola: '000201PIXEFI' };
    if (path.includes('/vinculo/') && failLink) throw new Error('SplitOperacaoInvalida');
    return {};
  };
  return { p, calls };
}
const input = (split: any) => ({ orderId: '11111111-2222-3333-4444-555555555555', amountCents: 1480, description: 'Pedido #1 - Curso', expiresInSeconds: 7200, customer: { name: 'Ana', email: 'a@x.com' }, split });

describe('split Pix na Efí', () => {
  it('cria a configuração (comissão da Prime + parte do produtor), a cobrança e o vínculo', async () => {
    const { p, calls } = fakeEfi();
    const r = await p.createCharge(input({ producerCents: 1341, platformCents: 139, recipient: { account: '1234567', document: '123.456.789-09' } }));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v2/gn/split/config', 'PUT /v2/cob/11111111222233334444555555555555', 'PUT /v2/gn/split/cob/11111111222233334444555555555555/vinculo/cfg123']);
    expect(calls[0].body).toEqual({
      descricao: 'Pedido #1 - Curso',
      lancamento: { imediato: true },
      split: { divisaoTarifa: 'assumir_total', minhaParte: { tipo: 'fixo', valor: '1.39' }, repasses: [{ tipo: 'fixo', valor: '13.41', favorecido: { cpf: '12345678909', conta: '1234567' } }] },
    });
    expect(r.splitInfo).toMatchObject({ gateway: 'efi', splitConfigId: 'cfg123' });
  });
  it('CNPJ do produtor vai como cnpj', async () => {
    const { p, calls } = fakeEfi();
    await p.createCharge(input({ producerCents: 1341, platformCents: 139, recipient: { account: '7654321', document: '32.916.731/0001-78' } }));
    expect(calls[0].body.split.repasses[0].favorecido).toEqual({ cnpj: '32916731000178', conta: '7654321' });
  });
  it('se a Efí recusar o vínculo, cancela a cobrança e não devolve Pix (o dinheiro do produtor não cai na conta da Prime)', async () => {
    const { p, calls } = fakeEfi(true);
    await expect(p.createCharge(input({ producerCents: 1341, platformCents: 139, recipient: { account: '1234567', document: '12345678909' } }))).rejects.toThrow(/recusou o split/);
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' } });
  });
  it('recusa recebedor incompleto ou valores que não fecham o total', async () => {
    await expect(fakeEfi().p.createCharge(input({ producerCents: 1341, platformCents: 139, recipient: { account: '', document: '12345678909' } }))).rejects.toThrow(/incompleto/);
    await expect(fakeEfi().p.createCharge(input({ producerCents: 1000, platformCents: 139, recipient: { account: '1', document: '12345678909' } }))).rejects.toThrow(/não fecham/);
  });
  it('cartão pela Efí ainda não: recusa com mensagem clara', async () => {
    await expect(fakeEfi().p.createCharge({ ...input(null), method: 'card' })).rejects.toThrow(/Efí ainda não/);
  });
});
