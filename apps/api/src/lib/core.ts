import cryptoMod from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import pino from 'pino';
import { env, isProd } from '../config/env.js';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  // limite de tempo em toda chamada ao banco: nada fica preso esperando o Supabase
  global: {
    fetch: (input: any, init: any = {}) => {
      if (init.signal) return fetch(input, init);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
    },
  },
});

export const logger = pino({
  level: isProd ? 'info' : 'debug',
  // Nunca registrar segredos ou dados pessoais sensíveis nos logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-cron-secret"]',
      '*.document',
      '*.cpf',
      '*.password',
      '*.token',
      '*.secret',
    ],
    censor: '[redacted]',
  },
});

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Lança erro se a resposta do Supabase tiver erro; retorna o data tipado. */
export function must<T>(res: { data: T | null; error: { message: string } | null }, notFoundMsg?: string): T {
  if (res.error) throw new HttpError(500, res.error.message);
  if (res.data === null || res.data === undefined) throw new HttpError(404, notFoundMsg ?? 'Não encontrado');
  return res.data;
}

export const onlyDigits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

export function isValidCpf(raw: string): boolean {
  const cpf = onlyDigits(raw);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

export function isValidCnpj(raw: string): boolean {
  const c = onlyDigits(raw);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((s, wi, i) => s + Number(c[i]) * wi, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

export const centsToBRL = (cents: number) => (cents / 100).toFixed(2);
export const formatBRL = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** fetch com timeout */
export async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs = 15000, ...rest } = init;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/**
 * ID único do produto (7 dígitos, ex.: 9452335), derivado do número interno (#1001…).
 * Bijeção: (n·7919 + 4523) mod 9.000.000 + 1.000.000 — 7919 é primo com 9.000.000,
 * então dois produtos nunca têm o mesmo ID, e o ID nunca muda.
 */
export const productCode = (n?: number | null) => (n ? String(((n * 7919 + 4523) % 9_000_000) + 1_000_000) : '');

/** Telefone BR no formato da Meta/PayTracking: só dígitos, com 55 (ex.: 5511999998888). */
export function phoneE164BR(raw: string | null | undefined) {
  let d = onlyDigits(raw);
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d.length >= 12 && d.length <= 13 ? d : null;
}

const isPrivateIp = (ip: string) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd|fe80:)/i.test(ip);
/**
 * IP real do comprador (fator de correspondência da Meta). Atrás de CDN/proxy (Hostinger,
 * Cloudflare, LiteSpeed) o req.ip pode ser o do proxy: usa os cabeçalhos próprios e o
 * primeiro IP público do X-Forwarded-For.
 */
export function clientIp(req: { ip?: string; headers: Record<string, string | string[] | undefined> }) {
  const h = (k: string) => {
    const v = req.headers[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || '';
  };
  const clean = (ip: string) => ip.replace(/^::ffff:/, '').replace(/^\[|\](:\d+)?$/g, '').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1');
  for (const k of ['cf-connecting-ip', 'true-client-ip', 'x-real-ip']) if (h(k) && !isPrivateIp(clean(h(k)))) return clean(h(k));
  const fwd = h('x-forwarded-for').split(',').map((x) => clean(x.trim())).filter(Boolean);
  const pub = fwd.find((ip) => !isPrivateIp(ip));
  return pub ?? (req.ip ? clean(req.ip) : null);
}

/**
 * Localização aproximada do comprador pelos cabeçalhos da CDN (Cloudflare, Vercel, LiteSpeed/Hostinger CDN).
 * Cidade/estado/CEP somam pontos na correspondência da Meta. Só usa o que o proxy informar.
 */
export function geoFromHeaders(headers: Record<string, string | string[] | undefined>) {
  const h = (...keys: string[]) => {
    for (const k of keys) {
      const v = headers[k];
      const val = (Array.isArray(v) ? v[0] : v)?.trim();
      if (val) {
        try {
          return decodeURIComponent(val).slice(0, 80);
        } catch {
          return val.slice(0, 80);
        }
      }
    }
    return undefined;
  };
  const out: Record<string, string> = {};
  const city = h('cf-ipcity', 'x-vercel-ip-city', 'x-geo-city', 'x-client-city');
  const state = h('cf-region-code', 'x-vercel-ip-country-region', 'x-geo-region', 'x-client-region');
  const zip = h('cf-postal-code', 'x-vercel-ip-postal-code', 'x-geo-postal-code');
  const country = h('cf-ipcountry', 'x-vercel-ip-country', 'x-geo-country', 'x-country-code');
  if (city) out.geo_city = city;
  if (state) out.geo_state = state;
  if (zip) out.geo_zip = zip.replace(/\D/g, '');
  if (country && /^[A-Za-z]{2}$/.test(country)) out.geo_country = country.toUpperCase();
  return out;
}

// ------------------------------------------------------------------ link curto do pedido
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const toB62 = (n: number) => {
  let s = '';
  do {
    s = B62[n % 62] + s;
    n = Math.floor(n / 62);
  } while (n > 0);
  return s;
};
const fromB62 = (s: string) => [...s].reduce((n, ch) => n * 62 + B62.indexOf(ch), 0);
const shortSig = (n: number) => {
  const h = cryptoMod.createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY).update(`pedido:${n}`).digest();
  return toB62(h.readUIntBE(0, 6)).padStart(5, '0').slice(-5); // 5 caracteres ≈ 916 milhões de combinações
};
/**
 * Código curto e exclusivo do pedido (ex.: "aZ3kQg8"): assinatura de 5 caracteres + número do pedido.
 * Não dá para adivinhar o de outra venda (a assinatura usa a chave secreta do servidor).
 */
export const shortOrderCode = (orderNumber: number) => `${shortSig(orderNumber)}${toB62(orderNumber)}`;
/** Valida o código curto e devolve o número do pedido (ou null). */
export function parseShortOrderCode(code: string): number | null {
  if (!/^[0-9A-Za-z]{6,16}$/.test(code)) return null;
  const n = fromB62(code.slice(5));
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const a = Buffer.from(code.slice(0, 5));
  const b = Buffer.from(shortSig(n));
  return a.length === b.length && cryptoMod.timingSafeEqual(a, b) ? n : null;
}
