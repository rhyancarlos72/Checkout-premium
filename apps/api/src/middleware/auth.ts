import type { NextFunction, Request, Response } from 'express';
import { HttpError, supabase } from '../lib/core.js';

declare module 'express-serve-static-core' {
  interface Request {
    adminId?: string;
    adminEmail?: string;
  }
}

/** Valida o JWT do Supabase Auth e exige que o usuário esteja na tabela `admins`. */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'Não autenticado');
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) throw new HttpError(401, 'Sessão inválida ou expirada');
    const { data: admin } = await supabase.from('admins').select('user_id').eq('user_id', data.user.id).maybeSingle();
    if (!admin) throw new HttpError(403, 'Acesso restrito a administradores');
    req.adminId = data.user.id;
    req.adminEmail = data.user.email ?? undefined;
    next();
  } catch (e) {
    next(e);
  }
}
