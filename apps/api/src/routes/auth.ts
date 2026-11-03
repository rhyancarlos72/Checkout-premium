import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env.js';
import { clientIp, HttpError, logger, supabase } from '../lib/core.js';
import { sendAccessRequestNotice } from '../services/email.js';

/**
 * Primeiro acesso: cria (ou recupera) a conta do dono e o torna admin.
 * Segurança:
 *  - só funciona enquanto NÃO existe nenhum admin;
 *  - só para o e-mail definido em ADMIN_EMAIL (variável de ambiente);
 *  - a senha é definida pelo link enviado para esse e-mail, então só quem
 *    tem acesso à caixa de entrada consegue entrar.
 */
export const authRouter = Router();

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Muitas tentativas. Aguarde 15 minutos.' } });

async function adminCount() {
  const { count, error } = await supabase.from('admins').select('user_id', { count: 'exact', head: true });
  if (error) {
    if (error.code === '42P01' || /relation .* does not exist|schema cache/i.test(error.message)) {
      throw new HttpError(503, 'Banco ainda não configurado: rode o SQL da migração no Supabase (supabase/migrations).', 'DB_NOT_READY');
    }
    throw new HttpError(500, error.message);
  }
  return count ?? 0;
}

authRouter.get('/setup-status', async (_req, res) => {
  try {
    const count = await adminCount();
    res.json({ needsSetup: count === 0, adminEmailConfigured: Boolean(env.ADMIN_EMAIL), dbReady: true });
  } catch (e) {
    if (e instanceof HttpError && e.code === 'DB_NOT_READY') return res.json({ needsSetup: true, adminEmailConfigured: Boolean(env.ADMIN_EMAIL), dbReady: false });
    throw e;
  }
});

async function findUserByEmail(email: string) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new HttpError(500, error.message);
    const u = data.users.find((x) => x.email?.toLowerCase() === email);
    if (u) return u;
    if (data.users.length < 200) return null;
  }
  return null;
}

authRouter.post('/setup', limiter, async (req, res) => {
  const { email } = z.object({ email: z.string().trim().toLowerCase().email('E-mail inválido') }).parse(req.body);
  if (!env.ADMIN_EMAIL) throw new HttpError(400, 'Defina a variável ADMIN_EMAIL (seu e-mail) na Hostinger e reinicie o app.');
  if ((await adminCount()) > 0) throw new HttpError(403, 'O administrador já foi criado. Use "Esqueci minha senha".');
  if (email !== env.ADMIN_EMAIL) throw new HttpError(403, 'Este e-mail não é o ADMIN_EMAIL configurado no servidor.');

  const redirectTo = `${env.PUBLIC_URL}/admin/nova-senha`;
  let user = await findUserByEmail(email);
  if (!user) {
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo });
    if (error) {
      logger.error({ err: error.message }, 'Falha ao convidar admin');
      throw new HttpError(502, `Não foi possível enviar o e-mail: ${error.message}`);
    }
    user = data.user;
  } else {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw new HttpError(502, `Não foi possível enviar o e-mail: ${error.message}`);
  }
  const { error } = await supabase.from('admins').upsert({ user_id: user!.id });
  if (error) throw new HttpError(500, error.message);
  res.json({ ok: true });
});

/**
 * "Criar cadastro" na tela de login: registra um PEDIDO de acesso (não cria conta).
 * O dono aprova em Configurações → Equipe; só então a pessoa recebe o link para criar a senha.
 */
const requestLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Muitos pedidos. Tente novamente mais tarde.' } });
authRouter.post('/request-access', requestLimiter, async (req, res) => {
  const b = z
    .object({
      name: z.string().trim().min(3, 'Informe seu nome completo').max(120),
      email: z.string().trim().toLowerCase().email('E-mail inválido').max(160),
      phone: z.string().trim().max(30).optional().nullable(),
      company: z.string().trim().max(120).optional().nullable(),
      message: z.string().trim().max(600).optional().nullable(),
      website: z.string().optional(), // armadilha anti-robô (campo invisível)
    })
    .parse(req.body);
  if (b.website) return res.json({ ok: true }); // robô: finge sucesso
  const { error } = await supabase.from('access_requests').insert({ name: b.name, email: b.email, phone: b.phone || null, company: b.company || null, message: b.message || null, ip: clientIp(req as any) });
  if (error) {
    if (/duplicate|unique/i.test(error.message)) return res.json({ ok: true, already: true });
    if (/relation|does not exist|schema cache/i.test(error.message)) throw new HttpError(503, 'Cadastro indisponível no momento. Fale com o administrador.');
    throw new HttpError(500, error.message);
  }
  if (env.ADMIN_EMAIL) void sendAccessRequestNotice(env.ADMIN_EMAIL, b).catch(() => {});
  res.json({ ok: true });
});
