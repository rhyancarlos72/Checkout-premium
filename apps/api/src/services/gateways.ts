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
  };
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
