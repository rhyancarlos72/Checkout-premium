import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let storage: http.Server;
let app: http.Server;
let base = '';
let src = '';
let hits = 0;
let big: Buffer;

beforeAll(async () => {
  big = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 30, b: 60 } } }).png().toBuffer();
  storage = http.createServer((req, res) => {
    hits++;
    if (req.url?.endsWith('/bump.png')) return res.writeHead(200, { 'Content-Type': 'image/png' }).end(big);
    if (req.url?.endsWith('/tiny.webp')) return sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).webp().toBuffer().then((b) => res.writeHead(200, { 'Content-Type': 'image/webp' }).end(b));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => storage.listen(0, '127.0.0.1', r));
  const sbase = `http://127.0.0.1:${(storage.address() as AddressInfo).port}`;
  Object.assign(process.env, { NODE_ENV: 'test', PUBLIC_URL: 'https://x.com', SUPABASE_URL: sbase, SUPABASE_SERVICE_ROLE_KEY: 'test-key-test-key-test-key' });
  src = `${sbase}/storage/v1/object/public/media/2026-11/bump.png`;
  const { thumbHandler } = await import('./thumbs.js');
  const a = express();
  a.get('/img', thumbHandler);
  app = a.listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => {
  storage?.close();
  app?.close();
});

const get = (q: string) => fetch(`${base}/img?${q}`, { redirect: 'manual' });

describe('miniaturas das imagens do Storage', () => {
  it('order bump 800 px vira WebP pequeno (2x de 72 px) com cache de 1 ano', async () => {
    const r = await get(`w=144&src=${encodeURIComponent(src)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/webp');
    expect(r.headers.get('cache-control')).toContain('immutable');
    const buf = Buffer.from(await r.arrayBuffer());
    const meta = await sharp(buf).metadata();
    expect(meta.height).toBe(160); // tamanho fixo mais próximo acima de 144; menor lado ≥ pedido (recorte quadrado no CSS)
    expect(meta.width).toBe(213);
    expect(buf.length).toBeLessThan(big.length / 5);
  });
  it('segunda vez sai do cache (não baixa a original de novo)', async () => {
    const before = hits;
    await Promise.all([1, 2, 3].map(() => get(`w=144&src=${encodeURIComponent(src)}`).then((r) => r.arrayBuffer())));
    expect(hits).toBe(before);
  });
  it('imagem já pequena: entrega a original (nunca aumenta)', async () => {
    const r = await get(`w=320&src=${encodeURIComponent(src.replace('bump.png', 'tiny.webp'))}`);
    expect(r.status).toBe(200);
    expect((await sharp(Buffer.from(await r.arrayBuffer())).metadata()).width).toBe(40);
  });
  it('só aceita imagens públicas do Storage deste projeto (não é proxy aberto)', async () => {
    for (const bad of ['https://evil.com/a.png', src.replace('/public/', '/sign/'), src.replace('bump.png', '../../x.png'), src.replace('.png', '.svg'), '']) {
      expect((await get(`w=96&src=${encodeURIComponent(bad)}`)).status).toBe(400);
    }
  });
  it('original some do Storage: redireciona para ela (o navegador mostra o mesmo que antes)', async () => {
    const missing = src.replace('bump.png', 'sumiu.png');
    const r = await get(`w=96&src=${encodeURIComponent(missing)}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(missing);
  });
});
