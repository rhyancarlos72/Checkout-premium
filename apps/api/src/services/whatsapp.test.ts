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
  it('recuperação: link e Pix copia e cola na mesma mensagem', () => {
    const m = wa.buildRecoveryMessage({ phone: '5511900000002', name: 'João', link: 'https://link', attempt: 1, pixCode: '000201PIX' });
    expect(m).toContain('João');
    expect(m).toContain('https://link');
    expect(m).toContain('000201PIX');
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
  it('explica quando não há instância configurada', async () => {
    expect((await wa.sendWhatsAppText('11988887777', 'x', cfg([]))).ok).toBe(false);
  });
});
