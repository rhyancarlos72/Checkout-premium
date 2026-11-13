import crypto from 'node:crypto';
import fs from 'node:fs';
import tls from 'node:tls';
import { env } from '../config/env.js';
import { supabase } from '../lib/core.js';

/**
 * Credenciais dos gateways configuradas no painel (Integrações → Configurar).
 * Guardadas em `settings` (chave "gateways"; RLS só admins, servidor lê com service role).
 * Os valores do painel têm prioridade; as variáveis de ambiente continuam como alternativa.
 * Segredos nunca são devolvidos inteiros ao navegador.
 */
export interface GatewaySettings {
  /** Gateway usado por TODOS os produtos/checkouts. Vazio = cada checkout usa o seu. */
  defaultProvider?: 'woovi' | 'efi' | null;
  /** Validade real do Pix para todos os produtos (minutos). Padrão: 120 (2 horas). */
  pixExpiresMinutes?: number;
  /** SMTP do e-mail (entrega, recuperação, códigos). Painel tem prioridade; as variáveis SMTP_* ficam de reserva. */
  smtp?: { host?: string; port?: number; secure?: boolean; user?: string; pass?: string; from?: string; fromName?: string };
  /** Cartão de crédito (Super Admin): gateway e máximo de parcelas sem juros para o cliente */
  card?: { enabled?: boolean; provider?: 'woovi' | 'efi'; maxInstallments?: number };
  woovi?: { appId?: string; webhookSecret?: string };
  efi?: {
    clientId?: string;
    clientSecret?: string;
    pixKey?: string;
    certBase64?: string;
    certName?: string;
    certUploadedAt?: string;
    passphrase?: string;
    sandbox?: boolean;
    webhookSecret?: string;
    /** Identificador de conta Efí (payee_code): público, usado no navegador para gerar o payment_token do cartão */
    payeeCode?: string;
  };
  /** Pix Automático (assinaturas mensais nos order bumps marcados): sempre pela Efí, só para a Prime */
  pixAuto?: { enabled?: boolean; account?: string; webhooksAt?: string };
}

const KEY = 'gateways';
let snap: GatewaySettings = {};
let loadedAt = 0;
let inflight: Promise<void> | null = null;

/** Recarrega do banco (cache de 30s). Chamado em toda requisição da API e no boot. */
export async function refreshGateways(force = false) {
  if (!force && Date.now() - loadedAt < 30_000) return;
  if (inflight) return inflight; // evita várias consultas simultâneas
  inflight = (async () => {
    const { data, error } = await supabase.from('settings').select('value').eq('key', KEY).maybeSingle();
    if (!error) {
      snap = ((data as any)?.value ?? {}) as GatewaySettings;
      loadedAt = Date.now();
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function patchGateways(fn: (cur: GatewaySettings) => GatewaySettings) {
  await refreshGateways(true);
  const next = fn(JSON.parse(JSON.stringify(snap)));
  const { error } = await supabase.from('settings').upsert({ key: KEY, value: next, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  snap = next;
  loadedAt = Date.now();
}

/** Gateway global escolhido em Integrações (null = cada checkout escolhe o seu). */
export const globalProvider = (): 'woovi' | 'efi' | null => snap.defaultProvider ?? null;
/** Cartão ligado no painel e o gateway escolhido está configurado (hoje: Woovi). */
export const cardConfig = () => {
  const c = snap.card ?? {};
  const provider = c.provider ?? 'woovi';
  // Efí: API de Cobranças com as mesmas credenciais (aplicação com "API de Emissões" ativa) + identificador de conta
  const e = efiConfig();
  const ready = provider === 'woovi' ? Boolean(wooviConfig().appId) : Boolean(e.clientId && e.clientSecret && e.payeeCode);
  return {
    enabled: Boolean(c.enabled) && ready,
    configured: Boolean(c.enabled),
    ready,
    provider,
    maxInstallments: Math.min(12, Math.max(1, Number(c.maxInstallments) || 1)),
    // dados PÚBLICOS para a biblioteca da Efí no navegador (nunca segredos)
    efi: provider === 'efi' ? { payeeCode: e.payeeCode, sandbox: Boolean(e.sandbox) } : null,
  };
};

/** Validade real do Pix em minutos (configurada em Integrações; padrão 2 horas). */
export const pixExpiresMinutes = (): number => {
  const v = Number(snap.pixExpiresMinutes);
  return Number.isInteger(v) && v >= 15 && v <= 1440 ? v : 120;
};

/** Pix Automático: ligado no painel + Efí Pix configurada (certificado, chave, credenciais). */
export function pixAutoConfig() {
  const a = snap.pixAuto ?? {};
  const e = efiConfig();
  return { enabled: Boolean(a.enabled) && e.configured, configured: Boolean(a.enabled), efiReady: e.configured, account: a.account || null, webhooksAt: a.webhooksAt || null };
}

export const randomSecret = () => crypto.randomBytes(24).toString('hex');
export const mask = (v?: string) => (v ? `••••${v.slice(-4)}` : '');

export function wooviConfig() {
  const w = snap.woovi ?? {};
  return {
    appId: w.appId || env.WOOVI_APP_ID || '',
    webhookSecret: w.webhookSecret || env.WOOVI_WEBHOOK_SECRET || '',
    apiUrl: env.WOOVI_API_URL,
    source: w.appId ? ('painel' as const) : env.WOOVI_APP_ID ? ('env' as const) : null,
  };
}

let envPfxCache: Buffer | null = null;
export function efiConfig() {
  const e = snap.efi ?? {};
  let pfx: Buffer | null = null;
  let passphrase = '';
  let certSource: 'painel' | 'env' | null = null;
  if (e.certBase64) {
    pfx = Buffer.from(e.certBase64, 'base64');
    passphrase = e.passphrase ?? '';
    certSource = 'painel';
  } else if (env.EFI_CERT_BASE64) {
    pfx = Buffer.from(env.EFI_CERT_BASE64, 'base64');
    passphrase = env.EFI_CERT_PASSPHRASE ?? '';
    certSource = 'env';
  } else if (env.EFI_CERT_PATH) {
    try {
      envPfxCache ??= fs.readFileSync(env.EFI_CERT_PATH);
      pfx = envPfxCache;
      passphrase = env.EFI_CERT_PASSPHRASE ?? '';
      certSource = 'env';
    } catch {
      pfx = null;
    }
  }
  const cfg = {
    clientId: e.clientId || env.EFI_CLIENT_ID || '',
    clientSecret: e.clientSecret || env.EFI_CLIENT_SECRET || '',
    pixKey: e.pixKey || env.EFI_PIX_KEY || '',
    pfx,
    passphrase,
    certSource,
    sandbox: e.sandbox ?? env.EFI_SANDBOX,
    webhookSecret: e.webhookSecret || env.EFI_WEBHOOK_SECRET || '',
    payeeCode: e.payeeCode || '',
  };
  // chave que muda quando credenciais/certificado mudam (o provedor recria o agente mTLS)
  const key = crypto
    .createHash('sha256')
    .update([cfg.clientId, cfg.clientSecret, cfg.sandbox, cfg.passphrase, pfx ? crypto.createHash('sha256').update(pfx).digest('hex') : ''].join('|'))
    .digest('hex');
  return { ...cfg, key, configured: Boolean(cfg.clientId && cfg.clientSecret && cfg.pixKey && pfx) };
}

/** Valida o .p12 (e a senha) antes de salvar. Retorna o motivo em caso de erro. */
export function validatePfx(pfx: Buffer, passphrase: string): string | null {
  try {
    tls.createSecureContext({ pfx, passphrase });
    return null;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/mac verify|password|bad decrypt/i.test(msg)) return 'Senha do certificado incorreta';
    if (/unsupported/i.test(msg)) return 'Certificado em formato não suportado. Use o arquivo .p12 baixado da Efí';
    return `Certificado inválido: ${msg}`;
  }
}

/** Nome/data do certificado enviado pelo painel (para exibir). */
export function efiCertMeta() {
  return { name: snap.efi?.certName ?? (snap.efi?.certBase64 ? 'certificado.p12' : env.EFI_CERT_PATH ? 'variável de ambiente' : 'EFI_CERT_BASE64'), uploadedAt: snap.efi?.certUploadedAt ?? null };
}

/** SMTP em uso: o do painel (Integrações → E-mail) ou, se vazio, o das variáveis SMTP_*. */
export function mailConfig() {
  const m = snap.smtp ?? {};
  const panel = Boolean(m.host && m.user && m.pass);
  const host = panel ? m.host! : env.SMTP_HOST ?? '';
  const user = panel ? m.user! : env.SMTP_USER ?? '';
  const pass = panel ? m.pass! : env.SMTP_PASS ?? '';
  const port = panel ? Number(m.port) || 465 : env.SMTP_PORT;
  const secure = panel ? (m.secure ?? port === 465) : env.SMTP_SECURE;
  const from = (panel ? m.from : env.MAIL_FROM) || user;
  const fromName = (panel ? m.fromName : env.MAIL_FROM_NAME) || env.MAIL_FROM_NAME || 'Checkout';
  return { host, port, secure, user, pass, from, fromName, source: panel ? ('painel' as const) : host ? ('env' as const) : null, configured: Boolean(host && user && pass), key: [host, port, secure, user, pass].join('|') };
}
