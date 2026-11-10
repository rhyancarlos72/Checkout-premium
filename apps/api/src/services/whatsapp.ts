import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { fetchWithTimeout, logger, shortOrderCode, sleep, supabase } from '../lib/core.js';
import { RECOVERY_ORDER_SELECT, sendRecoveryForOrder } from './email.js';
import { ensureMemberAccess } from './members.js';
import { isOwnerOrg, orgOfOrder, ownerOrgId } from '../lib/tenant.js';

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

/**
 * Normaliza a URL da Evolution: completa http://, remove barra final e caminhos do
 * painel web (ex.: "http://IP:8082/manager/" → "http://IP:8082"). Com "/manager" na URL,
 * toda chamada ia para /manager/instance/... e a Evolution respondia 404.
 */
export function normalizeEvolutionUrl(raw: string) {
  let t = raw.trim().replace(/\s+/g, '');
  if (!t) return '';
  if (!/^https?:\/\//i.test(t)) t = `http://${t}`;
  try {
    const u = new URL(t);
    const path = u.pathname.replace(/\/(manager|docs|swagger|instance|message|chat)(\/.*)?$/i, '').replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return t.replace(/\/+$/, '');
  }
}

export const whatsappSchema = z.object({
  enabled: z.boolean().default(false),
  // aceita "1.2.3.4:8082" sem protocolo (completa com http://) e remove barra final
  apiUrl: z.preprocess((v) => normalizeEvolutionUrl(String(v ?? '')),
    z.string().url('URL da Evolution API inválida (ex.: http://SEU-IP:8082)').or(z.literal('')),
  ).default(''),
  instances: z
    .array(z.object({ name: z.string().trim().min(1).max(60), token: z.string().trim().max(300).default(''), active: z.boolean().default(true) }))
    .max(20)
    .default([]),
  /** API Key global da Evolution (AUTHENTICATION_API_KEY): vale para todas as instâncias e permite buscar a lista */
  globalApiKey: z.string().trim().max(300).default(''),
  approved: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  recovery: z
    .object({
      enabled: z.boolean().default(true),
      firstMinutes: z.number().int().min(5).max(1440).default(20),
      secondMinutes: z.number().int().min(10).max(2880).default(180),
      thirdMinutes: z.number().int().min(30).max(2880).default(720), // 3º e último lembrete
      includePix: z.boolean().default(true),
    })
    .default({ enabled: true, firstMinutes: 20, secondMinutes: 180, thirdMinutes: 720, includePix: true }),
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
  tel = tel.replace(/^0+/, ''); // 0055…, 011…
  while (tel.length > 13 && tel.startsWith('55')) tel = tel.slice(2); // 55 repetido
  while (tel.length > 12 && tel.startsWith('5555')) tel = tel.slice(2);
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
/**
 * Rodízio de instâncias: cada envio sai pela instância usada há MAIS tempo (nunca usada = primeiro).
 * O histórico é recuperado dos logs ao iniciar, então o rodízio continua mesmo após reiniciar o servidor.
 * Assim nenhum número concentra os envios (menos risco de bloqueio).
 */
const lastUsed = new Map<string, number>();
let seeded: Promise<void> | null = null;
function seedLastUsed() {
  seeded ??= (async () => {
    try {
      const { data } = await supabase.from('integration_logs').select('message, created_at').eq('integration', 'whatsapp').eq('ok', true).order('created_at', { ascending: false }).limit(200);
      for (const l of (data ?? []) as any[]) {
        const name = /enviado \((.+)\)/.exec(String(l.message ?? ''))?.[1];
        if (name && !lastUsed.has(name)) lastUsed.set(name, new Date(l.created_at).getTime());
      }
    } catch {
      /* sem histórico: começa do zero */
    }
  })();
  return seeded;
}
export const rotationOrder = <T extends { name: string }>(list: T[]) =>
  list.map((inst, i) => ({ inst, i })).sort((a, b) => (lastUsed.get(a.inst.name) ?? 0) - (lastUsed.get(b.inst.name) ?? 0) || a.i - b.i).map((x) => x.inst);
export const markUsed = (name: string) => lastUsed.set(name, Date.now());

/** Escolhe item ainda não usado para este telefone (reseta ao usar 80% do pool). */
/**
 * Sorteia uma variação evitando repetir:
 *  - para o MESMO telefone (até ~80% do repertório), e
 *  - entre clientes diferentes em sequência (as últimas variações usadas por qualquer envio),
 * para que nenhum número dispare textos iguais em série (padrão que os filtros de spam detectam).
 */
const globalHist = new Map<string, string[]>();
function pickFresh(pool: string[], phone: string, key: string) {
  const hist = phoneHist.get(phone) ?? {};
  let used = hist[key] ?? [];
  if (used.length >= Math.ceil(pool.length * 0.8)) used = [];
  const recent = globalHist.get(key) ?? [];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const item =
    shuffled.find((x) => !used.includes(hashText(x)) && !recent.includes(hashText(x))) ??
    shuffled.find((x) => !used.includes(hashText(x))) ??
    shuffled[0];
  const h = hashText(item);
  hist[key] = [...used, h].slice(-40);
  phoneHist.set(phone, hist);
  globalHist.set(key, [...recent, h].slice(-Math.max(1, Math.floor(pool.length * 0.6))));
  if (phoneHist.size > 5000) phoneHist.delete(phoneHist.keys().next().value!);
  return item;
}
const firstName = (name: string, fallback: string) => {
  const f = (name.trim().split(/\s+/)[0] || '').toLowerCase();
  return f ? f.charAt(0).toUpperCase() + f.slice(1) : fallback;
};

// ------------------------------------------------------------------ Evolution API
/**
 * Endereço efetivo da Evolution. Se a URL configurada (ex.: http://IP:8082) não responder —
 * caso típico da Hostinger, que bloqueia saída para portas fora do padrão —, tenta
 * automaticamente o mesmo servidor via HTTPS na porta 443 (https://IP-com-traços.sslip.io,
 * publicado pelo script docs/evolution-proxy.sh). O que funcionar fica em cache por 10 min.
 */
const resolved = new Map<string, { url: string; at: number }>();
export function evolutionCandidates(apiUrl: string) {
  const list = [apiUrl];
  try {
    const u = new URL(apiUrl);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) {
      const path = u.pathname.replace(/\/+$/, '');
      list.push(`https://${u.hostname.replace(/\./g, '-')}.sslip.io${path}`);
      if (u.protocol === 'http:' && u.port && u.port !== '80') list.push(`http://${u.hostname}${path}`);
    }
  } catch {
    /* URL inválida: usa como está */
  }
  return list;
}
async function isEvolution(url: string, accept: (status: number, body: string) => boolean) {
  try {
    const res = await fetchWithTimeout(url, { timeoutMs: 6000 });
    return accept(res.status, await res.text().catch(() => ''));
  } catch {
    return false;
  }
}
export async function resolveBase(apiUrl: string): Promise<string> {
  const clean = normalizeEvolutionUrl(apiUrl);
  const hit = resolved.get(clean);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.url;
  const [first, ...alts] = evolutionCandidates(clean);
  let url = first;
  // a URL configurada vale com qualquer resposta HTTP; as alternativas precisam "parecer" a Evolution
  if (!(await isEvolution(first, () => true))) {
    for (const alt of alts) {
      if (await isEvolution(alt, (st, body) => st < 500 && /evolution/i.test(body))) {
        url = alt;
        break;
      }
    }
  }
  resolved.set(clean, { url, at: Date.now() });
  return url;
}
const base = (cfg: WhatsAppConfig) => resolveBase(cfg.apiUrl);
/** Token usado para a instância: o dela ou, se vazio, a API Key global. */
export const tokenFor = (cfg: WhatsAppConfig, inst: { token?: string }) => inst.token || cfg.globalApiKey || '';

/** Traduz falhas de rede do Node em mensagens que dizem o que corrigir. */
export function describeNetworkError(e: any, apiUrl: string): { message: string; hint: string } {
  const code = String(e?.cause?.code ?? e?.code ?? '');
  const port = (() => {
    try {
      const u = new URL(apiUrl);
      return u.port || (u.protocol === 'https:' ? '443' : '80');
    } catch {
      return '';
    }
  })();
  if (e?.name === 'AbortError' || /TIMEOUT|ETIMEDOUT/.test(code))
    return {
      message: `Tempo esgotado ao conectar em ${apiUrl}`,
      hint: `O servidor do checkout não conseguiu chegar na Evolution. Causa mais comum: a hospedagem (Hostinger) bloqueia saída para a porta ${port}. Solução: publique a Evolution atrás de um domínio com HTTPS na porta 443 (ex.: https://evolution.seudominio.com via Nginx/Traefik) e use essa URL aqui. Confira também o firewall da VPS da Evolution.`,
    };
  if (code === 'ECONNREFUSED')
    return { message: `Conexão recusada em ${apiUrl}`, hint: 'O IP respondeu, mas nada está escutando nessa porta. Verifique se a Evolution API está rodando e se a porta está correta.' };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { message: `Endereço não encontrado: ${apiUrl}`, hint: 'O domínio não existe ou está digitado errado. Confira a URL da Evolution.' };
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return { message: 'A conexão foi encerrada no meio', hint: 'Pode ser firewall/proxy no caminho ou a Evolution reiniciando. Tente de novo; se persistir, use HTTPS na porta 443.' };
  if (/CERT|SSL|TLS/i.test(code)) return { message: 'Certificado HTTPS inválido na URL da Evolution', hint: 'O certificado SSL do domínio da Evolution está expirado ou é autoassinado. Use um certificado válido (ex.: Let’s Encrypt).' };
  return { message: `Falha de rede: ${e?.message ?? code ?? 'desconhecida'}`, hint: 'Confira a URL da Evolution API e se ela está acessível pela internet.' };
}

export interface InstanceCheck {
  name: string;
  active: boolean;
  ok: boolean;
  reachable: boolean;
  http: number;
  state: string | null;
  message: string;
  hint?: string;
}

/** Verifica uma instância e explica o resultado (rede, token, nome, conexão do WhatsApp). */
export async function checkInstance(cfg: WhatsAppConfig, instIn: { name: string; token: string; active?: boolean }): Promise<InstanceCheck> {
  const inst = { ...instIn, token: tokenFor(cfg, instIn) };
  const r: InstanceCheck = { name: inst.name, active: inst.active !== false, ok: false, reachable: false, http: 0, state: null, message: '' };
  if (!inst.token) return { ...r, message: 'Token não informado', hint: 'Cole o token (apikey) desta instância ou a API Key global da Evolution. Não é o número do WhatsApp. Dica: use “Buscar instâncias da Evolution”.' };
  try {
    const res = await fetchWithTimeout(`${await base(cfg)}/instance/connectionState/${encodeURIComponent(inst.name)}`, { headers: { apikey: inst.token }, timeoutMs: 8000 });
    r.reachable = true;
    r.http = res.status;
    const j: any = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403)
      return { ...r, message: `Token recusado (HTTP ${res.status})`, hint: 'O token não pertence a esta instância. Copie o token (apikey) da instância no painel da Evolution. Também funciona a API Key global da Evolution.' };
    if (res.status === 404)
      return { ...r, message: `Instância “${inst.name}” não encontrada (HTTP 404)`, hint: 'O nome precisa ser exatamente igual ao da Evolution (maiúsculas/minúsculas contam).' };
    if (!res.ok) return { ...r, ok: true, message: `A Evolution respondeu HTTP ${res.status} na verificação; o envio será tentado mesmo assim.` };
    const state = j?.instance?.state ?? j?.state ?? j?.instance?.connectionStatus ?? null;
    r.state = state == null ? null : String(state);
    if (state == null) return { ...r, ok: true, message: 'Instância encontrada (estado não informado pela Evolution).' };
    if (['open', 'connected', 'online'].includes(String(state).toLowerCase())) return { ...r, ok: true, message: 'Conectada ao WhatsApp' };
    return { ...r, message: `WhatsApp desconectado nesta instância (estado: ${state})`, hint: 'Abra a Evolution, entre na instância e escaneie o QR Code com o celular do número para conectar.' };
  } catch (e) {
    const d = describeNetworkError(e, cfg.apiUrl);
    return { ...r, message: d.message, hint: d.hint };
  }
}

/** Explica a resposta de erro do envio. */
function explainSendError(http: number, body: any, raw: string): { error: string; hint?: string } {
  const flat = JSON.stringify(body ?? raw ?? '');
  if (http === 400 && /exists"?\s*:\s*false/i.test(flat)) return { error: 'Este número não tem WhatsApp', hint: 'Confira o DDD e o número do cliente.' };
  if (http === 401 || http === 403) return { error: `Token recusado ao enviar (HTTP ${http})`, hint: 'Copie de novo o token (apikey) da instância na Evolution.' };
  if (http === 404) {
    const said = body?.response?.message ?? body?.message ?? raw;
    const txt = typeof said === 'string' ? said : JSON.stringify(said ?? '');
    return {
      error: `A Evolution respondeu 404 ao enviar${txt ? `: ${txt.slice(0, 160)}` : ''}`,
      hint: 'O nome cadastrado não corresponde a uma instância da Evolution (ou o token é de outra instância). Clique em “Buscar instâncias da Evolution” e importe com o nome exato — informe a API Key global para listar todas.',
    };
  }
  if (/connection closed|not connected|connectionstate|is not open|closed/i.test(flat))
    return { error: 'O WhatsApp desta instância está desconectado', hint: 'Abra a Evolution (ou use “Conectar número” em Integrações) e leia o QR Code com o celular do número.' };
  if (/jid|invalid.*number|number.*invalid|bad.*number/i.test(flat)) return { error: 'Número de telefone inválido para o WhatsApp', hint: 'Confira o DDD e o número do cliente.' };
  if (/rate|too many|limit/i.test(flat) && http === 429) return { error: 'Muitas mensagens em pouco tempo (limite da Evolution/WhatsApp)', hint: 'Aguarde alguns minutos; o rodízio tenta outro número.' };
  const msg = body?.response?.message ?? body?.message ?? body?.error ?? raw;
  return { error: `HTTP ${http}${msg ? ` - ${typeof msg === 'string' ? msg.slice(0, 200) : JSON.stringify(msg).slice(0, 200)}` : ''}` };
}

async function post(cfg: WhatsAppConfig, name: string, token: string, payload: Record<string, unknown>) {
  try {
    const res = await fetchWithTimeout(`${await base(cfg)}/message/sendText/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json', apikey: token, Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      timeoutMs: 30000,
    });
    if (res.ok) return { ok: true, http: res.status, error: '', hint: undefined as string | undefined };
    const raw = await res.text().catch(() => '');
    let body: any = null;
    try {
      body = JSON.parse(raw);
    } catch {
      /* texto */
    }
    const x = explainSendError(res.status, body, raw);
    return { ok: false, http: res.status, error: x.error, hint: x.hint };
  } catch (e: any) {
    const d = describeNetworkError(e, cfg.apiUrl);
    return { ok: false, http: 0, error: d.message, hint: d.hint };
  }
}

/** Instâncias que já mostraram ser Evolution v2 (não adianta tentar o formato v1 nelas). */
const evolutionV2 = new Set<string>();
const isExistsFalse = (r: { http: number; error: string }) => r.http === 400 && /não tem WhatsApp/i.test(r.error);

export type SendResult = { ok: boolean; error?: string; hint?: string; instance?: string };

/** Envia texto com rodízio de instâncias e fallback; em falha, diz o motivo de cada instância. */
export async function sendWhatsAppText(phoneRaw: string, message: string, cfgIn?: WhatsAppConfig, opts: { instance?: string } = {}): Promise<SendResult> {
  const cfg = cfgIn ?? (await getWhatsAppConfig());
  if (!cfg.apiUrl) return { ok: false, error: 'URL da Evolution API não configurada', hint: 'Preencha a URL em Integrações → WhatsApp.' };
  // opts.instance: continuação de uma conversa (ex.: o código Pix logo depois do lembrete) sai do MESMO número
  const instances = cfg.instances.filter((i) => i.active && i.name && tokenFor(cfg, i) && (!opts.instance || i.name === opts.instance)).map((i) => ({ ...i, token: tokenFor(cfg, i) }));
  if (!instances.length) return { ok: false, error: 'Nenhuma instância ativa com token', hint: 'Adicione ao menos uma instância com nome e token e deixe-a ativa.' };
  const text = sanitizeText(message);
  if (!text) return { ok: false, error: 'Mensagem vazia' };
  const phone = normalizePhoneBR(phoneRaw);
  if (!phone) return { ok: false, error: `Telefone inválido: ${phoneRaw || '(vazio)'}`, hint: 'Use DDD + número, ex.: (11) 99999-9999.' };
  const hash = hashText(text);
  await seedLastUsed();

  const tried = new Set<string>();
  const reasons: string[] = [];
  let lastHint: string | undefined;
  for (let attempt = 0; attempt < instances.length; attempt++) {
    let chosen: (typeof instances)[number] | null = null;
    for (const respectHist of [true, false]) {
      for (const inst of rotationOrder(instances)) {
        if (chosen) break;
        if (tried.has(inst.name)) continue;
        if (respectHist && (instanceHist.get(inst.name) ?? []).includes(hash)) continue;
        const chk = await checkInstance(cfg, inst);
        if (!chk.ok) {
          tried.add(inst.name);
          reasons.push(`${inst.name}: ${chk.message}`);
          lastHint = chk.hint ?? lastHint;
          continue;
        }
        chosen = inst;
        markUsed(inst.name); // reserva já na escolha: envios simultâneos vão para instâncias diferentes
      }
      if (chosen) break;
    }
    if (!chosen) break;
    tried.add(chosen.name);

    let r: { ok: boolean; http: number; error: string; hint?: string } = { ok: false, http: 0, error: 'não enviado' };
    outer: for (const num of phoneVariants(phone)) {
      for (const n of [num, `${num}@s.whatsapp.net`]) {
        // Evolution v2: { number, text } — o formato v1 só é tentado se a instância não for v2
        const v2 = await post(cfg, chosen.name, chosen.token, { number: n, text, delay: 3500, linkPreview: false });
        r = v2;
        if (v2.ok || v2.http === 401 || v2.http === 403 || v2.http === 0) break outer;
        if (!evolutionV2.has(chosen.name) && !isExistsFalse(v2)) {
          const v1 = await post(cfg, chosen.name, chosen.token, { number: n, options: { delay: 3500, presence: 'composing' }, textMessage: { text } });
          if (v1.ok) {
            r = v1;
            break outer;
          }
          // a v1 reclamando de "text" prova que a instância é v2: guarda e mostra o erro REAL (o da v2)
          if (/requires property\W+text/i.test(v1.error)) evolutionV2.add(chosen.name);
          else if (v1.http === 401 || v1.http === 403) (r = v1);
        }
        if (r.http !== 404) break; // formato @s.whatsapp.net só é tentado se a Evolution respondeu 404
      }
    }
    if (r.ok) {
      instanceHist.set(chosen.name, [...(instanceHist.get(chosen.name) ?? []), hash].slice(-MSG_HIST_PER_INSTANCE));
      return { ok: true, instance: chosen.name };
    }
    reasons.push(`${chosen.name}: ${r.error}`);
    lastHint = r.hint ?? lastHint;
  }
  return { ok: false, error: reasons.length ? reasons.join(' | ') : 'Nenhuma instância disponível', hint: lastHint };
}

export interface EvolutionInstance {
  name: string;
  status: string | null;
  connected: boolean;
  number: string | null;
  profileName: string | null;
  token: string | null;
}

/** Lista as instâncias da Evolution (v1 e v2) com nome exato, status e número do WhatsApp. */
export async function fetchEvolutionInstances(apiUrl: string, key: string): Promise<{ ok: true; items: EvolutionInstance[] } | { ok: false; error: string; hint?: string }> {
  if (!apiUrl) return { ok: false, error: 'Informe a URL da Evolution API' };
  if (!key) return { ok: false, error: 'Informe a API Key global (ou o token de uma instância)', hint: 'A API Key global fica na variável AUTHENTICATION_API_KEY da Evolution. Com o token de uma instância, só ela aparece.' };
  try {
    const res = await fetchWithTimeout(`${await resolveBase(apiUrl)}/instance/fetchInstances`, { headers: { apikey: key }, timeoutMs: 10000 });
    const raw = await res.text();
    let j: any = null;
    try {
      j = JSON.parse(raw);
    } catch {
      /* não-JSON */
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: `Chave recusada pela Evolution (HTTP ${res.status})`, hint: 'Use a API Key global (AUTHENTICATION_API_KEY) da Evolution.' };
    if (!res.ok) return { ok: false, error: `A Evolution respondeu HTTP ${res.status} ao listar instâncias`, hint: typeof j?.message === 'string' ? j.message : undefined };
    const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.instances) ? j.instances : j ? [j] : [];
    const onlyDigits = (v: any) => (v ? String(v).split('@')[0].replace(/\D/g, '') || null : null);
    const items = list
      .map((x: any) => {
        const i = x?.instance ?? x; // v1: { instance: {...} } | v2: {...}
        const name = i?.name ?? i?.instanceName ?? null;
        const status = i?.connectionStatus ?? i?.status ?? i?.state ?? null;
        return name
          ? {
              name: String(name),
              status: status ? String(status) : null,
              connected: ['open', 'connected', 'online'].includes(String(status ?? '').toLowerCase()),
              number: onlyDigits(i?.ownerJid ?? i?.owner ?? i?.number ?? i?.wuid),
              profileName: i?.profileName ?? null,
              token: i?.token ?? i?.apikey ?? i?.hash?.apikey ?? (typeof i?.hash === 'string' ? i.hash : null) ?? null,
            }
          : null;
      })
      .filter(Boolean) as EvolutionInstance[];
    return { ok: true, items };
  } catch (e) {
    const d = describeNetworkError(e, apiUrl);
    return { ok: false, error: d.message, hint: d.hint };
  }
}

export async function instancesStatus() {
  const cfg = await getWhatsAppConfig();
  if (!cfg.apiUrl) return [];
  return Promise.all(cfg.instances.map((i) => checkInstance(cfg, i)));
}

/** Diagnóstico passo a passo exibido no painel. */
export async function diagnoseWhatsApp(extra: { jobsEnabled: boolean; lastJobRunAt: number | null }) {
  const cfg = await getWhatsAppConfig();
  type Step = { label: string; ok: boolean | null; detail: string; hint?: string };
  const steps: Step[] = [];
  steps.push(
    cfg.enabled
      ? { label: 'Envio automático', ok: true, detail: 'Ativado' }
      : { label: 'Envio automático', ok: false, detail: 'Desativado', hint: 'Ligue o botão “Ativado” no topo desta seção e salve. Sem isso, nada é enviado automaticamente (o teste manual funciona mesmo assim).' },
  );
  if (!cfg.apiUrl) {
    steps.push({ label: 'URL da Evolution', ok: false, detail: 'Não preenchida', hint: 'Informe a URL, ex.: https://evolution.seudominio.com' });
    return { steps, instances: [] as InstanceCheck[] };
  }
  let url: URL | null = null;
  try {
    url = new URL(cfg.apiUrl);
  } catch {
    /* validado no schema */
  }
  steps.push({
    label: 'URL da Evolution',
    ok: true,
    detail: cfg.apiUrl,
    hint: url && url.protocol === 'http:' && url.port && !['80'].includes(url.port) ? `Usando HTTP na porta ${url.port}. Se der “tempo esgotado”, a hospedagem provavelmente bloqueia essa porta: use um domínio HTTPS (porta 443) apontando para a Evolution.` : undefined,
  });
  // alcance do servidor (qualquer resposta HTTP já prova que chegou lá)
  resolved.delete(normalizeEvolutionUrl(cfg.apiUrl)); // diagnóstico sempre testa de novo
  const effective = await base(cfg);
  try {
    const res = await fetchWithTimeout(effective, { timeoutMs: 8000 });
    const body = await res.text().catch(() => '');
    const version = body.match(/"version"\s*:\s*"([^"]+)"/)?.[1];
    steps.push({
      label: 'Conexão com o servidor da Evolution',
      ok: true,
      detail: `O servidor respondeu (HTTP ${res.status})${version ? ` · Evolution ${version}` : ''}${effective !== cfg.apiUrl ? ` · usando ${effective} (a URL original não respondeu)` : ''}`,
    });
  } catch (e) {
    const d = describeNetworkError(e, cfg.apiUrl);
    const alt = evolutionCandidates(cfg.apiUrl)[1];
    steps.push({
      label: 'Conexão com o servidor da Evolution',
      ok: false,
      detail: d.message,
      hint: `${d.hint}${alt ? ` Solução (1 comando, sem comprar domínio): entre na VPS da Evolution como root e rode: curl -fsSL https://raw.githubusercontent.com/rhyancarlos72/Checkout-premium/main/docs/evolution-proxy.sh | bash — ele publica ${alt} (HTTPS, porta 443, que a Hostinger libera) e o checkout passa a usar esse endereço sozinho. Depois clique em “Testar conexão” de novo.` : ''}`,
    });
  }
  const instances = await Promise.all(cfg.instances.map((i) => checkInstance(cfg, i)));
  const usable = instances.filter((i) => i.active && i.ok);
  steps.push(
    !cfg.instances.length
      ? { label: 'Instâncias', ok: false, detail: 'Nenhuma cadastrada', hint: 'Adicione ao menos uma instância (nome + token).' }
      : usable.length
        ? { label: 'Instâncias', ok: true, detail: `${usable.length} de ${cfg.instances.length} prontas para enviar` }
        : { label: 'Instâncias', ok: false, detail: 'Nenhuma instância ativa está pronta', hint: 'Veja abaixo o motivo de cada instância.' },
  );
  steps.push(
    cfg.approved.enabled || cfg.recovery.enabled
      ? { label: 'Mensagens automáticas', ok: true, detail: [cfg.approved.enabled && 'pagamento aprovado', cfg.recovery.enabled && `recuperação (${cfg.recovery.firstMinutes} min / ${cfg.recovery.secondMinutes} min / ${cfg.recovery.thirdMinutes} min)`].filter(Boolean).join(' + ') }
      : { label: 'Mensagens automáticas', ok: false, detail: 'Nenhuma ligada', hint: 'Ligue “Enviar acesso quando o pagamento for aprovado” e/ou “Recuperar Pix pendente”.' },
  );
  const mins = extra.lastJobRunAt ? Math.round((Date.now() - extra.lastJobRunAt) / 60000) : null;
  steps.push(
    !extra.jobsEnabled
      ? { label: 'Rotina de recuperação', ok: false, detail: 'JOBS_ENABLED=false', hint: 'A recuperação de Pix roda nos jobs. Remova JOBS_ENABLED=false ou configure o cron de /api/jobs/run.' }
      : mins === null || mins > 10
        ? { label: 'Rotina de recuperação', ok: null, detail: mins === null ? 'Ainda não rodou desde que o servidor iniciou' : `Última execução há ${mins} min`, hint: 'Se a hospedagem “dorme” o app parado, crie um Cron Job na Hostinger chamando /api/jobs/run a cada 5 min (veja docs/DEPLOY.md).' }
        : { label: 'Rotina de recuperação', ok: true, detail: `Rodando (última execução há ${mins} min)` },
  );
  return { steps, instances };
}

// ------------------------------------------------------------------ mensagens
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function buildApprovedMessage(p: { phone: string; name: string; totalCents: number; items: { name: string; url: string | null; note?: string | null; kind?: string }[]; accessUrl?: string; members?: { loginUrl: string; email: string; password: string | null } | null }) {
  const nome = firstName(p.name, 'tudo bem');
  const main = p.items.find((i) => i.kind === 'main') ?? p.items[0];
  const extras = p.items.filter((i) => i !== main);
  const pick = (pool: string[], key: string) => pickFresh(pool, p.phone, key);
  const valor = `R$ ${brl(p.totalCents)}`;
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
      `Oi, ${nome}! Pagamento aprovado, obrigado pela compra.`,
      `Olá, ${nome}! Recebemos sua confirmação de pagamento.`,
      `${nome}, seu Pix caiu certinho por aqui! 🎉`,
      `Oba, ${nome}! Pagamento recebido.`,
      `Oi, ${nome}, tudo bem? Seu pagamento foi confirmado.`,
      `Olá, ${nome}! Que bom ter você com a gente. Pagamento aprovado.`,
      `Oi, ${nome}! Confirmamos o seu Pix agora há pouco.`,
      `${nome}, deu tudo certo com a sua compra! ✅`,
      `Olá, ${nome}! Seu acesso já está liberado.`,
      `Oi, ${nome}! Pagamento identificado com sucesso.`,
      `Olá, ${nome}, obrigado pela confiança! Pagamento confirmado.`,
      `Oi, ${nome}! Passando para avisar que seu pedido foi aprovado.`,
      `Boa notícia, ${nome}: seu pagamento foi aprovado!`,
      `Olá, ${nome}! Recebemos tudo certinho.`,
      `Oi, ${nome}! Compra concluída com sucesso. 🙌`,
      `Olá, ${nome}! Seu pedido está confirmado e liberado.`,
    ],
    'ep_saudacoes',
  );
  const rotVal = pick(['Valor', 'Total', 'Valor pago', 'Total da compra', 'Valor do pedido', 'Pago'], 'ep_rot_valor');
  const rotProd = pick(['Produto', 'Seu produto', 'Item adquirido', 'Produto adquirido', 'Você comprou', 'Pedido', 'Sua compra'], 'ep_rot_prod');
  const convite = pick(
    ['👉 Seu link de acesso:', '👉 Acesse aqui:', '👉 Link do seu produto:', '👉 É só tocar para acessar:', '📥 Seu acesso:', '🔗 Link para acessar:', '👇 Acesse pelo link abaixo:', '📂 Seu material está aqui:', '✅ Acesso liberado neste link:', '👉 Para abrir o seu produto:', '🔓 Seu link exclusivo:', '📲 Toque para acessar:'],
    'ep_convites',
  );
  const lembrete = pick(
    ['Também enviamos uma cópia para o seu e-mail.', 'Uma cópia foi enviada ao seu e-mail para consulta.', 'Guardamos uma cópia no seu e-mail também.', 'Você também recebe estas informações por e-mail.', 'Mandamos tudo para o seu e-mail também, caso precise depois.', 'Uma cópia do acesso também está no seu e-mail.', 'Se perder esta mensagem, o acesso também está no seu e-mail.', 'O mesmo link chegou no seu e-mail, para guardar.', 'Confira também seu e-mail (e a caixa de spam, por garantia).', 'Deixamos uma cópia no seu e-mail para você ter sempre à mão.'],
    'ep_lembretes',
  );
  const dica = pick(
    ['Dica: salve este contato para não perder o link.', 'Dica: no Google Drive, entre com sua conta Google para baixar.', 'Dica: abra pelo navegador do celular ou do computador, como preferir.', 'Dica: baixe o material para ter acesso mesmo sem internet.', 'Dica: se aparecer "solicitar acesso", entre com uma conta Google e tente de novo.', 'Dica: guarde esta conversa para encontrar o link rapidinho depois.', 'Dica: no computador, a visualização dos arquivos fica ainda melhor.', 'Dica: marque esta mensagem com estrela para achar fácil depois.', 'Dica: se o arquivo for grande, aguarde alguns segundos para carregar.'],
    'ep_dicas',
  );
  const fechamento = pick(
    [
      'Se precisar de qualquer coisa, é só responder por aqui.',
      'Qualquer dúvida, estamos à disposição.',
      'Bom proveito! Qualquer dúvida, é só chamar.',
      'Obrigado pela confiança. Estamos por aqui se precisar.',
      'Se surgir alguma dúvida, pode responder esta mensagem.',
      'Aproveite bastante! Estamos por aqui para ajudar.',
      'Desejamos ótimos resultados! Qualquer coisa, chame.',
      'Muito obrigado pela compra! Conte com a gente.',
      'Esperamos que goste! Se precisar, responda aqui.',
      'Ficamos felizes com sua compra. Qualquer dúvida, é só falar.',
      'Bons estudos e bom uso! Estamos à disposição.',
      'Valeu pela confiança! Precisando, é só mandar mensagem.',
      'Qualquer dificuldade para acessar, responda que a gente resolve.',
      'Seja muito bem-vindo(a)! Estamos por aqui.',
    ],
    'ep_fechamentos',
  );
  const optout = pick(
    ['— Se preferir não receber mensagens sobre esta compra, responda SAIR.', '— Para parar as mensagens sobre este pedido, responda SAIR.', '— Para não receber mais avisos sobre esta compra, responda SAIR.', '— Caso não queira mais mensagens por aqui, responda SAIR.', '— Prefere não receber mensagens? Basta que você responda SAIR.'],
    'ep_optout',
  );
  // pedido curto e humano para a pessoa responder: com resposta, o WhatsApp deixa o link azul (clicável)
  const pedeOi = pick(
    [
      'Me responde um *oi* aqui rapidinho pro link ficar azul 😉',
      'Responde com um *oi* pra liberar o link (ele fica azul na hora).',
      'Manda um *oi* aqui que o link fica azul e clicável 👇',
      'Só responde *oi* pro link ficar azul, tá? 🙂',
      'Me dá um *oi* aqui pro link aparecer azul certinho.',
      'Antes de tudo: responde *oi* pro link ficar azul 😊',
      'Se o link estiver cinza, é só responder *oi* que ele fica azul.',
      'Responde um *oi* rapidinho? Assim o link fica azul pra você tocar.',
      'Me manda um *oi* pra eu saber que chegou (e o link fica azul).',
      'Dá um *oi* aqui que o link já fica azul e clicável 😉',
    ],
    'ep_pede_oi',
  );
  const titulo = pick(['Seus acessos:', 'Itens liberados:', 'Produtos disponíveis:', 'Tudo o que você adquiriu:', 'Seus produtos:', 'Acessos liberados:'], 'ep_titulos');
  const linkOf = (it?: { url: string | null }) => it?.url || p.accessUrl || null;

  // corpo com os acessos
  let acessos = '';
  if (!extras.length) {
    const link = linkOf(main);
    if (main?.note) acessos += `${main.note}\n\n`;
    if (link) acessos += `${convite}\n${link}`;
  } else {
    acessos += `${titulo}\n\n`;
    for (const it of [main, ...extras]) {
      if (!it) continue;
      const link = linkOf(it);
      acessos += `• *${it.name}*\n${it.note ? `  ${it.note}\n` : ''}${link ? `  ${link}\n` : ''}\n`;
    }
    acessos = acessos.trimEnd();
  }
  // área de membros: login (e-mail) e a senha gerada na compra
  if (p.members) {
    const titulo = pick(['🎓 *Seu acesso à área de membros*', '🎓 *Área de membros*', '🔐 *Seus dados de acesso*', '🎓 *Login da área de membros*'], 'ep_membros');
    acessos += `\n\n${titulo}\nSite: ${p.members.loginUrl}\nE-mail: ${p.members.email}\nSenha: ${p.members.password ? `*${p.members.password}*` : 'a mesma que você já usa'}`;
  }
  const resumo = extras.length ? `${rotVal}: ${valor}` : `${rotProd}: *${main?.name ?? ''}*\n${rotVal}: ${valor}`;

  // estrutura também varia (não só as frases)
  const layout = pick(['a', 'b', 'c', 'd'], 'ep_layout');
  const partes =
    layout === 'a'
      ? [saudacao, pedeOi, resumo, acessos, `${dica}\n${lembrete}`, fechamento]
      : layout === 'b'
        ? [`${saudacao}\n${pedeOi}`, acessos, resumo, lembrete, `${dica}\n\n${fechamento}`]
        : layout === 'c'
          ? [saudacao, `${resumo}\n\n${pedeOi}\n${acessos}`, `${lembrete} ${fechamento}`]
          : [saudacao, resumo, pedeOi, acessos, dica, `${lembrete}\n${fechamento}`];
  return `${partes.filter(Boolean).join('\n\n')}\n\n${optout}`;
}

export function buildRecoveryMessage(p: { phone: string; name: string; link: string; attempt: number; pixCode?: string | null; product?: string | null; totalCents?: number | null }) {
  const n = firstName(p.name, 'tudo bem');
  const prod = (p.product || 'seu produto').trim();
  const P = `*${prod}*`;
  const valor = p.totalCents ? `R$ ${brl(p.totalCents)}` : '';
  const t = p.attempt >= 3 ? 3 : p.attempt === 2 ? 2 : 1; // 3 = último lembrete
  const pick = (pool: string[], key: string) => pickFresh(pool, p.phone, `t${t}_${key}`);

  // mensagens curtas: saudação + 1 frase forte + link (+ Pix) + saída
  const corpo =
    t === 1
      ? pick(
          [
            `${n}, seu ${P} ficou a um passo de ser seu. Falta só o Pix.`,
            `Oi, ${n}! Vi que você gerou o Pix do ${P} e não finalizou. Ele continua reservado pra você.`,
            `${n}, seu acesso ao ${P} já está separado. É só pagar o Pix que ele chega na hora.`,
            `Oi, ${n}! O ${P} está te esperando. Leva menos de 1 minuto para concluir.`,
            `${n}, deixei seu pedido do ${P} guardado${valor ? ` com o mesmo valor de ${valor}` : ''}. Bora finalizar?`,
            `Oi, ${n}! Faltou só um toque: pague o Pix e receba o ${P} agora mesmo.`,
            `${n}, seu ${P} está pronto pra ser liberado. Só falta confirmar o Pix.`,
            `Oi, ${n}! Não perca o ${P}${valor ? ` por ${valor}` : ''}. Seu Pix ainda está ativo.`,
            `${n}, tá quase! Seu ${P} só espera a confirmação do Pix.`,
            `Oi, ${n}! Separei o ${P} pra você. Finaliza em segundos pelo Pix.`,
            `${n}, seu pedido do ${P} está aberto. Paga agora e já recebe o acesso.`,
            `Oi, ${n}! Seu Pix do ${P} ainda vale. Que tal concluir agora?`,
          ],
          'corpo',
        )
      : t === 2
        ? pick(
            [
              `${n}, quem pagou o ${P} já está usando. Só falta o seu Pix.`,
              `Oi, ${n}! Seu ${P} ainda está reservado, mas não por muito tempo.`,
              `${n}, passando pra lembrar: o ${P}${valor ? ` por ${valor}` : ''} continua disponível pra você.`,
              `Oi, ${n}! Muita gente esquece de finalizar no app do banco. Seu ${P} ainda está aqui.`,
              `${n}, o acesso ao ${P} é liberado na hora em que o Pix cai. Bora?`,
              `Oi, ${n}! Seu pedido do ${P} segue guardado. Se o Pix venceu, gere outro em 1 toque.`,
              `${n}, não deixe o ${P} pra depois: o pagamento leva segundos.`,
              `Oi, ${n}! Seu ${P} continua te esperando, com acesso imediato após o Pix.`,
              `${n}, falta pouco: conclua o Pix e o ${P} chega no seu e-mail na hora.`,
            ],
            'corpo',
          )
        : pick(
            [
              `${n}, último aviso: seu pedido do ${P} vai ser encerrado.`,
              `Oi, ${n}! É a última vez que te aviso: o ${P} ainda pode ser seu hoje.`,
              `${n}, depois desta mensagem seu pedido do ${P} sai da reserva.`,
              `Oi, ${n}! Última chance de garantir o ${P}${valor ? ` por ${valor}` : ''}.`,
              `${n}, vou liberar a reserva do ${P}. Se ainda quiser, é agora.`,
            ],
            'corpo',
          );
  const cta = pick(t === 3 ? ['👉 Garanta agora:', '👉 Finalize aqui:', '👉 Último link:'] : ['👉 Pague aqui:', '👉 Finalize agora:', '👉 Seu Pix:', '👉 Toque para pagar:', '👉 Concluir agora:'], 'cta');
  // o código vai sozinho na PRÓXIMA mensagem: tocar e segurar → Copiar leva o código inteiro
  const pixTitulo = pick(
    [
      '📋 Prefere copiar o Pix? Ele vem na próxima mensagem: toque e segure para copiar.',
      '📋 O código Pix copia e cola vai logo abaixo: é só tocar e segurar para copiar.',
      '📋 Na próxima mensagem vai o Pix copia e cola. Toque e segure nela e escolha Copiar.',
      '📋 Mandei o código Pix logo abaixo, sozinho, para facilitar: toque e segure para copiar.',
      '📋 Se preferir pagar pelo app do banco, o copia e cola vem na mensagem seguinte (toque e segure).',
      '📋 Logo abaixo segue o Pix copia e cola: segure o dedo em cima e toque em Copiar.',
    ],
    'pix',
  );
  const sair = pick(['Não quer mais lembretes? Responda SAIR.', 'Para não receber mais, responda SAIR.', 'Se não quiser mais mensagens, responda SAIR.'], 'sair');
  const partes = [corpo, `${cta}\n${p.link}`, p.pixCode ? pixTitulo : '', sair];
  const msg = partes.filter(Boolean).join('\n\n');
  // nunca a mesma mensagem (fora nome/link/Pix) em sequência para clientes diferentes
  const skel = hashText(`${t}|${corpo.replace(n, '').replace(P, '')}|${cta}|${pixTitulo}|${sair}`);
  if (recentRecovery.includes(skel) && (p as any)._try !== 4) return buildRecoveryMessage({ ...p, _try: ((p as any)._try ?? 0) + 1 } as any);
  recentRecovery.push(skel);
  if (recentRecovery.length > 40) recentRecovery.shift();
  return msg;
}
const recentRecovery: string[] = [];

// ------------------------------------------------------------------ disparos
async function logWa(orderId: string | null, event: string, r: SendResult) {
  await supabase.from('integration_logs').insert({
    integration: 'whatsapp',
    order_id: orderId,
    event,
    ok: r.ok,
    message: (r.ok ? `enviado (${r.instance})` : `${r.error ?? 'falhou'}${r.hint ? ` → ${r.hint}` : ''}`).slice(0, 500),
  });
}

/** Pagamento aprovado → acesso por WhatsApp (uma vez por pedido). */
export async function sendWhatsAppApproved(orderId: string, items: { name: string; url: string | null; note?: string | null; kind?: string }[]) {
  try {
    const cfg = await getWhatsAppConfig();
    if (!cfg.enabled || !cfg.approved.enabled) return;
    // os números da Evolution são da Prime: vendas de produtores não usam o WhatsApp da plataforma
    if (!(await isOwnerOrg(await orgOfOrder(orderId)))) return;
    const { data: o } = await supabase.from('orders').select('id, number, checkout_id, total_cents, public_token, customer:customers(name, phone)').eq('id', orderId).maybeSingle();
    const order: any = o;
    if (!order?.customer?.phone) return;
    const { count } = await supabase.from('events').select('id', { count: 'exact', head: true }).eq('order_id', orderId).eq('type', 'wa_approved');
    if ((count ?? 0) > 0) return;
    await supabase.from('events').insert({ order_id: orderId, checkout_id: order.checkout_id, type: 'wa_approved', data: {} });
    const phone = normalizePhoneBR(order.customer.phone);
    const r = await sendWhatsAppText(phone, buildApprovedMessage({ phone, name: order.customer.name ?? '', totalCents: order.total_cents, items, accessUrl: `${env.PUBLIC_URL}/p/${shortOrderCode(order.number)}`, members: await ensureMemberAccess(orderId).catch(() => null) }), cfg);
    await logWa(orderId, 'approved', r);
  } catch (e) {
    logger.error({ err: e, orderId }, 'WhatsApp aprovado falhou');
  }
}

/** Falha de infraestrutura (Evolution fora do ar / não configurada), não do número do cliente. */
export function isWaUnavailable(error?: string) {
  return /tempo esgotado|timeout|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|não configurada|Nenhuma instância|recusou a conexão|não respondeu|HTTP 5\d\d/i.test(error ?? '');
}

/**
 * WhatsApp falhou → o lembrete desta tentativa vai por e-mail (recuperação nunca fica parada).
 * 1ª tentativa: só se o e-mail de recuperação ainda não saiu (evita dois e-mails iguais);
 * 2ª e 3ª: e-mail com assunto de lembrete. Marca recovery_sent_at para a rotina de e-mail não repetir.
 */
export async function recoveryEmailFallback(orderId: string, customerId: string, attempt: number) {
  try {
    const { data: o } = await supabase.from('orders').select(`${RECOVERY_ORDER_SELECT}, recovery_sent_at`).eq('id', orderId).maybeSingle();
    const order: any = o;
    if (!order?.customer?.email || !order.checkout) return false;
    if (attempt === 1 && order.recovery_sent_at) return false;
    const now = new Date().toISOString();
    await supabase.from('orders').update({ recovery_sent_at: now }).eq('customer_id', customerId).eq('status', 'pending').is('recovery_sent_at', null);
    return await sendRecoveryForOrder(order, attempt);
  } catch (e) {
    logger.error({ err: e, orderId }, 'E-mail de recuperação (reserva do WhatsApp) falhou');
    return false;
  }
}

/** Recuperação de Pix pendente (até 3 tentativas espaçadas). Chamado pelo job a cada 2 min. */
export async function sendWhatsAppRecoveries(max = 10) {
  const cfg = await getWhatsAppConfig();
  if (!cfg.enabled || !cfg.recovery.enabled) return;
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  const { data } = await supabase
    .from('orders')
    .select('id, number, checkout_id, status, created_at, public_token, pix_code, expires_at, customer_id, total_cents, tracking, customer:customers(name, phone), checkout:checkouts(slug), items:order_items(kind, name)')
    .in('status', ['pending', 'expired'])
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(200);
  const all = ((data ?? []) as any[]).filter((o) => o.customer?.phone && o.checkout?.slug);
  // várias cobranças pendentes da mesma pessoa (valores diferentes): lembra só da mais recente
  const latest = new Map<string, any>();
  for (const o of all) if (!latest.has(o.customer_id) || latest.get(o.customer_id).created_at < o.created_at) latest.set(o.customer_id, o);
  const latestOnly = all.filter((o) => latest.get(o.customer_id) === o);
  // só vendas da Prime: o WhatsApp da plataforma não é usado para os produtores
  const owner = await ownerOrgId();
  const orders = owner ? (await Promise.all(latestOnly.map(async (o) => ((await orgOfOrder(o.id)) === owner ? o : null)))).filter(Boolean) : latestOnly;
  if (!orders.length) return;
  // uma consulta para as tentativas e outra para quem já comprou (antes eram 2 consultas por pedido)
  const [evRes, paidRes] = await Promise.all([
    supabase.from('events').select('order_id').eq('type', 'wa_recovery').in('order_id', orders.map((o) => o.id)),
    supabase.from('orders').select('customer_id').eq('status', 'paid').gte('created_at', since).in('customer_id', [...new Set(orders.map((o) => o.customer_id).filter(Boolean))]),
  ]);
  const attempts = new Map<string, number>();
  for (const e of evRes.data ?? []) attempts.set(e.order_id, (attempts.get(e.order_id) ?? 0) + 1);
  const buyers = new Set((paidRes.data ?? []).map((p: any) => p.customer_id));

  let sent = 0;
  let waDown: string | null = null;
  for (const o of orders) {
    if (sent >= max) break;
    const minutes = (Date.now() - new Date(o.created_at).getTime()) / 60000;
    const next = (attempts.get(o.id) ?? 0) + 1;
    if (next > 3) continue;
    const wait = next === 1 ? cfg.recovery.firstMinutes : next === 2 ? cfg.recovery.secondMinutes : cfg.recovery.thirdMinutes;
    if (minutes < wait) continue;
    if (o.tracking?.upsell_of || o.tracking?.renewed_from) continue; // upsell e Pix renovado não entram nos lembretes
    if (buyers.has(o.customer_id)) continue; // já comprou depois? não incomoda
    // reserva a tentativa ANTES de enviar (nunca reenviar em duplicidade)
    const { error } = await supabase.from('events').insert({ order_id: o.id, checkout_id: o.checkout_id, type: 'wa_recovery', data: { attempt: next } });
    if (error) continue;
    const phone = normalizePhoneBR(o.customer.phone);
    const pixValid = cfg.recovery.includePix && o.status === 'pending' && o.pix_code && (!o.expires_at || new Date(o.expires_at) > new Date());
    // link direto para o Pix pendente (se vencer, a página gera outro com um toque, sem preencher nada)
    const link = `${env.PUBLIC_URL}/r/${shortOrderCode(o.number)}`; // link curto e exclusivo da venda
    // Evolution fora do ar nesta rodada? não espera o tempo esgotar de novo: vai direto para o e-mail
    const r: SendResult = waDown
      ? { ok: false, error: waDown }
      : await sendWhatsAppText(phone, buildRecoveryMessage({ phone, name: o.customer.name, link, attempt: next, pixCode: pixValid ? o.pix_code : null, product: (o.items ?? []).find((i: any) => i.kind === 'main')?.name ?? null, totalCents: o.total_cents }), cfg);
    // Pix copia e cola numa mensagem SÓ com o código (fácil de copiar inteiro), do mesmo número do lembrete
    if (r.ok && pixValid && o.pix_code) await sendWhatsAppText(phone, o.pix_code, cfg, { instance: r.instance }).catch(() => null);
    if (!r.ok && !waDown && isWaUnavailable(r.error)) waDown = r.error ?? 'WhatsApp indisponível';
    let viaEmail = false;
    if (!r.ok) viaEmail = await recoveryEmailFallback(o.id, o.customer_id, next);
    await logWa(o.id, `recovery_${next}`, viaEmail ? { ...r, hint: `${r.hint ? `${r.hint} ` : ''}Lembrete enviado por e-mail no lugar.` } : r);
    sent++;
    if (r.ok) await sleep(3500); // pausa natural entre envios
  }
}

// ------------------------------------------------------------------ criar/conectar instância pelo painel (QR Code)
const qrSrc = (v: unknown) => {
  const s = typeof v === 'string' ? v : '';
  if (!s) return null;
  return s.startsWith('data:') ? s : `data:image/png;base64,${s}`;
};
async function evoCall(cfg: WhatsAppConfig, method: string, path: string, key: string, body?: unknown) {
  const res = await fetchWithTimeout(`${await base(cfg)}${path}`, {
    method,
    headers: { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 20_000,
  });
  const raw = await res.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    /* não-JSON */
  }
  return { ok: res.ok, status: res.status, json, raw };
}
const evoMsg = (j: any, raw: string) => {
  const m = j?.response?.message ?? j?.message ?? j?.error ?? raw;
  return (Array.isArray(m) ? m.join(' ') : typeof m === 'string' ? m : JSON.stringify(m ?? '')).slice(0, 200);
};

/** Cria a instância na Evolution (precisa da API Key global) e já devolve o QR Code. */
export async function evolutionCreateInstance(cfg: WhatsAppConfig, name: string, number?: string | null) {
  if (!cfg.apiUrl) return { ok: false as const, error: 'Informe e salve a URL da Evolution API primeiro' };
  if (!cfg.globalApiKey) return { ok: false as const, error: 'Informe e salve a API Key global da Evolution (AUTHENTICATION_API_KEY) para criar instâncias pelo painel' };
  const num = number ? normalizePhoneBR(number) : '';
  try {
    const r = await evoCall(cfg, 'POST', '/instance/create', cfg.globalApiKey, {
      instanceName: name,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS', // v2 (a v1 ignora o campo)
      ...(num ? { number: num } : {}),
    });
    if (r.status === 401 || r.status === 403) {
      const txt = evoMsg(r.json, r.raw);
      if (/already|exist|in use|em uso/i.test(txt)) return { ok: false as const, error: `Já existe uma instância “${name}” na Evolution. Escolha outro nome ou use “Buscar instâncias” para importar.` };
      return { ok: false as const, error: `A Evolution recusou a API Key global (HTTP ${r.status}): ${txt}` };
    }
    if (!r.ok) return { ok: false as const, error: `A Evolution respondeu HTTP ${r.status}: ${evoMsg(r.json, r.raw)}` };
    const j = r.json ?? {};
    const token = (typeof j.hash === 'string' ? j.hash : j.hash?.apikey) ?? j.instance?.token ?? j.token ?? '';
    return { ok: true as const, token: String(token || ''), qr: qrSrc(j.qrcode?.base64 ?? j.base64), pairingCode: j.qrcode?.pairingCode ?? j.pairingCode ?? null };
  } catch (e) {
    const d = describeNetworkError(e, cfg.apiUrl);
    return { ok: false as const, error: d.message, hint: d.hint };
  }
}

/** QR Code atualizado (ele expira em ~40 s) + se já conectou, com o número do WhatsApp. */
export async function evolutionConnectStatus(cfg: WhatsAppConfig, name: string, number?: string | null) {
  const inst = cfg.instances.find((i) => i.name === name);
  const key = (inst && tokenFor(cfg, inst)) || cfg.globalApiKey;
  if (!key) return { ok: false as const, error: 'Instância sem token' };
  try {
    const st = await evoCall(cfg, 'GET', `/instance/connectionState/${encodeURIComponent(name)}`, key);
    const state = String(st.json?.instance?.state ?? st.json?.state ?? '').toLowerCase();
    if (['open', 'connected'].includes(state)) {
      let phone: string | null = null;
      let profile: string | null = null;
      if (cfg.globalApiKey) {
        const list = await fetchEvolutionInstances(cfg.apiUrl, cfg.globalApiKey);
        if (list.ok) {
          const me = list.items.find((i) => i.name === name);
          phone = me?.number ?? null;
          profile = me?.profileName ?? null;
        }
      }
      return { ok: true as const, connected: true, number: phone, profileName: profile, qr: null, pairingCode: null };
    }
    const num = number ? normalizePhoneBR(number) : '';
    const c = await evoCall(cfg, 'GET', `/instance/connect/${encodeURIComponent(name)}${num ? `?number=${num}` : ''}`, key);
    if (!c.ok) return { ok: false as const, error: `A Evolution respondeu HTTP ${c.status}: ${evoMsg(c.json, c.raw)}` };
    const j = c.json ?? {};
    if (['open', 'connected'].includes(String(j.instance?.state ?? '').toLowerCase())) return { ok: true as const, connected: true, number: null, profileName: null, qr: null, pairingCode: null };
    return { ok: true as const, connected: false, number: null, profileName: null, qr: qrSrc(j.base64 ?? j.qrcode?.base64), pairingCode: j.pairingCode ?? j.qrcode?.pairingCode ?? null };
  } catch (e) {
    const d = describeNetworkError(e, cfg.apiUrl);
    return { ok: false as const, error: d.message, hint: d.hint };
  }
}
