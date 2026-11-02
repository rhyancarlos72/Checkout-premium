import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { HttpError, supabase } from '../lib/core.js';

declare module 'express-serve-static-core' {
  interface Request {
    adminId?: string;
    adminEmail?: string;
    adminRole?: 'owner' | 'staff';
  }
}

// Cache da validação (60s): antes, cada clique no painel fazia 2 chamadas ao Supabase.
const authCache = new Map<string, { at: number; id: string; email?: string; role: 'owner' | 'staff' }>();
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
    if (!admin) throw new HttpError(403, 'Acesso restrito a administradores');
    const email = data.user.email?.toLowerCase();
    // ADMIN_EMAIL é sempre dono; com ADMIN_EMAIL definido, ninguém além dele vira dono pelo banco
    const role: 'owner' | 'staff' = env.ADMIN_EMAIL ? (email === env.ADMIN_EMAIL ? 'owner' : 'staff') : admin.role === 'owner' ? 'owner' : 'staff';
    req.adminId = data.user.id;
    req.adminEmail = data.user.email ?? undefined;
    req.adminRole = role;
    authCache.set(token, { at: Date.now(), id: data.user.id, email: data.user.email ?? undefined, role });
    if (authCache.size > 1000) authCache.delete(authCache.keys().next().value!);
    next();
  } catch (e) {
    next(e);
  }
}

/** Só o dono: credenciais e integrações (Woovi, Efí, Evolution, webhooks) e gestão da equipe. */
export function requireOwner(req: Request, _res: Response, next: NextFunction) {
  if (req.adminRole !== 'owner') return next(new HttpError(403, 'Somente o dono da conta acessa as integrações', 'OWNER_ONLY'));
  next();
}
