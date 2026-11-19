import { z } from 'zod';
import { HttpError, supabase } from '../lib/core.js';
import { normalizePhoneBR } from './whatsapp.js';

/**
 * Contatos importados (ex.: compradores do checkout antigo, por CSV). O painel lê o arquivo NO NAVEGADOR e manda
 * em lotes de até 500; aqui só valida, normaliza o WhatsApp e grava quem ainda não existe (um contato por WhatsApp).
 * Ficam separados de clientes e vendas: não mexem no faturamento, no painel de vendas nem no Pixel.
 */
const cut = (n: number) => z.string().trim().max(5000).transform((v) => v.slice(0, n) || null).nullable().optional();
export const contactRowSchema = z.object({
  phone: z.string().trim().max(40),
  name: cut(160),
  first_name: cut(60),
  email: z.string().trim().toLowerCase().max(200).nullable().optional().transform((v) => (v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null)),
  last_product: cut(200),
  products: cut(2000),
  last_purchase: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  orders_count: z.number().int().min(0).max(100000).nullable().optional(),
  total_spent_cents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
});
export const importSchema = z.object({
  list_name: z.string().trim().min(1, 'Dê um nome à lista').max(80),
  rows: z.array(contactRowSchema).min(1).max(500),
});

/** Grava um lote. Devolve quantos entraram, quantos já existiam e quantos têm WhatsApp inválido. */
export async function importContacts(input: z.infer<typeof importSchema>) {
  let invalid = 0;
  const byPhone = new Map<string, any>();
  for (const r of input.rows) {
    const phone = normalizePhoneBR(r.phone);
    if (!phone) {
      invalid++;
      continue;
    }
    if (!byPhone.has(phone)) byPhone.set(phone, { ...r, phone, list_name: input.list_name, status: 'pending' });
  }
  const phones = [...byPhone.keys()];
  if (!phones.length) return { inserted: 0, existing: 0, invalid, duplicated: input.rows.length - invalid };
  const { data: have, error: e1 } = await supabase.from('wa_contacts').select('phone').in('phone', phones);
  if (e1) throw new HttpError(/wa_contacts|does not exist|schema cache/i.test(e1.message) ? 409 : 500, /wa_contacts|does not exist|schema cache/i.test(e1.message) ? 'Rode no Supabase o SQL dos contatos importados (supabase/migrations/20261123000000_wa_contacts.sql).' : e1.message);
  const exists = new Set(((have ?? []) as any[]).map((x) => x.phone));
  const fresh = phones.filter((p) => !exists.has(p)).map((p) => byPhone.get(p));
  if (fresh.length) {
    const { error } = await supabase.from('wa_contacts').insert(fresh);
    if (error) throw new HttpError(500, error.message);
  }
  return { inserted: fresh.length, existing: exists.size, invalid, duplicated: input.rows.length - invalid - byPhone.size };
}

/** Resumo para o painel: por lista e por situação, motivos de quem foi pulado. */
export async function contactsSummary() {
  const all: { list_name: string; status: string; skip_reason: string | null }[] = [];
  for (let page = 0; page < 100; page++) {
    const { data, error } = await supabase.from('wa_contacts').select('list_name, status, skip_reason').order('created_at', { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) return { ready: false as const, error: error.message };
    all.push(...((data ?? []) as any[]));
    if (!data || data.length < 1000) break;
  }
  const lists = new Map<string, { name: string; total: number; pending: number; queued: number; sent: number; skipped: number }>();
  const reasons = new Map<string, number>();
  for (const c of all) {
    const l = lists.get(c.list_name) ?? { name: c.list_name, total: 0, pending: 0, queued: 0, sent: 0, skipped: 0 };
    l.total++;
    (l as any)[c.status] = ((l as any)[c.status] ?? 0) + 1;
    lists.set(c.list_name, l);
    if (c.status === 'skipped' && c.skip_reason) reasons.set(c.skip_reason, (reasons.get(c.skip_reason) ?? 0) + 1);
  }
  const sum = (k: 'total' | 'pending' | 'queued' | 'sent' | 'skipped') => [...lists.values()].reduce((n, l) => n + l[k], 0);
  return {
    ready: true as const,
    total: sum('total'),
    pending: sum('pending'),
    queued: sum('queued'),
    sent: sum('sent'),
    skipped: sum('skipped'),
    lists: [...lists.values()].sort((a, b) => b.total - a.total),
    skip_reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

/** Apaga uma lista (só quem ainda não recebeu; o histórico de quem recebeu fica). */
export async function deleteContactList(name: string) {
  const { error } = await supabase.from('wa_contacts').delete().eq('list_name', name).in('status', ['pending', 'skipped']);
  if (error) throw new HttpError(500, error.message);
}
