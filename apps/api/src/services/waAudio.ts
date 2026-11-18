import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger, supabase } from '../lib/core.js';
import { orgOfOrder, ownerOrgId } from '../lib/tenant.js';
import {
  WA_RECOVERY_SELECT,
  evoCall,
  evoMsg,
  getWhatsAppConfig,
  logWa,
  normalizePhoneBR,
  optOutWord,
  optedOut,
  phoneVariants,
  recoveryEmailFallback,
  registerOptOut,
  sendRecoveryText,
  sendWhatsAppAudio,
  sendWhatsAppText,
  tokenFor,
  type WhatsAppConfig,
} from './whatsapp.js';

/**
 * Áudios no WhatsApp (Etapa H), tudo pela Evolution:
 *  - Recuperação: o 1º e o 2º lembretes continuam em texto; o 3º (último) vira ÁUDIO + link/Pix.
 *  - Upsell: ~2 h depois de uma compra, para quem não assina e não comprou o item:
 *    texto curto ("Posso falar com você um segundo?") → áudio → link com a validade da oferta.
 *  - Fila com trava (nunca envia duas vezes), só das 8h às 20h (Brasília), descadastro SAIR/PARAR/CANCELAR,
 *    no máximo 1 upsell a cada 7 dias por pessoa, link rastreável /r/TOKEN e relatório por áudio.
 * Configuração em settings → chave "wa_audio" (só o dono da plataforma).
 */

// ------------------------------------------------------------------ configuração
/** Mensagens que vão logo DEPOIS do áudio: fazem referência ao que foi falado nele. */
export const UPSELL_LINK_TEXT = '{nome}, segue aqui o link que a gente acabou de falar 👇\n{link}\n\nEssa condição vale até {validade}.\n\nSe não quiser mais mensagens, responda SAIR.';
export const RECOVERY_LINK_TEXT = '{nome}, segue aqui o link que a gente acabou de falar 👇\n{link}{pix}\n\nSe não quiser mais mensagens, responda SAIR.';
/** texto padrão da 1ª versão (antes de citar o áudio): quem nunca mudou passa a receber o novo */
const OLD_UPSELL_LINK_TEXT = '{nome}, aqui está o link para entrar no {produto}:\n{link}\n\nEssa condição vale até {validade}.\n\nSe não quiser mais mensagens, responda SAIR.';
export const waAudioSchema = z.object({
  /** liga/desliga tudo (recuperação por áudio e upsell) */
  enabled: z.boolean().default(true),
  /** janela de envio, horário de Brasília: das `windowStart` até as `windowEnd` horas */
  windowStart: z.number().int().min(0).max(23).default(8),
  windowEnd: z.number().int().min(1).max(24).default(20),
  recovery: z
    .object({
      enabled: z.boolean().default(true),
      /** produtos cuja recuperação usa áudio (nenhum marcado = todos os lembretes seguem em texto) */
      product_ids: z.array(z.string().uuid()).max(200).default([]),
      /** em quais lembretes vai a sequência texto → áudio → link+Pix (os outros seguem em texto) */
      attempts: z.array(z.number().int().min(1).max(3)).max(3).default([1, 3]),
      /** 1ª mensagem da sequência no 1º lembrete e no último */
      opener: z.string().trim().min(2).max(500).default('Oi {nome}, tudo bem? Vi que você não finalizou a compra, posso falar com você um segundo?'),
      openerLast: z.string().trim().min(2).max(500).default('Oi {nome}, tudo bem? Seu pedido do {produto} ainda está reservado. Posso falar com você um segundo?'),
      /** áudio de cada lembrete (vazio = reveza entre os áudios de recuperação ativos) */
      audioFirst: z.string().uuid().or(z.literal('')).default(''),
      audioLast: z.string().uuid().or(z.literal('')).default(''),
      /** segundos entre a 1ª mensagem e o áudio */
      gapSeconds: z.number().int().min(10).max(600).default(40),
      /** mensagem que vai logo depois do áudio ({pix} = aviso do copia e cola, só quando o Pix ainda vale) */
      linkText: z.string().trim().min(2).max(1000).default(RECOVERY_LINK_TEXT),
    })
    .prefault({}),
  upsell: z
    .object({
      enabled: z.boolean().default(false),
      /** checkout oferecido (ex.: o do Clube) */
      checkout_slug: z.string().trim().max(60).default(''),
      /** página de vendas de upsell (/oferta/slug): quando escolhida, o link do áudio leva para ela */
      page_slug: z.string().trim().max(60).default(''),
      /** produtos que, PAGOS, disparam o upsell (nenhum marcado = upsell não sai) */
      product_ids: z.array(z.string().uuid()).max(200).default([]),
      delayMinutes: z.number().int().min(10).max(2880).default(120),
      validityHours: z.number().int().min(1).max(720).default(48),
      /** segundos entre o texto de abertura e o áudio */
      gapSeconds: z.number().int().min(10).max(600).default(45),
      opener: z.string().trim().min(2).max(500).default('Oi {nome}, tudo bem? Posso falar com você um segundo?'),
      linkText: z
        .string()
        .trim()
        .min(2)
        .max(1000)
        .default(UPSELL_LINK_TEXT),
    })
    .prefault({}),
  /** compradores antigos dos produtos marcados no upsell: 1 pessoa a cada `intervalMinutes`, dentro do horário */
  backfill: z
    .object({
      enabled: z.boolean().default(false),
      daysBack: z.number().int().min(1).max(730).default(90),
      intervalMinutes: z.number().int().min(10).max(1440).default(30),
    })
    .prefault({}),
});
export type WaAudioConfig = z.infer<typeof waAudioSchema>;

const KEY = 'wa_audio';
let cache: { value: WaAudioConfig; at: number } | null = null;
export async function getWaAudioConfig(): Promise<WaAudioConfig> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const { data } = await supabase.from('settings').select('value').eq('key', KEY).maybeSingle();
  const value = waAudioSchema.parse((data as any)?.value ?? {});
  if (value.upsell.linkText === OLD_UPSELL_LINK_TEXT) value.upsell.linkText = UPSELL_LINK_TEXT;
  cache = { value, at: Date.now() };
  return value;
}
export async function saveWaAudioConfig(value: WaAudioConfig) {
  const { error } = await supabase.from('settings').upsert({ key: KEY, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  cache = null;
}

// ------------------------------------------------------------------ horário (Brasília = UTC-3, sem horário de verão)
const SP_OFFSET = 3 * 3600_000;
const spHour = (t: number) => new Date(t - SP_OFFSET).getUTCHours();
export function inWindow(cfg: WaAudioConfig, t = Date.now()) {
  const h = spHour(t);
  return h >= cfg.windowStart && h < cfg.windowEnd;
}
/** Próxima abertura da janela (ex.: 8h de hoje ou de amanhã) + até 15 min aleatórios (não dispara tudo junto). */
export function nextWindowStart(cfg: WaAudioConfig, t = Date.now()) {
  const local = new Date(t - SP_OFFSET);
  let start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), cfg.windowStart) + SP_OFFSET;
  if (start <= t) start += 24 * 3600_000;
  return start + Math.floor(Math.random() * 15 * 60_000);
}
/** "21/11 às 14:30" (Brasília) */
export function spDateTime(t: number) {
  const d = new Date(t - SP_OFFSET);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} às ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const firstName = (name: string | null | undefined) => {
  const f = String(name ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return f ? f.charAt(0).toUpperCase() + f.slice(1) : '';
};
/** Troca {nome}, {produto}, {link}, {validade} no texto. Sem nome: tira a vírgula/espaço que sobraria. */
export function fillText(tpl: string, v: { nome?: string; produto?: string; link?: string; validade?: string; pix?: string; valor?: string }) {
  let t = tpl;
  if (!v.nome) t = t.replace(/\s*\{nome\}\s*,?/g, (m) => (m.startsWith(' ') ? ' ' : '')).replace(/^\s*,\s*/, '');
  return t
    .replace(/\{nome\}/g, v.nome ?? '')
    .replace(/\{produto\}/g, v.produto ?? 'produto')
    .replace(/\{link\}/g, v.link ?? '')
    .replace(/\{validade\}/g, v.validade ?? '')
    .replace(/\{pix\}/g, v.pix ?? '')
    .replace(/\{valor\}/g, v.valor ?? '')
    .replace(/ +([,.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

// ------------------------------------------------------------------ áudios
/**
 * Áudio a enviar: o escolhido (se ativo) ou, no "revezar", um dos ativos ao acaso (para comparar no relatório qual
 * vende mais). `avoid`: áudio reservado a outro lembrete (ex.: o de "última chance") não entra no revezamento.
 */
async function pickAudio(kind: 'recovery' | 'upsell', preferId?: string | null, avoid?: string | null) {
  const { data, error } = await supabase.from('wa_audios').select('id, file_url, name').eq('kind', kind).eq('active', true);
  if (error || !data?.length) return null;
  const all = data as { id: string; file_url: string; name: string }[];
  const chosen = all.find((a) => a.id === preferId);
  if (chosen) return chosen;
  const list = all.filter((a) => a.id !== avoid);
  const pool = list.length ? list : all; // só existe o reservado: usa ele mesmo
  return pool[Math.floor(Math.random() * pool.length)];
}
async function audioById(id: string | null | undefined) {
  if (!id) return null;
  const { data } = await supabase.from('wa_audios').select('id, file_url, name').eq('id', id).maybeSingle();
  return (data as { id: string; file_url: string; name: string } | null) ?? null;
}

// ------------------------------------------------------------------ link rastreável /r/TOKEN
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const newLinkToken = () => Array.from(crypto.randomBytes(22), (b) => B62[b % 62]).join('');
export const isLinkToken = (t: unknown): t is string => typeof t === 'string' && /^[0-9A-Za-z]{20,40}$/.test(t);

async function createLink(p: { kind: 'recovery' | 'upsell'; audioId: string | null; customerId: string | null; orderId: string | null; target: string; expiresAt?: number | null }) {
  const token = newLinkToken();
  const { error } = await supabase.from('wa_links').insert({
    token,
    kind: p.kind,
    audio_id: p.audioId,
    customer_id: p.customerId,
    order_id: p.orderId,
    target_url: p.target,
    expires_at: p.expiresAt ? new Date(p.expiresAt).toISOString() : null,
  });
  if (error) throw new Error(`link: ${error.message}`);
  return { token, url: `${env.PUBLIC_URL}/r/${token}` };
}

/** UTMs do link: whatsapp / audio / {tipo} / {audio_id} */
function utmQuery(kind: string, audioId: string | null) {
  return new URLSearchParams({ utm_source: 'whatsapp', utm_medium: 'audio', utm_campaign: kind === 'recovery' ? 'recuperacao' : 'upsell', utm_content: audioId ?? 'sem-audio' });
}

/**
 * Clique em /r/TOKEN: soma o clique e devolve para onde levar (com as UTMs).
 * Recuperação: marca no pedido pendente de qual áudio veio. Upsell: o checkout recebe ?wa=TOKEN e grava no pedido novo.
 */
export async function waLinkClick(token: string): Promise<string | null> {
  if (!isLinkToken(token)) return null;
  let link: any = null;
  const rpc = await supabase.rpc('wa_link_click', { p_token: token });
  if (!rpc.error) link = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
  else {
    const { data } = await supabase.from('wa_links').select('*').eq('token', token).maybeSingle();
    link = data;
    if (link) await supabase.from('wa_links').update({ clicks: (link.clicks ?? 0) + 1, last_click_at: new Date().toISOString() }).eq('token', token);
  }
  if (!link) return null;
  const q = utmQuery(link.kind, link.audio_id);
  if (link.kind === 'recovery' && link.order_id) {
    const { data: o } = await supabase.from('orders').select('id, status, tracking').eq('id', link.order_id).maybeSingle();
    if (o && (o as any).status !== 'paid') {
      const tracking = { ...((o as any).tracking ?? {}), wa: token, wa_audio_id: link.audio_id, content_category: 'whatsapp_audio_recuperacao' };
      const r = await supabase.from('orders').update({ tracking, audio_id: link.audio_id, wa_link_token: token }).eq('id', link.order_id);
      if (r.error) await supabase.from('orders').update({ tracking }).eq('id', link.order_id); // sem as colunas novas: fica só no tracking
    }
  } else q.set('wa', token);
  const sep = String(link.target_url).includes('?') ? '&' : '?';
  return `${link.target_url}${sep}${q.toString()}`;
}

/**
 * Pedido novo vindo do link do áudio (?wa=TOKEN + utm_medium=audio): grava no tracking de qual áudio veio.
 * Devolve o link para gravar também nas colunas do pedido. Qualquer outra origem: descarta o "wa" antigo.
 */
export async function resolveWaTracking(tracking: Record<string, string>) {
  const token = tracking.wa;
  delete tracking.wa;
  if (!isLinkToken(token) || tracking.utm_source !== 'whatsapp' || tracking.utm_medium !== 'audio') return null;
  const { data, error } = await supabase.from('wa_links').select('token, kind, audio_id').eq('token', token).maybeSingle();
  if (error || !data) return null;
  const link = data as { token: string; kind: string; audio_id: string | null };
  tracking.wa = link.token;
  if (link.audio_id) tracking.wa_audio_id = link.audio_id;
  tracking.content_category = link.kind === 'recovery' ? 'whatsapp_audio_recuperacao' : 'whatsapp_audio_upsell';
  return link;
}

// ------------------------------------------------------------------ quem pode receber o upsell
async function targetCheckout(slug: string) {
  if (!slug) return null;
  const { data } = await supabase.from('checkouts').select('id, slug, name, product_id, product:products(name)').eq('slug', slug).maybeSingle();
  return (data as any) ?? null;
}
/** Para onde o link do upsell leva: a página de vendas (se escolhida e ativa) ou o checkout. Devolve também o checkout que cobra. */
async function upsellTarget(cfg: WaAudioConfig): Promise<{ ck: any; path: string } | null> {
  if (cfg.upsell.page_slug) {
    const { data } = await supabase.from('upsell_pages').select('slug, active, checkout:checkouts(id, slug, name, product_id, product:products(name))').eq('slug', cfg.upsell.page_slug).maybeSingle();
    const p = data as any;
    if (p?.active && p.checkout?.product_id) return { ck: p.checkout, path: `/oferta/${p.slug}` };
  }
  const ck = await targetCheckout(cfg.upsell.checkout_slug);
  return ck?.product_id ? { ck, path: `/checkout?produto_id=${encodeURIComponent(ck.slug)}` } : null;
}

/** Motivo para NÃO enviar o upsell (ou null = pode enviar). */
export async function upsellBlocked(p: { customerId: string; phone: string; productId: string; ignoreQueueId?: string }): Promise<string | null> {
  if ((await optedOut([p.phone])).size) return 'pediu para sair';
  const [paid, subs, recent] = await Promise.all([
    supabase.from('orders').select('id, items:order_items(product_id)').eq('customer_id', p.customerId).eq('status', 'paid').limit(300),
    supabase.from('subscriptions').select('status, product_ids').eq('customer_id', p.customerId).in('status', ['active', 'past_due']),
    supabase
      .from('wa_queue')
      .select('id')
      .eq('kind', 'upsell')
      .in('phone', phoneVariants(p.phone))
      .in('status', ['pending', 'sending', 'done'])
      .gte('created_at', new Date(Date.now() - 7 * 24 * 3600_000).toISOString()),
  ]);
  if (((paid.data ?? []) as any[]).some((o) => (o.items ?? []).some((i: any) => i.product_id === p.productId))) return 'já comprou o produto';
  if (((subs.data ?? []) as any[]).some((s) => (s.product_ids ?? []).includes(p.productId))) return 'já é assinante';
  if (((recent.data ?? []) as any[]).some((r) => r.id !== p.ignoreQueueId)) return 'já recebeu um upsell nos últimos 7 dias';
  return null;
}

/** Venda aprovada → agenda o upsell por áudio (só vendas da plataforma, não renovação nem upsell). */
export async function scheduleUpsell(orderId: string) {
  const [cfg, wa] = await Promise.all([getWaAudioConfig(), getWhatsAppConfig()]);
  if (!cfg.enabled || !cfg.upsell.enabled || (!cfg.upsell.checkout_slug && !cfg.upsell.page_slug) || !cfg.upsell.product_ids.length || !wa.enabled) return null;
  const { data: o } = await supabase.from('orders').select('id, kind, status, checkout_id, customer_id, tracking, paid_at, customer:customers(phone), items:order_items(product_id)').eq('id', orderId).maybeSingle();
  const order = o as any;
  if (!order || order.status !== 'paid' || order.kind === 'renewal' || order.tracking?.upsell_of || order.tracking?.renewed_from) return null;
  // só quem pagou um dos produtos escolhidos no painel (produto principal ou order bump)
  if (!(order.items ?? []).some((i: any) => cfg.upsell.product_ids.includes(i.product_id))) return null;
  const phone = normalizePhoneBR(order.customer?.phone);
  if (!phone) return null;
  const owner = await ownerOrgId();
  if (owner && (await orgOfOrder(orderId)) !== owner) return null; // o WhatsApp da plataforma não é usado para produtores
  const ck = (await upsellTarget(cfg))?.ck;
  if (!ck?.product_id || ck.id === order.checkout_id) return null;
  if (!(await pickAudio('upsell'))) return null; // sem áudio de upsell ativo: nada a fazer
  const why = await upsellBlocked({ customerId: order.customer_id, phone, productId: ck.product_id });
  if (why) return why;
  const runAt = new Date(order.paid_at ?? Date.now()).getTime() + cfg.upsell.delayMinutes * 60_000;
  const { error } = await supabase.from('wa_queue').insert({ kind: 'upsell', status: 'pending', step: 0, customer_id: order.customer_id, order_id: orderId, phone, run_at: new Date(runAt).toISOString() });
  if (error && error.code !== '23505') logger.warn({ orderId, err: error.message }, 'Upsell por áudio não agendado');
  return error ? null : 'agendado';
}

/** 3º lembrete automático: entra na fila como áudio (true) — sem áudio ativo ou sem a tabela, segue o texto (false). */
/**
 * Lembrete automático `attempt` (1º, 2º ou 3º) marcado no painel: entra na fila como a sequência
 * texto curto → áudio → link + Pix (true). Fora do horário, sem áudio, produto não marcado ou sem o SQL: segue o texto (false).
 */
export async function queueRecoveryAudio(o: any, attempt = 3): Promise<boolean> {
  const cfg = await getWaAudioConfig();
  if (!cfg.enabled || !cfg.recovery.enabled || !cfg.recovery.attempts.includes(attempt)) return false;
  // só a recuperação dos produtos escolhidos no painel vai por áudio; os outros seguem em texto
  if (!(o.items ?? []).some((i: any) => i.kind === 'main' && cfg.recovery.product_ids.includes(i.product_id))) return false;
  if (!inWindow(cfg)) return false; // fora do horário: o lembrete vai em texto na hora (não atrasa a recuperação)
  const phone = normalizePhoneBR(o.customer?.phone);
  if (!phone) return false;
  const last = attempt === Math.max(...cfg.recovery.attempts) && attempt > 1;
  const audio = await pickAudio('recovery', (last ? cfg.recovery.audioLast : cfg.recovery.audioFirst) || null, (last ? cfg.recovery.audioFirst : cfg.recovery.audioLast) || null);
  if (!audio) return false;
  const { error } = await supabase.from('wa_queue').insert({ kind: 'recovery', attempt, status: 'pending', step: 0, customer_id: o.customer_id, order_id: o.id, phone, audio_id: audio.id, run_at: new Date().toISOString() });
  if (error && /attempt/i.test(error.message)) logger.warn('Rode no Supabase o SQL 20261122000000_wa_queue_attempt.sql (recuperação por áudio em mais de um lembrete)');
  return !error;
}

// ------------------------------------------------------------------ fila (com trava)
type Row = { id: string; kind: 'recovery' | 'upsell'; attempt?: number | null; step: number; customer_id: string | null; order_id: string | null; phone: string; audio_id: string | null; instance: string | null; link_token: string | null; attempts: number };
type Next = { status: 'pending' | 'done' | 'skipped' | 'failed'; step?: number; run_at?: number; error?: string | null; audio_id?: string | null; instance?: string | null; link_token?: string | null };

async function customerName(id: string | null) {
  if (!id) return '';
  const { data } = await supabase.from('customers').select('name').eq('id', id).maybeSingle();
  return firstName((data as any)?.name);
}

/** Upsell: 0 = texto de abertura, 1 = áudio, 2 = link com a validade. */
async function upsellStep(row: Row, cfg: WaAudioConfig, wa: WhatsAppConfig): Promise<Next> {
  const target = await upsellTarget(cfg);
  const ck = target?.ck;
  if (!cfg.upsell.enabled || !target || !ck?.product_id) return { status: 'skipped', error: 'upsell desligado ou sem checkout/página' };
  const produto = ck.product?.name ?? ck.name ?? 'Clube';
  const nome = await customerName(row.customer_id);
  if (row.step === 0) {
    const why = row.customer_id ? await upsellBlocked({ customerId: row.customer_id, phone: row.phone, productId: ck.product_id, ignoreQueueId: row.id }) : null;
    if (why) return { status: 'skipped', error: why };
    const audio = await pickAudio('upsell', row.audio_id);
    if (!audio) return { status: 'skipped', error: 'nenhum áudio de upsell ativo' };
    const r = await sendWhatsAppText(row.phone, fillText(cfg.upsell.opener, { nome, produto }), wa);
    await logWa(row.order_id, 'upsell_texto', r);
    if (!r.ok) return { status: 'failed', error: r.error ?? 'falhou' };
    return { status: 'pending', step: 1, run_at: Date.now() + cfg.upsell.gapSeconds * 1000, audio_id: audio.id, instance: r.instance ?? null };
  }
  if (row.step === 1) {
    const audio = await audioById(row.audio_id);
    let r = audio ? await sendWhatsAppAudio(row.phone, audio.file_url, wa, { instance: row.instance ?? undefined }) : { ok: false, error: 'áudio apagado' };
    if (!r.ok && audio && row.instance) r = await sendWhatsAppAudio(row.phone, audio.file_url, wa); // o número da conversa caiu
    await logWa(row.order_id, 'upsell_audio', r);
    // mesmo se o áudio falhar, manda o link (a pessoa já recebeu o "posso falar com você?")
    return { status: 'pending', step: 2, run_at: Date.now() + 15_000, instance: r.ok ? (r.instance ?? row.instance) : row.instance, error: r.ok ? null : `áudio: ${r.error}`, ...(r.ok ? {} : { audio_id: null }) };
  }
  const expires = Date.now() + cfg.upsell.validityHours * 3600_000;
  const link = await createLink({ kind: 'upsell', audioId: row.audio_id, customerId: row.customer_id, orderId: null, target: target.path, expiresAt: expires });
  const text = fillText(cfg.upsell.linkText, { nome, produto, link: link.url, validade: spDateTime(expires) });
  let r = await sendWhatsAppText(row.phone, text, wa, { instance: row.instance ?? undefined });
  if (!r.ok && row.instance) r = await sendWhatsAppText(row.phone, text, wa);
  await logWa(row.order_id, 'upsell_link', r);
  return r.ok ? { status: 'done', link_token: link.token } : { status: 'failed', error: r.error ?? 'falhou', link_token: link.token };
}

/** Recuperação (3º lembrete): 0 = áudio, 1 = link rastreável + Pix. Áudio falhou? vai o 3º lembrete em texto. */
/**
 * Recuperação (lembretes marcados no painel, ex.: 1º e 3º):
 *  0 = texto curto ("Vi que você não finalizou a compra, posso falar com você um segundo?"), 1 = áudio, 2 = link + Pix.
 * Se o texto curto falhar, vai o lembrete em texto como antes (e o e-mail, se o WhatsApp estiver fora).
 */
async function recoveryStep(row: Row, cfg: WaAudioConfig, wa: WhatsAppConfig): Promise<Next> {
  const attempt = row.attempt ?? 3;
  const { data } = await supabase.from('orders').select(WA_RECOVERY_SELECT).eq('id', row.order_id ?? '').maybeSingle();
  const o = data as any;
  if (!o) return { status: 'skipped', error: 'pedido não encontrado' };
  if (!['pending', 'expired'].includes(o.status)) return { status: 'skipped', error: 'pedido já pago ou cancelado' };
  const { count } = await supabase.from('orders').select('id', { count: 'exact', head: true }).eq('customer_id', o.customer_id).eq('status', 'paid').gte('created_at', o.created_at);
  if ((count ?? 0) > 0) return { status: 'skipped', error: 'já comprou' };
  const nome = firstName(o.customer?.name);
  const produto = (o.items ?? []).find((i: any) => i.kind === 'main')?.name ?? 'seu pedido';
  if (row.step === 0) {
    const last = attempt > 1 && attempt === Math.max(...cfg.recovery.attempts, attempt);
    const r = await sendWhatsAppText(row.phone, fillText(last ? cfg.recovery.openerLast : cfg.recovery.opener, { nome, produto }), wa);
    await logWa(o.id, `recovery_${attempt}_texto`, r);
    if (!r.ok) {
      // plano B: o lembrete em texto, como era antes (e o e-mail, se o WhatsApp estiver fora)
      const t = await sendRecoveryText(o, attempt, wa);
      await logWa(o.id, `recovery_${attempt}`, t);
      if (!t.ok) await recoveryEmailFallback(o.id, o.customer_id, attempt);
      return { status: t.ok ? 'done' : 'failed', error: `texto: ${r.error}${t.ok ? ' (foi o lembrete em texto)' : ''}`, audio_id: null };
    }
    return { status: 'pending', step: 1, run_at: Date.now() + cfg.recovery.gapSeconds * 1000, instance: r.instance ?? null };
  }
  if (row.step === 1) {
    const audio = (await audioById(row.audio_id)) ?? (await pickAudio('recovery'));
    let r = audio ? await sendWhatsAppAudio(row.phone, audio.file_url, wa, { instance: row.instance ?? undefined }) : { ok: false, error: 'nenhum áudio de recuperação ativo' };
    if (!r.ok && audio && row.instance) r = await sendWhatsAppAudio(row.phone, audio.file_url, wa); // o número da conversa caiu
    await logWa(o.id, `recovery_${attempt}_audio`, r);
    // mesmo se o áudio falhar, manda o link e o Pix (a pessoa já recebeu o "posso falar com você?")
    return { status: 'pending', step: 2, run_at: Date.now() + 12_000, instance: r.ok ? (r.instance ?? row.instance) : row.instance, audio_id: r.ok ? (audio?.id ?? null) : null, error: r.ok ? null : `áudio: ${r.error}` };
  }
  const link = await createLink({ kind: 'recovery', audioId: row.audio_id, customerId: o.customer_id, orderId: o.id, target: `/pedido/${o.public_token}` });
  // logo depois do áudio: "segue aqui o link que a gente acabou de falar" + o Pix copia e cola numa mensagem separada
  const pixValid = wa.recovery.includePix && o.status === 'pending' && o.pix_code && (!o.expires_at || new Date(o.expires_at) > new Date());
  const text = fillText(cfg.recovery.linkText, {
    nome,
    produto,
    link: link.url,
    valor: (o.total_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    pix: pixValid ? '\n\n📋 O Pix copia e cola vai na próxima mensagem: toque e segure para copiar.' : '',
  });
  let r = await sendWhatsAppText(row.phone, text, wa, { instance: row.instance ?? undefined });
  if (!r.ok && row.instance) r = await sendWhatsAppText(row.phone, text, wa); // o número da conversa caiu: vai por outro
  if (r.ok && pixValid) await sendWhatsAppText(row.phone, o.pix_code, wa, { instance: r.instance }).catch(() => null);
  await logWa(o.id, `recovery_${attempt}_link`, r);
  return r.ok ? { status: 'done', link_token: link.token } : { status: 'failed', error: r.error ?? 'falhou', link_token: link.token };
}

let draining = false;
/** Processa a fila: cada registro avança UM passo por vez (com trava: dois servidores nunca enviam o mesmo). */
export async function processWaQueue(max = 10) {
  if (draining) return;
  draining = true;
  try {
    const [cfg, wa] = await Promise.all([getWaAudioConfig(), getWhatsAppConfig()]);
    const now = Date.now();
    // travado há mais de 10 min (servidor reiniciou no meio do envio): não arrisca repetir
    await supabase.from('wa_queue').update({ status: 'failed', error: 'interrompido no meio do envio', locked_at: null }).eq('status', 'sending').lt('locked_at', new Date(now - 10 * 60_000).toISOString());
    const { data, error } = await supabase.from('wa_queue').select('*').eq('status', 'pending').lte('run_at', new Date(now).toISOString()).order('run_at', { ascending: true }).limit(max);
    if (error || !data?.length) return;
    for (const row of data as Row[]) {
      const { data: claimed } = await supabase
        .from('wa_queue')
        .update({ status: 'sending', locked_at: new Date().toISOString(), attempts: (row.attempts ?? 0) + 1 })
        .eq('id', row.id)
        .eq('status', 'pending')
        .select('id');
      if (!claimed?.length) continue; // outro processo pegou
      let next: Next;
      try {
        if (!cfg.enabled || !wa.enabled) next = { status: 'skipped', error: 'áudios ou WhatsApp desligados' };
        else if ((await optedOut([row.phone])).size) next = { status: 'skipped', error: 'pediu para sair' };
        else if (row.step === 0 && !inWindow(cfg)) next = { status: 'pending', step: 0, run_at: nextWindowStart(cfg) }; // fora das 8h–20h: espera
        else next = row.kind === 'upsell' ? await upsellStep(row, cfg, wa) : await recoveryStep(row, cfg, wa);
      } catch (e: any) {
        next = { status: 'failed', error: String(e?.message ?? e).slice(0, 300) };
      }
      await supabase
        .from('wa_queue')
        .update({
          status: next.status,
          step: next.step ?? row.step,
          run_at: new Date(next.run_at ?? Date.now()).toISOString(),
          locked_at: null,
          updated_at: new Date().toISOString(),
          ...(next.error !== undefined ? { error: next.error?.slice(0, 500) ?? null } : {}),
          ...(next.audio_id !== undefined ? { audio_id: next.audio_id } : {}),
          ...(next.instance !== undefined ? { instance: next.instance } : {}),
          ...(next.link_token !== undefined ? { link_token: next.link_token } : {}),
        })
        .eq('id', row.id);
    }
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, 'Fila de áudios falhou');
  } finally {
    draining = false;
  }
}

// ------------------------------------------------------------------ descadastro pela Evolution (mensagens recebidas)
export const evolutionWebhookSig = () => crypto.createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY).update('evolution-webhook').digest('hex').slice(0, 32);
export const evolutionWebhookUrl = () => `${env.PUBLIC_URL}/api/webhooks/evolution/${evolutionWebhookSig()}`;

/** Mensagem recebida (MESSAGES_UPSERT): "SAIR", "PARAR" ou "CANCELAR" descadastram o número. */
export async function handleEvolutionEvent(body: any) {
  const event = String(body?.event ?? '').toLowerCase().replace(/_/g, '.');
  if (event && event !== 'messages.upsert') return 0;
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.data?.messages) ? body.data.messages : [body?.data];
  let n = 0;
  for (const m of list) {
    if (!m?.key || m.key.fromMe) continue;
    const jid = String(m.key.remoteJidAlt ?? m.key.remoteJid ?? '');
    if (!jid.endsWith('@s.whatsapp.net')) continue; // grupos e listas: ignora
    const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? '';
    const word = optOutWord(text);
    if (word && (await registerOptOut(jid.split('@')[0], word))) n++;
  }
  return n;
}

/**
 * Liga na instância o aviso de mensagens recebidas (para o SAIR funcionar).
 * Se a instância já manda os avisos para OUTRO endereço (ex.: um robô), não troca sem `force`.
 */
export async function registerOptOutWebhook(name: string, force = false): Promise<{ ok: boolean; message: string; current?: string | null }> {
  const wa = await getWhatsAppConfig();
  const inst = wa.instances.find((i) => i.name === name);
  if (!wa.apiUrl || !inst) return { ok: false, message: 'Instância não encontrada nas Integrações' };
  const key = tokenFor(wa, inst);
  const url = evolutionWebhookUrl();
  const cur = await evoCall(wa, 'GET', `/webhook/find/${encodeURIComponent(name)}`, key).catch(() => null);
  const curUrl: string | null = cur?.json?.webhook?.url ?? cur?.json?.url ?? null;
  const curOn = cur?.json?.webhook?.enabled ?? cur?.json?.enabled ?? false;
  if (curUrl === url && curOn) return { ok: true, message: 'Já estava ligado', current: curUrl };
  if (curUrl && curOn && curUrl !== url && !force) return { ok: false, message: 'Esta instância já envia as mensagens para outro endereço. Trocar pode desligar outro sistema (ex.: um robô).', current: curUrl };
  const v2 = await evoCall(wa, 'POST', `/webhook/set/${encodeURIComponent(name)}`, key, { webhook: { enabled: true, url, byEvents: false, base64: false, events: ['MESSAGES_UPSERT'] } });
  if (v2.ok) return { ok: true, message: 'Descadastro (SAIR) ligado' };
  const v1 = await evoCall(wa, 'POST', `/webhook/set/${encodeURIComponent(name)}`, key, { enabled: true, url, webhook_by_events: false, webhook_base64: false, events: ['MESSAGES_UPSERT'] });
  if (v1.ok) return { ok: true, message: 'Descadastro (SAIR) ligado' };
  return { ok: false, message: `A Evolution recusou: ${evoMsg(v2.json, v2.raw)}` };
}

// ------------------------------------------------------------------ relatório por áudio
export async function waAudioReport() {
  const [aud, q, links, ords] = await Promise.all([
    supabase.from('wa_audios').select('*').order('created_at', { ascending: false }),
    supabase.from('wa_queue').select('audio_id, status, kind').not('audio_id', 'is', null).limit(20000),
    supabase.from('wa_links').select('audio_id, clicks').not('audio_id', 'is', null).limit(20000),
    supabase.from('orders').select('audio_id, status, total_cents').not('audio_id', 'is', null).limit(20000),
  ]);
  if (aud.error) return { ready: false as const, error: aud.error.message, audios: [] };
  const stat = new Map<string, { sent: number; clicks: number; clickers: number; orders: number; paid: number; revenue_cents: number }>();
  const s = (id: string) => stat.get(id) ?? (stat.set(id, { sent: 0, clicks: 0, clickers: 0, orders: 0, paid: 0, revenue_cents: 0 }), stat.get(id)!);
  for (const r of (q.data ?? []) as any[]) if (r.status === 'done') s(r.audio_id).sent++;
  for (const r of (links.data ?? []) as any[]) {
    s(r.audio_id).clicks += r.clicks ?? 0;
    if ((r.clicks ?? 0) > 0) s(r.audio_id).clickers++;
  }
  for (const r of (ords.data ?? []) as any[]) {
    const x = s(r.audio_id);
    x.orders++;
    if (r.status === 'paid') {
      x.paid++;
      x.revenue_cents += r.total_cents ?? 0;
    }
  }
  return {
    ready: true as const,
    audios: ((aud.data ?? []) as any[]).map((a) => {
      const x = s(a.id);
      return { ...a, ...x, conversion: x.sent ? Math.round((x.paid / x.sent) * 1000) / 10 : 0 };
    }),
  };
}


// ------------------------------------------------------------------ compradores antigos (envio espaçado)
const BACKFILL_KEY = 'wa_audio_backfill'; // estado: quando foi o último envio e quantos já foram
type BackfillState = { last_at: string | null; sent: number; last_order?: string | null };
async function backfillState(): Promise<BackfillState> {
  const { data } = await supabase.from('settings').select('value').eq('key', BACKFILL_KEY).maybeSingle();
  const v = (data as any)?.value ?? {};
  return { last_at: v.last_at ?? null, sent: Number(v.sent ?? 0), last_order: v.last_order ?? null };
}

/**
 * Compradores antigos que ainda podem receber: pagos nos últimos N dias (fora as últimas horas, que já seguem o fluxo
 * normal), de um produto marcado, um por pessoa (a compra mais recente), que nunca receberam upsell por áudio.
 * Ordem: mais recentes primeiro. `limit` = quantos devolver depois de passar pelas regras (assinante, já comprou, SAIR, 7 dias).
 */
async function backfillCandidates(cfg: WaAudioConfig, ck: any, limit: number, check = true) {
  const ids = cfg.upsell.product_ids;
  if (!ids.length) return { list: [] as any[], total: 0 };
  const since = new Date(Date.now() - cfg.backfill.daysBack * 24 * 3600_000).toISOString();
  const before = new Date(Date.now() - Math.max(cfg.upsell.delayMinutes, 60) * 60_000).toISOString();
  const owner = await ownerOrgId();
  // quem já recebeu (ou está na fila) qualquer upsell por áudio — em páginas de 1000 (limite do Supabase)
  const skip = new Set<string>();
  for (let page = 0; page < 200; page++) {
    const { data: queued } = await supabase.from('wa_queue').select('customer_id').eq('kind', 'upsell').order('created_at', { ascending: true }).range(page * 1000, page * 1000 + 999);
    for (const q of (queued ?? []) as any[]) if (q.customer_id) skip.add(q.customer_id);
    if (!queued || queued.length < 1000) break;
  }
  const out: any[] = [];
  let total = 0;
  for (let page = 0; page < 40; page++) {
    const { data, error } = await supabase
      .from('orders')
      .select('id, org_id, kind, tracking, customer_id, paid_at, customer:customers(phone), items:order_items(product_id)')
      .eq('status', 'paid')
      .gte('paid_at', since)
      .lte('paid_at', before)
      .order('paid_at', { ascending: false })
      .range(page * 500, page * 500 + 499);
    if (error || !data?.length) break;
    for (const o of data as any[]) {
      if (!o.customer_id || skip.has(o.customer_id)) continue;
      skip.add(o.customer_id); // uma vez por pessoa (a compra mais recente)
      if (owner && o.org_id && o.org_id !== owner) continue;
      if (o.kind === 'renewal' || o.tracking?.upsell_of || o.tracking?.renewed_from) continue;
      const pids = (o.items ?? []).map((i: any) => i.product_id);
      if (!pids.some((p: string) => ids.includes(p)) || pids.includes(ck.product_id)) continue;
      const phone = normalizePhoneBR(o.customer?.phone);
      if (!phone) continue;
      total++;
      if (out.length >= limit) continue;
      if (check && (await upsellBlocked({ customerId: o.customer_id, phone, productId: ck.product_id }))) {
        total--;
        continue;
      }
      out.push({ ...o, phone });
    }
    if (data.length < 500) break;
  }
  return { list: out, total };
}

/** Rotina: na hora certa (1 a cada N min, dentro do horário), coloca o próximo comprador antigo na fila do upsell. */
export async function runUpsellBackfill(now = Date.now()) {
  const [cfg, wa] = await Promise.all([getWaAudioConfig(), getWhatsAppConfig()]);
  if (!cfg.enabled || !cfg.upsell.enabled || !cfg.backfill.enabled || !wa.enabled || !cfg.upsell.product_ids.length) return null;
  if (!inWindow(cfg, now)) return null;
  const st = await backfillState();
  if (st.last_at && now - new Date(st.last_at).getTime() < cfg.backfill.intervalMinutes * 60_000) return null;
  const target = await upsellTarget(cfg);
  if (!target?.ck?.product_id || !(await pickAudio('upsell'))) return null;
  const { list } = await backfillCandidates(cfg, target.ck, 1);
  const o = list[0];
  if (!o) return null;
  const { error } = await supabase.from('wa_queue').insert({ kind: 'upsell', status: 'pending', step: 0, customer_id: o.customer_id, order_id: o.id, phone: o.phone, run_at: new Date(now).toISOString() });
  if (error) {
    logger.warn({ err: error.message }, 'Compradores antigos: não entrou na fila');
    return null;
  }
  await supabase.from('settings').upsert({ key: BACKFILL_KEY, value: { last_at: new Date(now).toISOString(), sent: st.sent + 1, last_order: o.id }, updated_at: new Date().toISOString() });
  return o.id as string;
}

/** Painel: quantos já foram, quantos faltam (aproximado: sem conferir assinatura/compra de cada um) e o próximo horário. */
export async function backfillStatus() {
  const cfg = await getWaAudioConfig();
  const st = await backfillState();
  const target = await upsellTarget(cfg).catch(() => null);
  const remaining = target?.ck?.product_id ? (await backfillCandidates(cfg, target.ck, 0, false)).total : 0;
  const next = st.last_at ? new Date(st.last_at).getTime() + cfg.backfill.intervalMinutes * 60_000 : Date.now();
  const nextAt = inWindow(cfg, Math.max(next, Date.now())) ? Math.max(next, Date.now()) : nextWindowStart(cfg, Math.max(next, Date.now()));
  return { sent: st.sent, last_at: st.last_at, remaining, next_at: cfg.backfill.enabled && remaining ? new Date(nextAt).toISOString() : null };
}
