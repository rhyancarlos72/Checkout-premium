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

export type SendResult = { ok: boolean; error?: string; hint?: string; instance?: string };

/** Envia texto com rodízio de instâncias e fallback; em falha, diz o motivo de cada instância. */
export async function sendWhatsAppText(phoneRaw: string, message: string, cfgIn?: WhatsAppConfig): Promise<SendResult> {
  const cfg = cfgIn ?? (await getWhatsAppConfig());
  if (!cfg.apiUrl) return { ok: false, error: 'URL da Evolution API não configurada', hint: 'Preencha a URL em Integrações → WhatsApp.' };
  const instances = cfg.instances.filter((i) => i.active && i.name && tokenFor(cfg, i)).map((i) => ({ ...i, token: tokenFor(cfg, i) }));
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
        for (const payload of [
          { number: n, text, delay: 3500, linkPreview: false }, // Evolution v2
          { number: n, options: { delay: 3500, presence: 'composing' }, textMessage: { text } }, // v1
        ]) {
          r = await post(cfg, chosen.name, chosen.token, payload);
          if (r.ok || r.http === 401 || r.http === 403 || r.http === 0) break outer;
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
      hint: `${d.hint}${alt ? ` Atalho sem comprar domínio: rode o script docs/evolution-proxy.sh na VPS da Evolution; ele publica ${alt} com HTTPS grátis e o checkout passa a usar esse endereço sozinho.` : ''}`,
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
      ? { label: 'Mensagens automáticas', ok: true, detail: [cfg.approved.enabled && 'pagamento aprovado', cfg.recovery.enabled && `recuperação (${cfg.recovery.firstMinutes} min / ${cfg.recovery.secondMinutes} min)`].filter(Boolean).join(' + ') }
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

export function buildApprovedMessage(p: { phone: string; name: string; totalCents: number; items: { name: string; url: string | null; note?: string | null; kind?: string }[]; accessUrl?: string }) {
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
    ['Dica: salve este contato para o link ficar clicável e não se perder.', 'Dica: se o link não abrir, salve nosso número e toque de novo.', 'Dica: no Google Drive, entre com sua conta Google para baixar.', 'Dica: abra pelo navegador do celular ou do computador, como preferir.', 'Dica: baixe o material para ter acesso mesmo sem internet.', 'Dica: se aparecer "solicitar acesso", entre com uma conta Google e tente de novo.', 'Dica: guarde esta conversa para encontrar o link rapidinho depois.', 'Dica: no computador, a visualização dos arquivos fica ainda melhor.', 'Dica: marque esta mensagem com estrela para achar fácil depois.', 'Dica: se o arquivo for grande, aguarde alguns segundos para carregar.'],
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
    ['— Se preferir não receber mensagens sobre esta compra, responda SAIR.', '— Não quer mais receber mensagens sobre este pedido? É só responder SAIR.', '— Para não receber mais avisos sobre esta compra, responda SAIR.', '— Caso não queira mais mensagens por aqui, responda SAIR.', '— Prefere não receber mensagens? Basta que você responda SAIR.'],
    'ep_optout',
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
  const resumo = extras.length ? `${rotVal}: ${valor}` : `${rotProd}: *${main?.name ?? ''}*\n${rotVal}: ${valor}`;

  // estrutura também varia (não só as frases)
  const layout = pick(['a', 'b', 'c', 'd'], 'ep_layout');
  const partes =
    layout === 'a'
      ? [saudacao, resumo, acessos, `${dica}\n${lembrete}`, fechamento]
      : layout === 'b'
        ? [saudacao, acessos, resumo, lembrete, `${dica}\n\n${fechamento}`]
        : layout === 'c'
          ? [saudacao, `${resumo}\n\n${acessos}`, `${lembrete} ${fechamento}`]
          : [saudacao, resumo, acessos, dica, `${lembrete}\n${fechamento}`];
  return `${partes.filter(Boolean).join('\n\n')}\n\n${optout}`;
}

export function buildRecoveryMessage(p: { phone: string; name: string; link: string; attempt: number; pixCode?: string | null }) {
  const n = firstName(p.name, 'tudo bem');
  const t = p.attempt >= 2 ? 2 : 1;
  const pick = (pool: string[], key: string) => pickFresh(pool, p.phone, `t${t}_${key}`);
  const blocks =
    t === 1
      ? {
          abertura: [
            `Olá, ${n}! Tudo bem?`, `Oi, ${n}! Tudo certo?`, `Olá, ${n}! 🙂`, `Oi, ${n}!`, `Olá, ${n}! Espero que esteja bem.`, `Oi, ${n}! Como vai?`,
            `Olá, ${n}! Aqui é da equipe de atendimento.`, `Oi, ${n}! Passando rapidinho por aqui.`, `Olá, ${n}! Tudo tranquilo?`, `Oi, ${n}! Espero não incomodar.`,
            `${n}, tudo bem por aí?`, `Olá, ${n}! Só um recadinho rápido.`, `Oi, ${n}! Vi seu pedido aqui.`, `Olá, ${n}, como você está?`, `Oi, ${n}! Tudo joia?`,
          ],
          corpo: [
            'Seu Pix foi gerado, mas o pagamento ainda não caiu. Seu pedido ficou guardado.',
            'Vi que você gerou o Pix e não chegou a pagar. Deixei tudo guardado para você.',
            'Notei que seu pedido ficou em aberto. Ele continua disponível, sem pressa.',
            'Seu pedido continua reservado, caso queira concluir.',
            'Percebi que o pagamento não foi concluído. Seu pedido segue salvo, com o mesmo valor.',
            'O Pix do seu pedido ainda está esperando o pagamento.',
            'Seu pedido ficou pendente, mas segue disponível do jeitinho que você deixou.',
            'Pode ter acontecido algum imprevisto na hora de pagar, então guardei seu pedido.',
            'Às vezes o app do banco trava ou a gente se distrai, acontece! Seu pedido continua salvo.',
            'Seu pedido está separado aqui, só falta o pagamento do Pix.',
            'Ficou faltando só o Pix para liberar o seu acesso.',
            'Seu acesso está a um Pix de distância. 😉',
          ],
          cta: [
            'Para pagar, é só abrir o seu Pix:', 'Seu Pix está aqui, pronto para pagar:', 'O link do seu Pix é este:', 'Toque para abrir o seu Pix:',
            'Você pode pagar por aqui, sem preencher nada de novo:', 'Deixo o seu Pix à disposição:', 'Se fizer sentido, é só pagar por aqui:', 'Seu pedido com o Pix está neste link:',
            'Abra e pague em poucos segundos:', 'É só tocar e pagar:',
          ],
          fecho: [
            'Qualquer dúvida, é só responder esta mensagem.', 'Se precisar de ajuda, estou por aqui.', 'Qualquer dúvida sobre o produto ou o pagamento, me chame.',
            'Estou à disposição para o que precisar.', 'Se preferir não seguir, tudo bem também, é só me avisar.', 'Fico à disposição, sem compromisso.',
            'Se tiver qualquer pergunta, pode responder por aqui.', 'Assim que o Pix cair, seu acesso chega na hora.', 'O acesso é liberado automaticamente após o pagamento.',
            'Teve alguma dificuldade com o Pix? Me conta que eu ajudo.',
          ],
        }
      : {
          abertura: [
            `Oi, ${n}! 🙂`, `Olá, ${n}! Tudo bem?`, `Oi, ${n}!`, `Olá, ${n}!`, `Oi, ${n}! Tudo certo por aí?`, `Olá, ${n}! Só passando rapidamente.`,
            `Oi, ${n}! Espero que esteja tudo bem.`, `Olá, ${n}! Último contato sobre seu pedido.`, `${n}, tudo bem?`, `Oi, ${n}, desculpa a insistência!`, `Olá, ${n}! Prometo que é a última mensagem. 😊`,
          ],
          corpo: [
            'Este é o segundo (e último) lembrete sobre o pedido que ficou em aberto.',
            'Só um segundo lembrete: seu pedido ainda está salvo, caso queira finalizar.',
            'Passando uma última vez para deixar seu pedido à disposição.',
            'Para não deixar em aberto: seu pedido ainda pode ser concluído.',
            'Este é o último aviso sobre o pedido pendente, depois disso não envio mais.',
            'Antes de encerrar o assunto, deixo seu pedido disponível mais uma vez.',
            'Seu pedido segue salvo, mas este é o último lembrete que envio.',
            'Só finalizando o assunto: o pedido continua disponível para conclusão.',
            'Seu pedido ainda está guardado com o mesmo valor. Se o Pix venceu, dá para gerar outro com um toque.',
            'Não queria que você perdesse: seu pedido continua disponível.',
          ],
          cta: ['Link do seu Pix:', 'Se quiser concluir, o link continua ativo:', 'O link para pagar é este:', 'Caso ainda faça sentido, é por aqui:', 'Deixo o link disponível:', 'Você pode pagar por este link:', 'Seu Pix (ou um novo, se tiver vencido) está aqui:'],
          fecho: [
            'Se preferir não receber mais mensagens sobre esta compra, é só responder SAIR.',
            'Se não for o momento, sem problema algum. Obrigado pela consideração.',
            'Caso não queira mais receber mensagens sobre isso, responda SAIR que eu paro por aqui.',
            'Se não tiver mais interesse, tudo certo. Obrigado pelo interesse.',
            'Não quer mais receber mensagens? Basta responder SAIR.',
            'Sem compromisso: se preferir, responda SAIR e não envio mais nada.',
            'Qualquer dúvida, é só responder. Se não quiser mais mensagens, responda SAIR.',
          ],
        };
  const pixTitulo = pick(
    [
      'Pix copia e cola (toque e segure para copiar):', 'Se preferir, aqui está o Pix copia e cola:', 'Código Pix para pagar direto no app do banco:',
      'Pix disponível abaixo, é só copiar e colar:', 'Se for mais prático, use o Pix copia e cola:', 'Deixo também o código Pix, caso prefira:',
      'Pix copia e cola, se preferir pagar pelo banco:', 'Código Pix abaixo, caso seja mais fácil pra você:', 'Ou copie o código abaixo e cole no app do banco:', 'Pix copia e cola 👇',
    ],
    'pix',
  );
  const abertura = pick(blocks.abertura, 'abertura');
  const corpo = pick(blocks.corpo, 'corpo');
  const cta = `${pick(blocks.cta, 'cta')}\n${p.link}`;
  const fecho = pick(blocks.fecho, 'fecho');
  const pix = p.pixCode ? `${pixTitulo}\n\n${p.pixCode}` : '';
  const sair = t === 1 ? pick(['— Se não quiser receber mensagens sobre este pedido, responda SAIR.', '— Prefere não receber lembretes? Responda SAIR.', '— Para não receber mais avisos, é só responder SAIR.', '— Não quer mais lembretes deste pedido? Responda SAIR.'], 'sair') : '';
  const layout = pick(['a', 'b', 'c'], 'layout');
  const partes =
    layout === 'a'
      ? [abertura, corpo, cta, pix, fecho]
      : layout === 'b'
        ? [`${abertura} ${corpo}`, cta, fecho, pix]
        : [abertura, corpo, pix, cta, fecho];
  return [...partes, sair].filter(Boolean).join('\n\n');
}

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
    const { data: o } = await supabase.from('orders').select('id, checkout_id, total_cents, public_token, customer:customers(name, phone)').eq('id', orderId).maybeSingle();
    const order: any = o;
    if (!order?.customer?.phone) return;
    const { count } = await supabase.from('events').select('id', { count: 'exact', head: true }).eq('order_id', orderId).eq('type', 'wa_approved');
    if ((count ?? 0) > 0) return;
    await supabase.from('events').insert({ order_id: orderId, checkout_id: order.checkout_id, type: 'wa_approved', data: {} });
    const phone = normalizePhoneBR(order.customer.phone);
    const r = await sendWhatsAppText(phone, buildApprovedMessage({ phone, name: order.customer.name ?? '', totalCents: order.total_cents, items, accessUrl: `${env.PUBLIC_URL}/pedido/${order.public_token}` }), cfg);
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
  const orders = ((data ?? []) as any[]).filter((o) => o.customer?.phone && o.checkout?.slug);
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
  for (const o of orders) {
    if (sent >= max) break;
    const minutes = (Date.now() - new Date(o.created_at).getTime()) / 60000;
    const next = (attempts.get(o.id) ?? 0) + 1;
    if (next > 2) continue;
    if ((next === 1 && minutes < cfg.recovery.firstMinutes) || (next === 2 && minutes < cfg.recovery.secondMinutes)) continue;
    if (buyers.has(o.customer_id)) continue; // já comprou depois? não incomoda
    // reserva a tentativa ANTES de enviar (nunca reenviar em duplicidade)
    const { error } = await supabase.from('events').insert({ order_id: o.id, checkout_id: o.checkout_id, type: 'wa_recovery', data: { attempt: next } });
    if (error) continue;
    const phone = normalizePhoneBR(o.customer.phone);
    const pixValid = cfg.recovery.includePix && o.status === 'pending' && o.pix_code && (!o.expires_at || new Date(o.expires_at) > new Date());
    // link direto para o Pix pendente (se vencer, a página gera outro com um toque, sem preencher nada)
    const link = `${env.PUBLIC_URL}/pedido/${o.public_token}?utm_source=whatsapp&utm_medium=recovery`;
    const r = await sendWhatsAppText(phone, buildRecoveryMessage({ phone, name: o.customer.name, link, attempt: next, pixCode: pixValid ? o.pix_code : null }), cfg);
    await logWa(o.id, `recovery_${next}`, r);
    sent++;
    await sleep(3500); // pausa natural entre envios
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
