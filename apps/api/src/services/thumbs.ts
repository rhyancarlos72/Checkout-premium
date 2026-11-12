import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { fetchWithTimeout, logger } from '../lib/core.js';

/**
 * Miniaturas das imagens do Storage (order bumps, produto, depoimentos): o plano do Supabase não
 * redimensiona, então o servidor gera um WebP pequeno uma vez e guarda em cache (memória + disco).
 * O navegador guarda por 1 ano (o nome do arquivo no Storage é único: imagem nova = endereço novo).
 * Sem a biblioteca `sharp` (instalação opcional) ou em qualquer falha: redireciona para a original.
 */
export const THUMB_WIDTHS = [48, 64, 96, 128, 160, 192, 256, 320, 480];
const MAX_SOURCE = 15 * 1024 * 1024;
const MEM_LIMIT = 40 * 1024 * 1024;

const mem = new Map<string, { buf: Buffer; type: string }>();
let memBytes = 0;
const inflight = new Map<string, Promise<{ buf: Buffer; type: string } | null>>();
const diskDir = path.join(os.tmpdir(), 'ck-thumbs');

let sharpMod: any | null | undefined;
async function getSharp() {
  if (sharpMod !== undefined) return sharpMod;
  try {
    sharpMod = (await import('sharp' as string)).default;
  } catch (e) {
    sharpMod = null;
    logger.warn({ err: (e as Error)?.message }, 'sharp indisponível: miniaturas usam a imagem original');
  }
  return sharpMod;
}

/** Só imagens públicas do Storage deste projeto (nada de proxy aberto). */
export function allowedSource(src: string) {
  const base = `${env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/public/`;
  if (!src.startsWith(base)) return false;
  const rest = src.slice(base.length);
  return /^[\w\-./%]+\.(webp|png|jpe?g|gif|avif)$/i.test(rest) && !rest.includes('..');
}

function remember(key: string, v: { buf: Buffer; type: string }) {
  mem.set(key, v);
  memBytes += v.buf.length;
  for (const [k, old] of mem) {
    if (memBytes <= MEM_LIMIT) break;
    mem.delete(k);
    memBytes -= old.buf.length;
  }
}

async function build(src: string, w: number): Promise<{ buf: Buffer; type: string } | null> {
  const sharp = await getSharp();
  if (!sharp) return null;
  const file = path.join(diskDir, `${crypto.createHash('sha1').update(`${w}|${src}`).digest('hex')}`);
  try {
    const buf = await fs.promises.readFile(file);
    const nl = buf.indexOf(10); // 1ª linha: tipo da imagem
    return { buf: buf.subarray(nl + 1), type: buf.subarray(0, nl).toString() };
  } catch {
    /* ainda não existe */
  }
  const r = await fetchWithTimeout(src, { timeoutMs: 8000 });
  if (!r.ok) return null;
  const original = Buffer.from(await r.arrayBuffer());
  if (original.length > MAX_SOURCE) return null;
  const out: Buffer = await sharp(original, { limitInputPixels: 40_000_000, animated: false })
    .rotate()
    // "outside": o menor lado fica com pelo menos `w` (as miniaturas são recortadas em quadrado no CSS)
    .resize({ width: w, height: w, fit: 'outside', withoutEnlargement: true })
    .webp({ quality: 78, effort: 4 })
    .toBuffer();
  // se a original já era menor que a miniatura, entrega a original
  const useWebp = out.length < original.length;
  const origType = /^image\/[\w.+-]+$/.test(r.headers.get('content-type') ?? '') ? r.headers.get('content-type')! : 'image/webp';
  const result = useWebp ? { buf: out, type: 'image/webp' } : { buf: original, type: origType };
  fs.promises
    .mkdir(diskDir, { recursive: true })
    .then(() => fs.promises.writeFile(file, Buffer.concat([Buffer.from(`${result.type}\n`), result.buf])))
    .catch(() => {});
  return result;
}

export async function getThumb(src: string, w: number) {
  const key = `${w}|${src}`;
  const hit = mem.get(key);
  if (hit) return hit;
  let p = inflight.get(key);
  if (!p) {
    p = build(src, w).catch((e) => {
      logger.warn({ err: (e as Error)?.message, src }, 'Miniatura falhou: usa a original');
      return null;
    });
    inflight.set(key, p);
    p.finally(() => inflight.delete(key));
  }
  const v = await p;
  if (v) remember(key, v);
  return v;
}

/** GET /api/public/img?w=160&src=<url do Storage> */
export async function thumbHandler(req: Request, res: Response) {
  const src = String(req.query.src ?? '');
  const want = Number(req.query.w);
  if (!allowedSource(src)) return res.status(400).json({ error: 'Imagem inválida' });
  // largura sempre de uma lista fixa (ninguém enche o cache com tamanhos aleatórios)
  const w = THUMB_WIDTHS.find((x) => x >= want) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1];
  const t = await getThumb(src, w);
  if (!t) {
    res.set('Cache-Control', 'public, max-age=300');
    return res.redirect(302, src);
  }
  res.set({ 'Content-Type': t.type, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Length': String(t.buf.length) });
  res.end(t.buf);
}
