import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { HttpError, supabase } from '../lib/core.js';
import { ownerOrgId } from '../lib/tenant.js';

declare module 'express-serve-static-core' {
  interface Request {
    adminId?: string;
    adminEmail?: string;
    adminRole?: 'owner' | 'staff';
    /** organização (produtor) de quem está logado; null = banco sem marketplace (loja única) */
    orgId?: string | null;
    /** dono da plataforma (Prime): gateways, taxas, produtores, credenciais */
    isSuperAdmin?: boolean;
  }
}

// Cache da validação (60s): antes, cada clique no painel fazia 2 chamadas ao Supabase.
type AuthHit = { at: number; id: string; email?: string; role: 'owner' | 'staff'; orgId: string | null; superAdmin: boolean };
const authCache = new Map<string, AuthHit>();
export const clearAuthCache = () => authCache.clear();
const AUTH_TTL = 60_000;

/** Valida o JWT do Supabase Auth e exige que o usuário esteja na tabela `admins`. */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'Não autenticado');
    const hit = authCache.get(token);
    if (hit && Date.now() - hit.at < AUTH_TTL) {
      req.adminId = hit.id;
      req.adminEmail = hit.email;
      req.adminRole = hit.role;
      req.orgId = hit.orgId;
      req.isSuperAdmin = hit.superAdmin;
      return next();
    }
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) throw new HttpError(401, 'Sessão inválida ou expirada');
    // 2FA: se o usuário tem um fator TOTP verificado, a sessão precisa estar em AAL2
    const hasMfa = (data.user.factors ?? []).some((f) => f.status === 'verified');
    if (hasMfa) {
      let aal = 'aal1';
      try {
        aal = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).aal ?? 'aal1';
      } catch {
        /* token malformado: getUser já teria falhado */
      }
      if (aal !== 'aal2') throw new HttpError(401, 'Confirme o código de verificação em 2 etapas', 'MFA_REQUIRED');
    }
    // papel: "owner" (dono, acesso total) ou "staff" (equipe, sem integrações)
    let admin: { user_id: string; role?: string } | null = null;
    const withRole = await supabase.from('admins').select('user_id, role').eq('user_id', data.user.id).maybeSingle();
    if (withRole.error && /role/.test(withRole.error.message)) {
      // banco ainda sem a coluna role (SQL de equipe não rodado): só existe o dono
      admin = (await supabase.from('admins').select('user_id').eq('user_id', data.user.id).maybeSingle()).data as any;
      if (admin) admin.role = 'owner';
    } else admin = withRole.data as any;
    const email = data.user.email?.toLowerCase();
    let role: 'owner' | 'staff';
    let orgId: string | null = null;
    let superAdmin = false;
    if (admin) {
      // equipe da plataforma (tabela admins) = equipe da organização proprietária, com o mesmo user_id de sempre.
      // ADMIN_EMAIL é sempre dono; com ADMIN_EMAIL definido, ninguém além dele vira dono pelo banco.
      role = env.ADMIN_EMAIL ? (email === env.ADMIN_EMAIL ? 'owner' : 'staff') : admin.role === 'owner' ? 'owner' : 'staff';
      superAdmin = role === 'owner';
      orgId = await ownerOrgId();
    } else {
      // produtor: membro de uma organização aprovada (o papel vem do banco, nunca do navegador)
      const { data: m, error: mErr } = await supabase.from('org_members').select('org_id, role, org:organizations(status, is_platform_owner)').eq('user_id', data.user.id).limit(1).maybeSingle();
      if (mErr || !m) throw new HttpError(403, 'Acesso restrito a administradores');
      const org = (m as any).org;
      if (org?.status === 'pending') throw new HttpError(403, 'Seu cadastro de produtor está em análise. Avisaremos por e-mail quando for aprovado.', 'ORG_PENDING');
      if (org?.status !== 'active') throw new HttpError(403, 'Esta conta está suspensa. Fale com o suporte da plataforma.', 'ORG_SUSPENDED');
      role = (m as any).role === 'owner' ? 'owner' : 'staff';
      orgId = (m as any).org_id;
    }
    req.adminId = data.user.id;
    req.adminEmail = data.user.email ?? undefined;
    req.adminRole = role;
    req.orgId = orgId;
    req.isSuperAdmin = superAdmin;
    authCache.set(token, { at: Date.now(), id: data.user.id, email: data.user.email ?? undefined, role, orgId, superAdmin });
    if (authCache.size > 1000) authCache.delete(authCache.keys().next().value!);
    next();
  } catch (e) {
    next(e);
  }
}

/** Só o dono da organização (produtor dono ou a Prime): webhooks, nota fiscal, excluir venda. */
export function requireOwner(req: Request, _res: Response, next: NextFunction) {
  if (req.adminRole !== 'owner') return next(new HttpError(403, 'Somente o dono da conta acessa as integrações', 'OWNER_ONLY'));
  next();
}

/** Só o Super Admin (dono da plataforma): gateways, credenciais, WhatsApp da plataforma, taxas, produtores. */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.isSuperAdmin) return next(new HttpError(403, 'Somente o administrador da plataforma acessa esta área', 'SUPER_ADMIN_ONLY'));
  next();
}
