import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
process.env.PUBLIC_URL = 'https://example.com';
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-test-key-test-key';
process.env.NODE_ENV = 'test';
const wa = await import('./whatsapp.js');

const calls: { path: string; apikey?: string; body: any }[] = [];
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    calls.push({ path: req.url!, apikey: req.headers.apikey as string, body: b ? JSON.parse(b) : null });
    if (req.url === '/instance/fetchInstances') {
      if (req.headers.apikey !== 'GLOBAL' && req.headers.apikey !== 'V1') return res.writeHead(401).end('{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        req.headers.apikey === 'V1'
          ? JSON.stringify([{ instance: { instanceName: 'vendas01', owner: '5511912345678@s.whatsapp.net', profileName: 'Loja', status: 'open', apikey: 'tok-v1' } }])
          : JSON.stringify([
              { name: 'Checkout-A', connectionStatus: 'open', ownerJid: '5521988887777@s.whatsapp.net', profileName: 'Loja A', token: 'tok-a' },
              { name: 'checkout-b', connectionStatus: 'close', ownerJid: null, token: 'tok-b' },
            ]),
      );
    }
    if (req.url!.startsWith('/message/sendText/fantasma')) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"status":404,"error":"Not Found","response":{"message":["The \\"fantasma\\" instance does not exist"]}}');
    if (req.headers.apikey === 'bad') return res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"message":"Unauthorized"}');
    if (req.url!.endsWith('/naoexiste')) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"message":"not found"}');
    if (req.url!.includes('/sendText/') && req.body === undefined && JSON.stringify(b).includes('5511900000000')) {
      return res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"response":{"message":[{"exists":false,"number":"5511900000000"}]}}');
    }
    if (req.url!.startsWith('/instance/connectionState/')) {
      const name = req.url!.split('/').pop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ instance: { state: name === 'off' ? 'close' : 'open' } }));
    }
    if (req.url!.includes('/sendText/quebrada')) return res.writeHead(500).end('{"message":"erro interno"}');
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end('{"key":{"id":"x"}}');
  });
});
let url = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

const cfg = (instances: { name: string; token: string; active?: boolean }[]) =>
  wa.whatsappSchema.parse({ enabled: true, apiUrl: url, instances: instances.map((i) => ({ active: true, ...i })) });

describe('telefone e texto', () => {
  it('normaliza telefone brasileiro', () => {
    expect(wa.normalizePhoneBR('(11) 98888-7777')).toBe('5511988887777');
    expect(wa.normalizePhoneBR('5511988887777')).toBe('5511988887777');
    expect(wa.normalizePhoneBR('555511988887777')).toBe('5511988887777');
    expect(wa.normalizePhoneBR('123')).toBe('');
  });
  it('gera variantes com e sem o 9º dígito', () => {
    expect(wa.phoneVariants('5511988887777')).toEqual(['5511988887777', '551188887777']);
    expect(wa.phoneVariants('551188887777')).toEqual(['551188887777', '5511988887777']);
  });
  it('remove caracteres invisíveis sem zerar o texto', () => {
    expect(wa.sanitizeText('Olá​ mundo﻿\r\n')).toBe('Olá mundo');
  });
});

describe('mensagens (porta do checkout antigo)', () => {
  it('aprovado: nome, valor, produto, links dos adicionais e opt-out', () => {
    const m = wa.buildApprovedMessage({ phone: '5511900000001', name: 'Maria Silva', totalCents: 11690, items: [{ name: 'Curso X', url: 'https://a', kind: 'main' }, { name: 'Bônus Y', url: 'https://b', kind: 'bump' }] });
    expect(m).toContain('Maria');
    expect(m).toContain('R$ 116,90');
    expect(m).toContain('Curso X');
    expect(m).toContain('https://b');
    expect(m).toContain('responda SAIR');
  });
  it('aprovado: link do Drive do produto e nome do cliente com inicial maiúscula', () => {
    const m = wa.buildApprovedMessage({ phone: '5511900000009', name: 'rhyan carlos', totalCents: 1999, items: [{ name: 'Pack Etiquetas', url: 'https://drive.google.com/drive/folders/abc', note: 'Baixe a pasta inteira.', kind: 'main' }], accessUrl: 'https://loja.com/pedido/t' });
    expect(m).toContain('Rhyan');
    expect(m).toContain('*Pack Etiquetas*');
    expect(m).toContain('https://drive.google.com/drive/folders/abc');
    expect(m).toContain('Baixe a pasta inteira.');
    // sem link cadastrado, manda a página de acessos do pedido
    const sem = wa.buildApprovedMessage({ phone: '5511900000010', name: 'Ana', totalCents: 100, items: [{ name: 'P', url: null, kind: 'main' }], accessUrl: 'https://loja.com/pedido/t' });
    expect(sem).toContain('https://loja.com/pedido/t');
  });
  it('recuperação: link e Pix copia e cola na mesma mensagem', () => {
    const m = wa.buildRecoveryMessage({ phone: '5511900000002', name: 'João', link: 'https://link', attempt: 1, pixCode: '000201PIX' });
    expect(m).toContain('João');
    expect(m).toContain('https://link');
    expect(m).toContain('000201PIX');
  });
  it('rodízio de modelos: mensagens seguidas para clientes diferentes não saem iguais', () => {
    const skel = (m: string, nome: string) => m.replaceAll(nome, 'X');
    const ap = Array.from({ length: 12 }, (_, i) => skel(wa.buildApprovedMessage({ phone: `55119000001${String(i).padStart(2, '0')}`, name: 'Cliente', totalCents: 1999, items: [{ name: 'P', url: 'https://d', kind: 'main' }] }), 'Cliente'));
    for (let i = 1; i < ap.length; i++) expect(ap[i]).not.toBe(ap[i - 1]);
    expect(new Set(ap).size).toBe(12);
    const rc = Array.from({ length: 12 }, (_, i) => skel(wa.buildRecoveryMessage({ phone: `55119000002${String(i).padStart(2, '0')}`, name: 'Cliente', link: 'https://l', attempt: 1, pixCode: 'PIX' }), 'Cliente'));
    expect(new Set(rc).size).toBe(12);
    expect(rc.every((m) => m.includes('https://l') && m.includes('PIX') && m.includes('SAIR'))).toBe(true);
  });
  it('não repete a mesma saudação seguida para o mesmo telefone', () => {
    const first = (n: number) => wa.buildApprovedMessage({ phone: '5511900000003', name: 'Ana', totalCents: 100, items: [{ name: 'P', url: null }] }).split('\n')[0] + n;
    const a = first(0).slice(0, -1);
    const b = first(1).slice(0, -1);
    expect(a).not.toBe(b);
  });
});

describe('envio pela Evolution API', () => {
  it('pula instância offline e cai para a próxima quando uma falha', async () => {
    calls.length = 0;
    const r = await wa.sendWhatsAppText('11988887777', 'Mensagem de teste 1', cfg([{ name: 'off', token: 't0' }, { name: 'quebrada', token: 't1' }, { name: 'boa', token: 't2' }]));
    expect(r).toMatchObject({ ok: true, instance: 'boa' });
    const sent = calls.find((c) => c.path === '/message/sendText/boa');
    expect(sent?.apikey).toBe('t2');
    expect(sent?.body).toMatchObject({ number: '5511988887777', text: 'Mensagem de teste 1' });
    expect(calls.some((c) => c.path === '/message/sendText/off')).toBe(false);
  });
  it('alterna entre instâncias (rodízio)', async () => {
    const c = cfg([{ name: 'a1', token: 'x' }, { name: 'a2', token: 'y' }]);
    const r1 = await wa.sendWhatsAppText('11988887777', 'Texto A', c);
    const r2 = await wa.sendWhatsAppText('11988887777', 'Texto B', c);
    expect(r1.ok && r2.ok).toBe(true);
    expect(r1.instance).not.toBe(r2.instance);
  });
  it('rodízio justo com 3 instâncias: usa sempre a que está há mais tempo sem enviar', async () => {
    const c = cfg([{ name: 'r1', token: 'x' }, { name: 'r2', token: 'y' }, { name: 'r3', token: 'z' }]);
    const used: string[] = [];
    for (let i = 0; i < 6; i++) used.push((await wa.sendWhatsAppText('11988887777', `Mensagem ${i}`, c)).instance!);
    expect(used.slice(0, 3).sort()).toEqual(['r1', 'r2', 'r3']);
    expect(used.slice(3)).toEqual(used.slice(0, 3)); // mesma ordem na segunda volta: nenhuma repete antes das outras
  });
  it('explica quando não há instância configurada', async () => {
    expect((await wa.sendWhatsAppText('11988887777', 'x', cfg([]))).ok).toBe(false);
  });
});

describe('mensagens de erro para corrigir no painel', () => {
  it('token recusado', async () => {
    const c = await wa.checkInstance(cfg([]), { name: 'x', token: 'bad' });
    expect(c.ok).toBe(false);
    expect(c.message).toMatch(/Token recusado/);
    expect(c.hint).toMatch(/apikey/);
  });
  it('instância com nome errado', async () => {
    const c = await wa.checkInstance(cfg([]), { name: 'naoexiste', token: 't' });
    expect(c.message).toMatch(/não encontrada/);
  });
  it('WhatsApp desconectado (QR Code)', async () => {
    const c = await wa.checkInstance(cfg([]), { name: 'off', token: 't' });
    expect(c.message).toMatch(/desconectado/);
    expect(c.hint).toMatch(/QR Code/);
  });
  it('token vazio (ex.: número colocado no lugar do token)', async () => {
    const c = await wa.checkInstance(cfg([]), { name: 'x', token: '' });
    expect(c.hint).toMatch(/Não é o número/);
  });
  it('porta fechada / Evolution parada', async () => {
    const closed = wa.whatsappSchema.parse({ enabled: true, apiUrl: 'http://127.0.0.1:1', instances: [{ name: 'a', token: 't' }] });
    const r = await wa.sendWhatsAppText('11988887777', 'oi', closed);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/recusada|Falha de rede/);
  });
  it('tempo esgotado aponta bloqueio de porta na hospedagem', () => {
    const d = wa.describeNetworkError({ name: 'AbortError' }, 'http://1.2.3.4:8082');
    expect(d.hint).toMatch(/porta 8082/);
    expect(d.hint).toMatch(/443/);
  });
  it('envio falho lista o motivo de cada instância', async () => {
    const r = await wa.sendWhatsAppText('11988887777', 'teste motivos', cfg([{ name: 'off', token: 't' }, { name: 'z', token: 'bad' }]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/off: WhatsApp desconectado/);
    expect(r.error).toMatch(/z: Token recusado/);
  });
});

describe('URL da Evolution', () => {
  it('completa http:// e tira a barra final', () => {
    expect(wa.whatsappSchema.parse({ apiUrl: '10.0.0.1:8082/' }).apiUrl).toBe('http://10.0.0.1:8082');
    // URL do painel web da Evolution colada por engano
    expect(wa.whatsappSchema.parse({ apiUrl: 'http://10.0.0.1:8082/manager/' }).apiUrl).toBe('http://10.0.0.1:8082');
    expect(wa.normalizeEvolutionUrl(' 10.0.0.1:8082/manager/instance/abc ')).toBe('http://10.0.0.1:8082');
    expect(wa.normalizeEvolutionUrl('https://evo.site.com/api/manager')).toBe('https://evo.site.com/api');
    expect(wa.evolutionCandidates('http://10.0.0.1:8082')).toEqual(['http://10.0.0.1:8082', 'https://10-0-0-1.sslip.io', 'http://10.0.0.1']);
    expect(wa.whatsappSchema.parse({ apiUrl: 'https://evo.site.com' }).apiUrl).toBe('https://evo.site.com');
  });
});

describe('buscar instâncias na Evolution (puxando nome e número)', () => {
  it('lê o formato da Evolution v2 com nome exato, status e número', async () => {
    const r = await wa.fetchEvolutionInstances(url, 'GLOBAL');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toEqual([
      { name: 'Checkout-A', status: 'open', connected: true, number: '5521988887777', profileName: 'Loja A', token: 'tok-a' },
      { name: 'checkout-b', status: 'close', connected: false, number: null, profileName: null, token: 'tok-b' },
    ]);
  });
  it('lê o formato da Evolution v1', async () => {
    const r = await wa.fetchEvolutionInstances(url, 'V1');
    expect(r.ok && r.items[0]).toMatchObject({ name: 'vendas01', number: '5511912345678', connected: true, token: 'tok-v1' });
  });
  it('explica chave recusada', async () => {
    const r = await wa.fetchEvolutionInstances(url, 'errada');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/recusada/);
  });
  it('usa a API Key global quando a instância está sem token', async () => {
    const c = wa.whatsappSchema.parse({ enabled: true, apiUrl: url, globalApiKey: 'GLOBALKEY', instances: [{ name: 'boa', token: '' }] });
    calls.length = 0;
    const r = await wa.sendWhatsAppText('11988887777', 'via chave global', c);
    expect(r.ok).toBe(true);
    expect(calls.find((x) => x.path === '/message/sendText/boa')?.apikey).toBe('GLOBALKEY');
  });
  it('404 ao enviar mostra a resposta da Evolution e orienta importar', async () => {
    const r = await wa.sendWhatsAppText('11988887777', 'teste 404', cfg([{ name: 'fantasma', token: 't' }]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/404/);
    expect(r.error).toMatch(/does not exist/);
    expect(r.hint).toMatch(/Buscar instâncias/);
    // tentou também o formato @s.whatsapp.net
    expect(calls.some((x) => x.path === '/message/sendText/fantasma' && String(x.body?.number).endsWith('@s.whatsapp.net'))).toBe(true);
  });
});
