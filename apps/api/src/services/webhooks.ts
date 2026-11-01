import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { supabase } from '../lib/core.js';

/**
 * Webhooks de saída configurados no painel (Integrações → Webhooks).
 * Guardados em `settings` (chave "webhooks"), tabela com RLS só para admins; o
 * servidor lê com a service role. Token e segredo NUNCA são devolvidos inteiros ao navegador.
 */
export const WEBHOOK_EVENTS = ['sale.pending', 'sale.approved', 'sale.canceled', 'sale.refunded'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface Webhook {
  id: string;
  name: string;
  preset: 'paytracking' | 'custom';
  url: string;
  token: string;
  secret: string;
  events: WebhookEvent[];
  active: boolean;
  created_at: string;
  /** true para o webhook vindo das variáveis PAYTRACKING_* (somente leitura no painel) */
  fromEnv?: boolean;
}

const KEY = 'webhooks';
let cache: { items: Webhook[]; at: number } | null = null;

export async function listWebhooks(): Promise<Webhook[]> {
  if (cache && Date.now() - cache.at < 15_000) return cache.items;
  const { data } = await supabase.from('settings').select('value').eq('key', KEY).maybeSingle();
  const items = (((data as any)?.value?.items ?? []) as Webhook[]).filter((w) => w && w.id && w.url);
  cache = { items, at: Date.now() };
  return items;
}

export async function saveWebhooks(items: Webhook[]) {
  const { error } = await supabase.from('settings').upsert({ key: KEY, value: { items }, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  cache = null;
}

export const newWebhookId = () => crypto.randomUUID();

/** Webhook legado das variáveis de ambiente (continua funcionando como alternativa). */
export function envWebhook(): Webhook | null {
  if (!env.PAYTRACKING_URL || !env.PAYTRACKING_TOKEN) return null;
  return {
    id: 'env',
    name: 'PayTracking (variáveis de ambiente)',
    preset: 'paytracking',
    url: env.PAYTRACKING_URL,
    token: env.PAYTRACKING_TOKEN,
    secret: env.PAYTRACKING_SECRET ?? '',
    events: [...WEBHOOK_EVENTS],
    active: true,
    created_at: '',
    fromEnv: true,
  };
}

/** Todos os destinos (painel + env), sem duplicar a mesma URL+token. */
export async function allWebhooks(): Promise<Webhook[]> {
  const items = await listWebhooks();
  const e = envWebhook();
  if (e && !items.some((w) => w.url === e.url && w.token === e.token)) return [...items, e];
  return items;
}

export async function targetsFor(event: string) {
  return (await allWebhooks()).filter((w) => w.active && (w.events as string[]).includes(event));
}

export const mask = (v: string) => (v ? `••••${v.slice(-4)}` : '');
