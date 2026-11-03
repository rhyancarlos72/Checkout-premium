import { AlertTriangle, ArrowLeft, Building2, Eye, EyeOff, Hourglass, KeyRound, Lock, Mail, MailCheck, Phone, ShieldCheck, Sparkles, User, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { AuthLayout, DarkButton } from './AuthLayout';

type Mode = 'login' | 'forgot' | 'setup' | 'sent' | 'signup' | 'requested';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ needsSetup: boolean; adminEmailConfigured: boolean; dbReady: boolean } | null>(null);

  useEffect(() => {
    fetch('/api/auth/setup-status').then((r) => r.json()).then(setStatus).catch(() => {});
  }, []);

  const go = (m: Mode) => (setError(null), setMode(m));
  const [reg, setReg] = useState({ name: '', phone: '', company: '', message: '', website: '' });

  async function signup(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch('/api/auth/request-access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...reg, email: email.trim() }) });
    const json = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) return setError(json.issues?.[0]?.message ?? json.error ?? 'Não foi possível enviar seu cadastro.');
    go('requested');
  }
  const redirectTo = `${window.location.origin}/admin/nova-senha`;

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) setError(error.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : error.message === 'Email not confirmed' ? 'E-mail ainda não confirmado. Use “Esqueci minha senha”.' : error.message);
  }

  async function forgot(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
    setLoading(false);
    if (error && !/rate limit/i.test(error.message)) return setError(error.message);
    if (error) return setError('Muitos e-mails enviados. Aguarde alguns minutos e tente de novo.');
    go('sent');
  }

  async function setup(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim() }) });
    const json = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) return setError(json.error ?? 'Não foi possível concluir.');
    go('sent');
  }

  const emailField = (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-zinc-300">E-mail</span>
      <div className="relative">
        <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input className="input-dark" type="email" inputMode="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@email.com" />
      </div>
    </label>
  );
  const errorBox = error && (
    <div className="flex gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
    </div>
  );

  return (
    <AuthLayout>
      {!supabaseConfigured && (
        <p className="mb-5 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-200">Defina SUPABASE_URL e SUPABASE_ANON_KEY nas variáveis de ambiente do servidor e reinicie o app.</p>
      )}
      {status && !status.dbReady && (
        <p className="mb-5 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-200">Banco ainda não configurado: rode o SQL de <code>supabase/migrations</code> no SQL Editor do Supabase.</p>
      )}

      {mode === 'login' && (
        <form onSubmit={login} className="space-y-5">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-sky-400/25 bg-gradient-to-br from-blue-500/25 to-indigo-400/10 text-sky-300 shadow-[0_0_30px_-8px_rgba(59,130,246,.7)]"><Lock className="h-5 w-5" /></span>
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Bem-vindo de volta</h2>
              <p className="mt-1 text-sm text-zinc-400">Entre com segurança para acompanhar suas vendas.</p>
            </div>
          </div>
          {emailField}
          <label className="block">
            <span className="mb-1.5 flex items-center justify-between text-sm font-medium text-zinc-300">
              Senha
              <button type="button" onClick={() => go('forgot')} className="text-xs font-medium text-sky-300 hover:text-sky-200">Esqueci minha senha</button>
            </span>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <input className="input-dark pr-11" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-300" aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}>
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </label>
          {errorBox}
          <DarkButton type="submit" loading={loading}>Entrar no painel</DarkButton>
          {!status?.needsSetup && (
            <div className="relative py-1 text-center">
              <span className="absolute inset-x-0 top-1/2 h-px bg-white/10" />
              <span className="relative bg-[#070b14] px-3 text-xs text-zinc-500">ou</span>
            </div>
          )}
          {!status?.needsSetup && (
            <button type="button" onClick={() => go('signup')} className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[.03] py-3 text-sm font-medium text-zinc-200 transition hover:border-blue-400/40 hover:bg-white/5">
              <UserPlus className="h-4 w-4 text-sky-300" /> Não tem cadastro? <span className="font-semibold text-sky-300">Criar cadastro</span>
            </button>
          )}
          {status?.needsSetup && status.dbReady && (
            <button type="button" onClick={() => go('setup')} className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 py-3 text-sm font-medium text-zinc-200 transition hover:bg-white/5">
              <Sparkles className="h-4 w-4 text-amber-300" /> Primeiro acesso? Criar minha conta
            </button>
          )}
        </form>
      )}

      {mode === 'forgot' && (
        <form onSubmit={forgot} className="space-y-5">
          <button type="button" onClick={() => go('login')} className="flex items-center gap-1 text-sm text-zinc-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> Voltar</button>
          <div>
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-sky-400/15"><KeyRound className="h-5 w-5 text-sky-300" /></div>
            <h2 className="text-2xl font-bold tracking-tight">Criar nova senha</h2>
            <p className="mt-1 text-sm text-zinc-400">Enviaremos um link para o seu e-mail. Clique nele para definir uma senha nova.</p>
          </div>
          {emailField}
          {errorBox}
          <DarkButton type="submit" loading={loading}>Enviar link</DarkButton>
        </form>
      )}

      {mode === 'setup' && (
        <form onSubmit={setup} className="space-y-5">
          <button type="button" onClick={() => go('login')} className="flex items-center gap-1 text-sm text-zinc-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> Voltar</button>
          <div>
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-300/15"><Sparkles className="h-5 w-5 text-amber-300" /></div>
            <h2 className="text-2xl font-bold tracking-tight">Primeiro acesso</h2>
            <p className="mt-1 text-sm text-zinc-400">Digite o e-mail configurado como <code className="text-zinc-300">ADMIN_EMAIL</code>. Você vai receber um link para criar sua senha.</p>
          </div>
          {status && !status.adminEmailConfigured && (
            <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-200">Antes, cadastre a variável <b>ADMIN_EMAIL</b> (seu e-mail) na Hostinger e reinicie o app.</p>
          )}
          {emailField}
          {errorBox}
          <DarkButton type="submit" loading={loading}>Enviar link de acesso</DarkButton>
        </form>
      )}


      {mode === 'signup' && (
        <form onSubmit={signup} className="space-y-4">
          <button type="button" onClick={() => go('login')} className="flex items-center gap-1 text-sm text-zinc-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> Voltar ao login</button>
          <div>
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-sky-400/15"><UserPlus className="h-5 w-5 text-sky-300" /></div>
            <h2 className="text-2xl font-bold tracking-tight">Criar cadastro</h2>
            <p className="mt-1 text-sm text-zinc-400">Preencha seus dados. Seu pedido é analisado pelo administrador e, aprovado, você recebe por e-mail o link para criar sua senha.</p>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-300">Nome completo</span>
            <div className="relative">
              <User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <input className="input-dark" required minLength={3} autoComplete="name" value={reg.name} onChange={(e) => setReg({ ...reg, name: e.target.value })} placeholder="Seu nome" />
            </div>
          </label>
          {emailField}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-zinc-300">WhatsApp <span className="text-zinc-500">(opcional)</span></span>
              <div className="relative">
                <Phone className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <input className="input-dark" inputMode="tel" autoComplete="tel" value={reg.phone} onChange={(e) => setReg({ ...reg, phone: e.target.value })} placeholder="(11) 99999-9999" />
              </div>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-zinc-300">Empresa / projeto <span className="text-zinc-500">(opcional)</span></span>
              <div className="relative">
                <Building2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <input className="input-dark" autoComplete="organization" value={reg.company} onChange={(e) => setReg({ ...reg, company: e.target.value })} placeholder="Sua loja" />
              </div>
            </label>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-300">Mensagem <span className="text-zinc-500">(opcional)</span></span>
            <textarea className="input-dark h-20 resize-none py-2.5 !pl-3.5" maxLength={600} value={reg.message} onChange={(e) => setReg({ ...reg, message: e.target.value })} placeholder="Conte por que precisa de acesso" />
          </label>
          {/* armadilha anti-robô: invisível para pessoas */}
          <input type="text" tabIndex={-1} autoComplete="off" value={reg.website} onChange={(e) => setReg({ ...reg, website: e.target.value })} className="absolute -left-[9999px] h-0 w-0 opacity-0" aria-hidden />
          {errorBox}
          <DarkButton type="submit" loading={loading}>Enviar cadastro</DarkButton>
          <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-zinc-500"><ShieldCheck className="h-3.5 w-3.5 text-sky-400" /> Nenhum acesso é liberado sem aprovação do administrador.</p>
        </form>
      )}

      {mode === 'requested' && (
        <div className="space-y-5 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-sky-400/15 ring-8 ring-sky-400/5"><Hourglass className="h-8 w-8 text-sky-300" /></div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Cadastro enviado!</h2>
            <p className="mt-2 text-sm text-zinc-400">Recebemos seus dados, <b className="text-zinc-200">{reg.name.split(' ')[0]}</b>. Assim que o administrador aprovar, você recebe em <b className="break-words text-zinc-200 [overflow-wrap:anywhere]">{email}</b> o link para criar sua senha.</p>
          </div>
          <button type="button" onClick={() => go('login')} className="w-full rounded-xl border border-white/10 py-3 text-sm font-medium text-zinc-200 hover:bg-white/5">Voltar ao login</button>
        </div>
      )}

      {mode === 'sent' && (
        <div className="space-y-5 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-sky-400/15 ring-8 ring-sky-400/5"><MailCheck className="h-8 w-8 text-sky-300" /></div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Confira seu e-mail</h2>
            <p className="mt-2 text-sm text-zinc-400">Se <b className="text-zinc-200">{email}</b> tiver acesso, você vai receber um link em instantes. Abra-o neste aparelho para criar sua senha.</p>
            <p className="mt-3 text-xs text-zinc-500">Não chegou? Veja o spam/promoções. O link vale por 1 hora.</p>
          </div>
          <button type="button" onClick={() => go('login')} className="w-full rounded-xl border border-white/10 py-3 text-sm font-medium text-zinc-200 hover:bg-white/5">Voltar ao login</button>
        </div>
      )}
    </AuthLayout>
  );
}

/** Segunda etapa do login quando a verificação em 2 etapas (app autenticador) está ativa. */
export function MfaChallenge({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { data: factors, error: fe } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp?.find((f) => f.status === 'verified');
    if (fe || !factor) {
      setLoading(false);
      return setError(fe?.message ?? 'Nenhum autenticador encontrado.');
    }
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.replace(/\D/g, '') });
    setLoading(false);
    if (error) return setError(/invalid|expired/i.test(error.message) ? 'Código inválido ou expirado. Tente o código atual do app.' : error.message);
    onDone();
  }

  return (
    <AuthLayout>
      <form onSubmit={verify} className="space-y-5">
        <div>
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-sky-400/15"><ShieldCheck className="h-5 w-5 text-sky-300" /></div>
          <h2 className="text-2xl font-bold tracking-tight">Verificação em 2 etapas</h2>
          <p className="mt-1 text-sm text-zinc-400">Digite o código de 6 dígitos do seu app autenticador (Google Authenticator, Authy, 1Password…).</p>
        </div>
        <input
          className="input-dark text-center font-mono text-2xl tracking-[.5em]"
          style={{ paddingLeft: 16 }}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000"
        />
        {error && <div className="flex gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}</div>}
        <DarkButton type="submit" loading={loading} disabled={code.length !== 6}>Verificar e entrar</DarkButton>
        <button type="button" onClick={() => supabase.auth.signOut()} className="w-full text-center text-sm text-zinc-400 hover:text-white">Entrar com outra conta</button>
      </form>
    </AuthLayout>
  );
}
