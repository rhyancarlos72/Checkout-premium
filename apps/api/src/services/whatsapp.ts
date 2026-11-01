import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { fetchWithTimeout, logger, sleep, supabase } from '../lib/core.js';

/**
 * WhatsApp via Evolution API — porta em TypeScript do whatsapp_api.php /
 * recuperacao_carrinho.php do checkout antigo (versão cordial / anti-ban):
 *  - rodízio sequencial de instâncias, pulando offline, com fallback se uma falhar;
 *  - a mesma instância não repete o mesmo texto nas últimas N mensagens;
 *  - variações de frases sem repetir para o mesmo telefone;
 *  - sem CAPS, sem falsa urgência, sem caracteres invisíveis, opt-out "SAIR";
 *  - tenta o número com e sem o 9º dígito e os formatos v2 e v1 da Evolution.
 * Configuração (URL + instâncias) fica em settings → chave "whatsapp".
 */

export const whatsappSchema = z.object({
  enabled: z.boolean().default(false),
  apiUrl: z.string().trim().url('URL da Evolution API inválida').or(z.literal('')).default(''),
  instances: z
    .array(z.object({ name: z.string().trim().min(1).max(60), token: z.string().trim().max(300).default(''), active: z.boolean().default(true) }))
    .max(20)
    .default([]),
  approved: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  recovery: z
    .object({
      enabled: z.boolean().default(true),
      firstMinutes: z.number().int().min(5).max(1440).default(20),
      secondMinutes: z.number().int().min(10).max(2880).default(180),
      includePix: z.boolean().default(true),
    })
    .default({ enabled: true, firstMinutes: 20, secondMinutes: 180, includePix: true }),
});
export type WhatsAppConfig = z.infer<typeof whatsappSchema>;

const KEY = 'whatsapp';
let cache: { value: WhatsAppConfig; at: number } | null = null;

export async function getWhatsAppConfig(): Promise<WhatsAppConfig> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const { data } = await supabase.from('settings').select('value').eq('key', KEY).maybeSingle();
  const value = whatsappSchema.parse((data as any)?.value ?? {});
  cache = { value, at: Date.now() };
  return value;
}

export async function saveWhatsAppConfig(value: WhatsAppConfig) {
  const { error } = await supabase.from('settings').upsert({ key: KEY, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  cache = null;
}

// ------------------------------------------------------------------ texto e número
/** Normaliza sem nunca zerar a mensagem (remove zero-width/BOM e controles; mantém \n). */
export function sanitizeText(input: string) {
  let t = String(input ?? '');
  t = t.replace(/[​-‏‪-‮⁠-⁤﻿­͏᠎]/g, '');
  t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return t.replace(/\r\n?/g, '\n').trim();
}

/** 55 + DDD + número (aceita com/sem 55, com zeros à esquerda, com máscara). */
export function normalizePhoneBR(raw: string | null | undefined) {
  let tel = String(raw ?? '').replace(/\D/g, '');
  if (!tel) return '';
  while (tel.length > 12 && tel.startsWith('5555')) tel = tel.slice(2);
  tel = tel.replace(/^0+/, '');
  if ((tel.length === 12 || tel.length === 13) && tel.startsWith('55') && Number(tel.slice(2, 4)) >= 11) return tel;
  if ((tel.length === 10 || tel.length === 11) && Number(tel.slice(0, 2)) >= 11) return `55${tel}`;
  return '';
}

/** Variantes com e sem o 9º dígito (a Evolution devolve 400 quando o JID não existe). */
export function phoneVariants(num: string) {
  const out = [num];
  if (num.length >= 12 && num.startsWith('55')) {
    const ddd = num.slice(2, 4);
    const rest = num.slice(4);
    if (rest.length === 9 && rest[0] === '9') out.push(`55${ddd}${rest.slice(1)}`);
    else if (rest.length === 8) out.push(`55${ddd}9${rest}`);
  }
  return [...new Set(out)];
}

const hashText = (t: string) => crypto.createHash('md5').update(t.replace(/https?:\S+/g, '').replace(/\s+/g, ' ').trim()).digest('hex');

// ------------------------------------------------------------------ histórico (memória do processo)
const MSG_HIST_PER_INSTANCE = 5;
const instanceHist = new Map<string, string[]>();
const phoneHist = new Map<string, Record<string, string[]>>();
let rotation = -1;

/** Escolhe item ainda não usado para este telefone (reseta ao usar 80% do pool). */
function pickFresh(pool: string[], phone: string, key: string) {
  const hist = phoneHist.get(phone) ?? {};
  let used = hist[key] ?? [];
  if (used.length >= Math.ceil(pool.length * 0.8)) used = [];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const item = shuffled.find((x) => !used.includes(hashText(x))) ?? shuffled[0];
  hist[key] = [...used, hashText(item)].slice(-40);
  phoneHist.set(phone, hist);
  if (phoneHist.size > 5000) phoneHist.delete(phoneHist.keys().next().value!);
  return item;
}

// ------------------------------------------------------------------ Evolution API
async function instanceOnline(cfg: WhatsAppConfig, name: string, token: string) {
  try {
    const res = await fetchWithTimeout(`${cfg.apiUrl.replace(/\/+$/, '')}/instance/connectionState/${encodeURIComponent(name)}`, { headers: { apikey: token }, timeoutMs: 5000 });
    // versões diferentes respondem 401/403/404/405 mesmo conectadas: deixa o envio decidir
    if ([401, 403, 404, 405].includes(res.status)) return true;
    if (!res.ok) return true;
    const j: any = await res.json().catch(() => ({}));
    const state = j?.instance?.state ?? j?.state ?? j?.instance?.connectionStatus;
    return state == null ? true : ['open', 'connected', 'online'].includes(String(state).toLowerCase());
  } catch {
    return false; // rede/timeout = offline
  }
}

async function post(cfg: WhatsAppConfig, name: string, token: string, payload: Record<string, unknown>) {
  try {
    const res = await fetchWithTimeout(`${cfg.apiUrl.replace(/\/+$/, '')}/message/sendText/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json', apikey: token, Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      timeoutMs: 30000,
    });
    if (res.ok) return { ok: true, http: res.status, error: '' };
    const j: any = await res.json().catch(() => ({}));
    const msg = j?.message ?? j?.error ?? '';
    return { ok: false, http: res.status, error: `HTTP ${res.status}${msg ? ` - ${typeof msg === 'string' ? msg : JSON.stringify(msg)}` : ''}` };
  } catch (e: any) {
    return { ok: false, http: 0, error: String(e?.message ?? e) };
  }
}

export type SendResult = { ok: boolean; error?: string; instance?: string };

/** Envia texto com rodízio de instâncias e fallback. */
export async function sendWhatsAppText(phoneRaw: string, message: string, cfgIn?: WhatsAppConfig): Promise<SendResult> {
  const cfg = cfgIn ?? (await getWhatsAppConfig());
  const instances = cfg.instances.filter((i) => i.active && i.name && i.token);
  if (!cfg.apiUrl || !instances.length) return { ok: false, error: 'WhatsApp não configurado (URL ou instâncias)' };
  const text = sanitizeText(message);
  if (!text) return { ok: false, error: 'Mensagem vazia' };
  const phone = normalizePhoneBR(phoneRaw);
  if (!phone) return { ok: false, error: 'Telefone inválido' };
  const hash = hashText(text);

  const tried = new Set<string>();
  let lastErr = 'nenhuma instância disponível';
  for (let attempt = 0; attempt < instances.length; attempt++) {
    // passe 1 respeita o anti-repetição; passe 2 só exige online e não tentada
    let chosen: (typeof instances)[number] | null = null;
    for (const respectHist of [true, false]) {
      for (let k = 1; k <= instances.length && !chosen; k++) {
        const idx = (rotation + k) % instances.length;
        const inst = instances[idx];
        if (tried.has(inst.name)) continue;
        if (respectHist && (instanceHist.get(inst.name) ?? []).includes(hash)) continue;
        if (!(await instanceOnline(cfg, inst.name, inst.token))) {
          tried.add(inst.name);
          continue;
        }
        chosen = inst;
        rotation = idx; // a próxima mensagem começa na instância seguinte
      }
      if (chosen) break;
    }
    if (!chosen) break;
    tried.add(chosen.name);

    let r = { ok: false, http: 0, error: 'não enviado' };
    outer: for (const num of phoneVariants(phone)) {
      for (const payload of [
        { number: num, text, delay: 3500, linkPreview: false }, // Evolution v2
        { number: num, options: { delay: 3500, presence: 'composing' }, textMessage: { text } }, // v1
      ]) {
        r = await post(cfg, chosen.name, chosen.token, payload);
        if (r.ok || r.http === 401 || r.http === 403) break outer;
      }
    }
    if (r.ok) {
      instanceHist.set(chosen.name, [...(instanceHist.get(chosen.name) ?? []), hash].slice(-MSG_HIST_PER_INSTANCE));
      return { ok: true, instance: chosen.name };
    }
    lastErr = `${chosen.name}: ${r.error}`;
  }
  return { ok: false, error: `Todas as instâncias falharam. Último erro: ${lastErr}` };
}

export async function instancesStatus() {
  const cfg = await getWhatsAppConfig();
  return Promise.all(cfg.instances.map(async (i) => ({ name: i.name, active: i.active, online: cfg.apiUrl && i.token ? await instanceOnline(cfg, i.name, i.token) : false })));
}

// ------------------------------------------------------------------ mensagens
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function buildApprovedMessage(p: { phone: string; name: string; totalCents: number; items: { name: string; url: string | null; kind?: string }[] }) {
  const nome = p.name.split(' ')[0] || p.name;
  const main = p.items.find((i) => i.kind === 'main') ?? p.items[0];
  const extras = p.items.filter((i) => i !== main);
  const pick = (pool: string[], key: string) => pickFresh(pool, p.phone, key);
  const saudacao = pick(
    [
      `Olá, ${nome}! Pagamento confirmado por aqui. ✅`,
      `Oi, ${nome}! Recebemos seu pagamento com sucesso.`,
      `Tudo certo, ${nome}: seu pagamento foi aprovado.`,
      `Olá, ${nome}! Sua compra foi confirmada.`,
      `Oi, ${nome}! Só passando para confirmar seu pagamento. 🙂`,
      `Olá, ${nome}! Compra registrada com sucesso.`,
      `Oi, ${nome}! Está tudo certo com o seu pagamento.`,
      `Olá, ${nome}! Seu pedido foi processado.`,
      `Oi, ${nome}! Pagamento aprovado — obrigado pela compra.`,
      `Olá, ${nome}! Recebemos sua confirmação de pagamento.`,
    ],
    'ep_saudacoes',
  );
  const rotVal = pick(['Valor', 'Total', 'Valor pago', 'Total da compra'], 'ep_rot_valor');
  const rotProd = pick(['Produto', 'Seu produto', 'Item adquirido', 'Produto adquirido'], 'ep_rot_prod');
  const convite = pick(['Segue seu link de acesso:', 'Aqui está seu acesso:', 'Link de acesso abaixo:', 'Pronto para usar — é só acessar:'], 'ep_convites');
  const lembrete = pick(['Também enviamos uma cópia para o seu e-mail.', 'Uma cópia foi enviada ao seu e-mail para consulta.', 'Guardamos uma cópia no seu e-mail também.', 'Você também recebe estas informações por e-mail.'], 'ep_lembretes');
  const fechamento = pick(
    ['Se precisar de qualquer coisa, é só responder por aqui.', 'Qualquer dúvida, estamos à disposição.', 'Bom proveito! Qualquer dúvida, é só chamar.', 'Obrigado pela confiança. Estamos por aqui se precisar.', 'Se surgir alguma dúvida, pode responder esta mensagem.'],
    'ep_fechamentos',
  );
  const titulo = pick(['Seus acessos:', 'Itens liberados:', 'Produtos disponíveis:'], 'ep_titulos');

  let m = `${saudacao}\n\n${rotVal}: R$ ${brl(p.totalCents)}\n\n`;
  if (!extras.length) {
    m += `${rotProd}: ${main?.name ?? ''}\n\n`;
    if (main?.url) m += `${convite}\n${main.url}\n\n`;
  } else {
    m += `${titulo}\n\n`;
    for (const it of [main, ...extras]) {
      if (!it) continue;
      m += `• ${it.name}\n${it.url ? `  ${it.url}\n` : ''}\n`;
    }
  }
  m += `${lembrete}\n\n${fechamento}\n\n— Se preferir não receber mensagens sobre esta compra, responda SAIR.`;
  return m;
}

export function buildRecoveryMessage(p: { phone: string; name: string; link: string; attempt: number; pixCode?: string | null }) {
  const n = p.name.split(' ')[0] || 'tudo bem';
  const pick = (pool: string[], key: string) => pickFresh(pool, p.phone, `t${p.attempt >= 2 ? 2 : 1}_${key}`);
  const blocks =
    p.attempt <= 1
      ? {
          abertura: [`Olá, ${n}! Tudo bem?`, `Oi, ${n}! Tudo certo?`, `Olá, ${n}! 🙂`, `Oi, ${n}!`, `Olá, ${n}! Espero que esteja bem.`, `Oi, ${n}! Como vai?`, `Olá, ${n}! Aqui é da equipe de atendimento.`, `Oi, ${n}! Passando rapidinho por aqui.`, `Olá, ${n}! Tudo tranquilo?`, `Oi, ${n}! Espero não incomodar.`],
          corpo: [
            'Seu pedido ficou salvo por aqui e ainda pode ser concluído quando você quiser.',
            'Vi que você começou um pedido e não chegou a finalizar. Deixei ele guardado para você.',
            'Notei que seu pedido ficou em aberto. Ele continua disponível, sem pressa.',
            'Seu pedido continua reservado no sistema, caso queira retomar.',
            'Percebi que o pagamento não foi concluído. Seu pedido segue salvo.',
            'Seu carrinho ainda está aqui do jeitinho que você deixou.',
            'O pedido que você iniciou ficou pendente, mas segue disponível.',
            'Deixei seu pedido guardado, caso tenha acontecido algum imprevisto na hora de finalizar.',
          ],
          cta: ['Se quiser finalizar, é só usar o link abaixo:', 'Para concluir quando for melhor pra você:', 'O link para finalizar é este:', 'Caso queira retomar, use este link:', 'Você pode concluir por aqui:', 'Deixo o link à disposição:', 'Se fizer sentido, dá para finalizar por aqui:'],
          fecho: [
            'Qualquer dúvida, é só responder esta mensagem.',
            'Se precisar de ajuda, estou por aqui.',
            'Qualquer dúvida sobre o produto ou o pagamento, me chame.',
            'Estou à disposição para o que precisar.',
            'Se preferir não seguir, tudo bem também — é só me avisar.',
            'Fico à disposição, sem compromisso.',
            'Se tiver qualquer pergunta, pode responder por aqui.',
          ],
        }
      : {
          abertura: [`Oi, ${n}! 🙂`, `Olá, ${n}! Tudo bem?`, `Oi, ${n}!`, `Olá, ${n}!`, `Oi, ${n}! Tudo certo por aí?`, `Olá, ${n}! Só passando rapidamente.`, `Oi, ${n}! Espero que esteja tudo bem.`, `Olá, ${n}! Último contato sobre seu pedido.`],
          corpo: [
            'Este é o segundo (e último) lembrete sobre o pedido que ficou em aberto.',
            'Só um segundo lembrete: seu pedido ainda está salvo, caso queira finalizar.',
            'Passando uma última vez para deixar seu pedido à disposição.',
            'Para não deixar em aberto: seu pedido ainda pode ser concluído.',
            'Este é o último aviso sobre o pedido pendente — depois disso não envio mais.',
            'Antes de encerrar o assunto, deixo seu pedido disponível mais uma vez.',
            'Seu pedido segue salvo, mas este é o último lembrete que envio.',
            'Só finalizando o assunto: o pedido continua disponível para conclusão.',
          ],
          cta: ['Link para concluir:', 'Se quiser retomar, o link continua ativo:', 'O link para finalizar é este:', 'Caso ainda faça sentido, é por aqui:', 'Deixo o link disponível:', 'Você pode concluir por este link:'],
          fecho: [
            'Se preferir não receber mais mensagens sobre esta compra, é só responder SAIR.',
            'Se não for o momento, sem problema algum — obrigado pela consideração.',
            'Caso não queira mais receber mensagens sobre isso, responda SAIR que eu paro por aqui.',
            'Se não tiver mais interesse, tudo certo — obrigado pelo interesse.',
            'Não quer mais receber mensagens? Basta responder SAIR.',
            'Sem compromisso: se preferir, responda SAIR e não envio mais nada.',
          ],
        };
  let m = `${pick(blocks.abertura, 'abertura')}\n\n${pick(blocks.corpo, 'corpo')}\n\n${pick(blocks.cta, 'cta')}\n${p.link}\n\n${pick(blocks.fecho, 'fecho')}`;
  if (p.pixCode) {
    const titulo = pick(
      [
        'Pix copia e cola (toque e segure para copiar):',
        'Se preferir, aqui está o Pix copia e cola:',
        'Código Pix para pagar direto no app do banco:',
        'Pix disponível abaixo — é só copiar e colar:',
        'Se for mais prático, use o Pix copia e cola:',
        'Deixo também o código Pix, caso prefira:',
        'Pix copia e cola, se preferir pagar pelo banco:',
        'Código Pix abaixo, caso seja mais fácil pra você:',
      ],
      'pix',
    );
    m += `\n\n${titulo}\n\n${p.pixCode}`;
  }
  return m;
}

// ------------------------------------------------------------------ disparos
async function logWa(orderId: string | null, event: string, r: SendResult) {
  await supabase.from('integration_logs').insert({
    integration: 'whatsapp',
    order_id: orderId,
    event,
    ok: r.ok,
    message: (r.ok ? `enviado (${r.instance})` : r.error ?? 'falhou').slice(0, 500),
  });
}

/** Pagamento aprovado → acesso por WhatsApp (uma vez por pedido). */
export async function sendWhatsAppApproved(orderId: string, items: { name: string; url: string | null; kind?: string }[]) {
  try {
    const cfg = await getWhatsAppConfig();
    if (!cfg.enabled || !cfg.approved.enabled) return;
    const { data: o } = await supabase.from('orders').select('id, checkout_id, total_cents, customer:customers(name, phone)').eq('id', orderId).maybeSingle();
    const order: any = o;
    if (!order?.customer?.phone) return;
    const { count } = await supabase.from('events').select('id', { count: 'exact', head: true }).eq('order_id', orderId).eq('type', 'wa_approved');
    if ((count ?? 0) > 0) return;
    await supabase.from('events').insert({ order_id: orderId, checkout_id: order.checkout_id, type: 'wa_approved', data: {} });
    const phone = normalizePhoneBR(order.customer.phone);
    const r = await sendWhatsAppText(phone, buildApprovedMessage({ phone, name: order.customer.name, totalCents: order.total_cents, items }), cfg);
    await logWa(orderId, 'approved', r);
  } catch (e) {
    logger.error({ err: e, orderId }, 'WhatsApp aprovado falhou');
  }
}

/** Recuperação de Pix pendente (até 2 tentativas espaçadas). Chamado pelo job a cada 2 min. */
export async function sendWhatsAppRecoveries(max = 10) {
  const cfg = await getWhatsAppConfig();
  if (!cfg.enabled || !cfg.recovery.enabled) return;
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data } = await supabase
    .from('orders')
    .select('id, checkout_id, status, created_at, public_token, pix_code, expires_at, customer_id, customer:customers(name, phone), checkout:checkouts(slug)')
    .in('status', ['pending', 'expired'])
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(200);
  let sent = 0;
  for (const o of (data ?? []) as any[]) {
    if (sent >= max) break;
    if (!o.customer?.phone || !o.checkout?.slug) continue;
    const minutes = (Date.now() - new Date(o.created_at).getTime()) / 60000;
    const { data: evs } = await supabase.from('events').select('id').eq('order_id', o.id).eq('type', 'wa_recovery');
    const done = evs?.length ?? 0;
    const next = done + 1;
    if (next > 2) continue;
    if ((next === 1 && minutes < cfg.recovery.firstMinutes) || (next === 2 && minutes < cfg.recovery.secondMinutes)) continue;
    // já comprou depois? não incomoda
    const { count: paid } = await supabase.from('orders').select('id', { count: 'exact', head: true }).eq('customer_id', o.customer_id).eq('status', 'paid').gte('created_at', since);
    if ((paid ?? 0) > 0) continue;
    // reserva a tentativa ANTES de enviar (nunca reenviar em duplicidade)
    const { error } = await supabase.from('events').insert({ order_id: o.id, checkout_id: o.checkout_id, type: 'wa_recovery', data: { attempt: next } });
    if (error) continue;
    const phone = normalizePhoneBR(o.customer.phone);
    const pixValid = cfg.recovery.includePix && o.status === 'pending' && o.pix_code && (!o.expires_at || new Date(o.expires_at) > new Date());
    const link = `${env.PUBLIC_URL}/checkout?produto_id=${o.checkout.slug}&recover=${o.public_token}&utm_source=whatsapp&utm_medium=recovery`;
    const r = await sendWhatsAppText(phone, buildRecoveryMessage({ phone, name: o.customer.name, link, attempt: next, pixCode: pixValid ? o.pix_code : null }), cfg);
    await logWa(o.id, `recovery_${next}`, r);
    sent++;
    await sleep(3500); // pausa natural entre envios
  }
}
