/**
 * ID único do produto (7 dígitos, ex.: 9452335), derivado do número interno (#1001…).
 * Bijeção: (n·7919 + 4523) mod 9.000.000 + 1.000.000 — 7919 é primo com 9.000.000,
 * então dois produtos nunca têm o mesmo ID, e o ID nunca muda.
 */
export const productCode = (n?: number | null) => (n ? String(((n * 7919 + 4523) % 9_000_000) + 1_000_000) : '');

export const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const digits = (v: string) => v.replace(/\D/g, '');

/**
 * Telefone BR só com DDD + número (até 11 dígitos). Aceita digitado/colado com o código do país:
 * "+55 (11) 98888-7777", "55 11 98888-7777" ou "0055…" viram "(11) 98888-7777".
 * (Antes o 55 entrava como DDD e o número ficava errado no WhatsApp.)
 */
export function nationalPhone(v: string) {
  let d = digits(v).replace(/^00/, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.replace(/^0+/, '').slice(0, 11);
}

export function maskPhone(v: string) {
  const d = nationalPhone(v);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export function maskDocument(v: string) {
  const d = digits(v).slice(0, 14);
  if (d.length <= 11) {
    return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
}

export function isValidCpf(raw: string) {
  const c = digits(raw);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const calc = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(c[i]) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(c[9]) && calc(10) === Number(c[10]);
}
export function isValidCnpj(raw: string) {
  const c = digits(raw);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = w.reduce((s, wi, i) => s + Number(c[i]) * wi, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

/** "197,90" → 19790 */
/**
 * Converte valor digitado livremente em centavos: "29,90", "29.90", "R$ 29,90", "1.299,90", "1,299.90", "29".
 * O último separador seguido de 1–2 dígitos é o decimal; os demais são de milhar.
 */
export const parseMoney = (v: string) => {
  const s = v.replace(/[^\d.,]/g, '');
  if (!s) return 0;
  const m = s.match(/^(.*)[.,](\d{1,2})$/);
  const int = (m ? m[1] : s).replace(/[.,]/g, '');
  const dec = m ? m[2].padEnd(2, '0') : '00';
  return Number(int || '0') * 100 + Number(dec) || 0;
};
export const centsToInput = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

/** Cor de texto legível sobre a cor de fundo */
export function contrastText(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111827' : '#ffffff';
}
