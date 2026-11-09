import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError, supabase } from './core.js';

/**
 * Marketplace: cada produtor é uma ORGANIZAÇÃO. As rotas do painel rodam dentro de um contexto com a
 * organização de quem está logado, e `tenantDb` aplica o filtro `org_id` automaticamente em toda
 * consulta das tabelas de negócio (leitura, alteração, exclusão) e grava o `org_id` em toda inclusão.
 * O banco reforça: triggers preenchem org_id pelo "pai" e recusam vínculos entre produtores diferentes.
 */
export const TENANT_TABLES = new Set([
  'products', 'checkouts', 'order_bumps', 'checkout_bumps', 'coupons', 'orders', 'events', 'upsells', 'invoices',
  'member_sections', 'member_modules', 'member_lessons',
]);

export const tenantCtx = new AsyncLocalStorage<{ orgId: string | null }>();

// ------------------------------------------------------------------ organização proprietária (Prime)
let ownerCache: { id: string | null; at: number } | null = null;
/**
 * id da organização proprietária. null = banco ainda sem a migração do marketplace
 * (modo loja única: tudo funciona como antes, sem filtro).
 */
export async function ownerOrgId(): Promise<string | null> {
  if (ownerCache && Date.now() - ownerCache.at < 5 * 60_000) return ownerCache.id;
  const { data, error } = await supabase.from('organizations').select('id').eq('is_platform_owner', true).maybeSingle();
  const id = error ? null : ((data as any)?.id ?? null);
  ownerCache = { id, at: Date.now() };
  return id;
}
export const clearOwnerCache = () => (ownerCache = null);

/** A organização é a proprietária da plataforma? (isenção de taxas, WhatsApp e nota da Prime) */
export async function isOwnerOrg(orgId: string | null | undefined) {
  const owner = await ownerOrgId();
  return !owner || !orgId || orgId === owner;
}

// ------------------------------------------------------------------ cliente com filtro por organização
const withOrg = (v: any, orgId: string) => (Array.isArray(v) ? v.map((r) => ({ ...r, org_id: orgId })) : { ...v, org_id: orgId });

export function scopedDb(orgId: string | null) {
  return {
    from(table: string): any {
      const qb: any = supabase.from(table);
      if (!orgId || !TENANT_TABLES.has(table)) return qb;
      return {
        select: (cols?: string, opts?: any) => qb.select(cols, opts).eq('org_id', orgId),
        update: (v: any, opts?: any) => qb.update(v, opts).eq('org_id', orgId),
        delete: (opts?: any) => qb.delete(opts).eq('org_id', orgId),
        insert: (v: any, opts?: any) => qb.insert(withOrg(v, orgId), opts),
        upsert: (v: any, opts?: any) => qb.upsert(withOrg(v, orgId), opts),
      };
    },
    rpc: (...args: any[]) => (supabase.rpc as any)(...args),
    get auth() {
      return supabase.auth;
    },
    get storage() {
      return supabase.storage;
    },
  };
}

/** Cliente usado nas rotas do painel: filtra pela organização do contexto. */
export const tenantDb = {
  from(table: string): any {
    const ctx = tenantCtx.getStore();
    if (!ctx) throw new HttpError(500, 'Contexto da organização ausente');
    return scopedDb(ctx.orgId).from(table);
  },
  rpc: (...args: any[]) => (supabase.rpc as any)(...args),
  get auth() {
    return supabase.auth;
  },
  get storage() {
    return supabase.storage;
  },
};

export const currentOrgId = () => tenantCtx.getStore()?.orgId ?? null;

/** Executa `fn` como se fosse a organização informada (configurações, webhooks e nota daquela organização). */
export function runAsOrg<T>(orgId: string | null | undefined, fn: () => T): T {
  return tenantCtx.run({ orgId: orgId ?? null }, fn);
}

/**
 * Chave de configuração da organização atual. A Prime (proprietária) usa as chaves de sempre
 * ("general", "webhooks", ...) — nada muda para ela; cada produtor tem as suas ("general@<org>").
 */
export async function orgKey(base: string): Promise<string> {
  const orgId = currentOrgId();
  if (!orgId) return base;
  const owner = await ownerOrgId();
  return !owner || orgId === owner ? base : `${base}@${orgId}`;
}

/** Organização dona do pedido (null se o banco ainda não tem o marketplace). */
export async function orgOfOrder(orderId: string): Promise<string | null> {
  const { data, error } = await supabase.from('orders').select('org_id').eq('id', orderId).maybeSingle();
  return error ? null : ((data as any)?.org_id ?? null);
}
/** Roda `fn` com as configurações da organização dona do pedido. */
export async function withOrderOrg<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
  return runAsOrg(await orgOfOrder(orderId), fn);
}

// ------------------------------------------------------------------ produtor vendedor
export interface OrgInfo { id: string; status: string; is_platform_owner: boolean; split_enabled: boolean; card_split_enabled?: boolean; pix_provider: 'woovi' | 'efi' | null; name: string; recipient?: { pixKey?: string; pix_key?: string; account?: string; document?: string; name?: string } }
const orgCache = new Map<string, { v: OrgInfo | null; at: number }>();
export async function orgInfo(orgId: string | null | undefined): Promise<OrgInfo | null> {
  if (!orgId) return null;
  const hit = orgCache.get(orgId);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const { data } = await supabase.from('organizations').select('*').eq('id', orgId).maybeSingle(); // '*': inclui card_split_enabled quando existir
  const v = (data as OrgInfo) ?? null;
  orgCache.set(orgId, { v, at: Date.now() });
  return v;
}
export const clearOrgCache = () => orgCache.clear();

/**
 * Produtor só vende com conta ativa e recebimento (split) configurado pelo Super Admin:
 * o dinheiro de terceiros nunca cai na conta da Prime por padrão.
 */
export async function assertCanSell(orgId: string | null | undefined) {
  if (await isOwnerOrg(orgId)) return;
  const org = await orgInfo(orgId);
  if (!org || org.status !== 'active') throw new HttpError(403, 'Este produto está indisponível no momento.');
  if (!org.split_enabled) throw new HttpError(503, 'Este produto ainda não está liberado para vendas. Tente novamente mais tarde.');
}
