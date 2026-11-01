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
