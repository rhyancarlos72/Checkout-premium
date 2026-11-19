/**
 * Leitura de CSV de contatos NO NAVEGADOR (o arquivo não sai do computador até você confirmar a importação).
 * Aceita vírgula, ponto e vírgula ou tab, aspas e colunas em qualquer ordem: reconhece pelos nomes
 * (telefone/whatsapp/celular, nome, primeiro_nome, email, ultimo_produto, produtos, ultima_data, pedidos, total_gasto).
 */
export interface ContactRow {
  phone: string;
  name: string | null;
  first_name: string | null;
  email: string | null;
  last_product: string | null;
  products: string | null;
  last_purchase: string | null; // AAAA-MM-DD
  orders_count: number | null;
  total_spent_cents: number | null;
}
export interface CsvPreview {
  rows: ContactRow[]; // só os válidos e sem repetição (no arquivo)
  total: number;
  invalid: number;
  duplicated: number;
  columns: { found: string[]; missing: string[] };
  recency: { d90: number; d180: number; older: number; unknown: number };
}

/** Separa em linhas e colunas respeitando aspas ("a, b" e "" dentro de aspas). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) out.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) out.push(row);
  return out;
}

/** 55 + DDD + número (mesma regra do servidor). Vazio = inválido. */
export function normalizePhoneBR(raw: string) {
  let t = String(raw ?? '').replace(/\D/g, '').replace(/^0+/, '');
  while (t.length > 13 && t.startsWith('55')) t = t.slice(2);
  if ((t.length === 12 || t.length === 13) && t.startsWith('55') && Number(t.slice(2, 4)) >= 11) return t;
  if ((t.length === 10 || t.length === 11) && Number(t.slice(0, 2)) >= 11) return `55${t}`;
  return '';
}

const ALIASES: Record<keyof ContactRow | 'total_spent', string[]> = {
  phone: ['telefone', 'whatsapp', 'celular', 'phone', 'fone', 'tel', 'numero'],
  name: ['nome', 'name', 'nome_completo', 'cliente'],
  first_name: ['primeiro_nome', 'first_name', 'primeironome'],
  email: ['email', 'e-mail', 'e_mail'],
  last_product: ['ultimo_produto', 'produto', 'product', 'ultimo produto'],
  products: ['produtos_comprados', 'produtos', 'products'],
  last_purchase: ['ultima_data', 'data', 'data_compra', 'ultima_compra', 'date'],
  orders_count: ['pedidos_aprovados', 'pedidos', 'compras', 'orders'],
  total_spent: ['total_gasto', 'total', 'valor_total'],
  total_spent_cents: [],
};
const key = (h: string) => h.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** Data "dd/mm/aaaa" ou "aaaa-mm-dd" → "aaaa-mm-dd" (ou null). */
function isoDate(v: string) {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
/** "1.234,56" / "1234.56" / "9.9" → centavos */
function cents(v: string) {
  const s = v.trim().replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Lê o arquivo e devolve a prévia (válidos sem repetição, inválidos, repetidos, colunas e recência). */
export function previewContacts(text: string): CsvPreview {
  const grid = parseCsv(text);
  const header = (grid[0] ?? []).map(key);
  const col = (k: keyof typeof ALIASES) => header.findIndex((h) => ALIASES[k].includes(h));
  const idx = { phone: col('phone'), name: col('name'), first_name: col('first_name'), email: col('email'), last_product: col('last_product'), products: col('products'), last_purchase: col('last_purchase'), orders_count: col('orders_count'), total_spent: col('total_spent') };
  const labels: Record<string, string> = { phone: 'WhatsApp', name: 'nome', email: 'e-mail', last_product: 'produto', last_purchase: 'data da compra' };
  const found = Object.entries(labels).filter(([k]) => (idx as any)[k] >= 0).map(([, l]) => l);
  const missing = Object.entries(labels).filter(([k]) => (idx as any)[k] < 0).map(([, l]) => l);
  const seen = new Set<string>();
  const rows: ContactRow[] = [];
  let invalid = 0;
  let duplicated = 0;
  const recency = { d90: 0, d180: 0, older: 0, unknown: 0 };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  for (const r of grid.slice(1)) {
    const phone = normalizePhoneBR(get(r, idx.phone));
    if (!phone) {
      invalid++;
      continue;
    }
    if (seen.has(phone)) {
      duplicated++;
      continue;
    }
    seen.add(phone);
    const name = get(r, idx.name) || null;
    const last = isoDate(get(r, idx.last_purchase));
    const days = last ? (Date.now() - Date.parse(`${last}T12:00:00Z`)) / 86_400_000 : null;
    if (days === null) recency.unknown++;
    else if (days <= 90) recency.d90++;
    else if (days <= 180) recency.d180++;
    else recency.older++;
    const orders = Number(get(r, idx.orders_count));
    rows.push({
      phone,
      name: name?.slice(0, 160) ?? null,
      first_name: (get(r, idx.first_name) || name?.split(/\s+/)[0] || '').slice(0, 60) || null,
      email: get(r, idx.email).toLowerCase() || null,
      last_product: get(r, idx.last_product).slice(0, 200) || null,
      products: get(r, idx.products).slice(0, 2000) || null,
      last_purchase: last,
      orders_count: Number.isFinite(orders) && get(r, idx.orders_count) ? Math.max(0, Math.floor(orders)) : null,
      total_spent_cents: cents(get(r, idx.total_spent)),
    });
  }
  return { rows, total: Math.max(0, grid.length - 1), invalid, duplicated, columns: { found, missing }, recency };
}
