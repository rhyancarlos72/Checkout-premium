import { AlertTriangle, CheckCircle2, Eye, EyeOff, KeyRound, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { AuthLayout, DarkButton } from './AuthLayout';

function strength(p: string) {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return Math.min(s, 4);
}
const labels = ['Muito fraca', 'Fraca', 'Razoável', 'Boa', 'Forte'];
const colors = ['bg-red-500', 'bg-orange-500', 'bg-amber-400', 'bg-lime-400', 'bg-emerald-400'];

/** Aberta pelo link do e-mail (recuperação ou convite). O supabase-js lê o token da URL e cria a sessão. */
export default function NewPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState<'checking' | 'ok' | 'invalid'>('checking');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const urlError = hash.get('error_description') || new URLSearchParams(window.location.search).get('error_description');
    if (urlError) {
      setError(urlError.includes('expired') ? 'Este link expirou. Peça um novo em “Esqueci minha senha”.' : urlError);
      setReady('invalid');
      return;
    }
    const { data } = supabase.auth.onAuthStateChange((_e, session) => session && setReady('ok'));
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady('ok');
      else setTimeout(() => setReady((r) => (r === 'checking' ? 'invalid' : r)), 2500);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) return setError('Use pelo menos 8 caracteres.');
    if (pw !== pw2) return setError('As senhas não conferem.');
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setLoading(false);
    if (error) return setError(error.message.includes('different from the old') ? 'A nova senha precisa ser diferente da anterior.' : error.message);
    setDone(true);
    window.history.replaceState(null, '', '/admin/nova-senha');
    setTimeout(() => navigate('/admin', { replace: true }), 1600);
  }

  const s = strength(pw);
  return (
    <AuthLayout>
      {done ? (
        <div className="space-y-4 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-400/15 ring-8 ring-emerald-400/5"><CheckCircle2 className="h-8 w-8 text-emerald-300" /></div>
          <h2 className="text-2xl font-bold">Senha criada!</h2>
          <p className="text-sm text-zinc-400">Entrando no painel…</p>
        </div>
      ) : ready === 'checking' ? (
        <div className="flex flex-col items-center gap-3 py-8 text-zinc-400">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-emerald-300" /> Validando link…
        </div>
      ) : ready === 'invalid' ? (
        <div className="space-y-5 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-500/15"><AlertTriangle className="h-7 w-7 text-red-300" /></div>
          <div>
            <h2 className="text-xl font-bold">Link inválido ou expirado</h2>
            <p className="mt-2 text-sm text-zinc-400">{error ?? 'Abra o link mais recente enviado ao seu e-mail, ou peça um novo.'}</p>
          </div>
          <DarkButton onClick={() => navigate('/admin', { replace: true })}>Pedir novo link</DarkButton>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <div>
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-400/15"><KeyRound className="h-5 w-5 text-emerald-300" /></div>
            <h2 className="text-2xl font-bold tracking-tight">Defina sua nova senha</h2>
            <p className="mt-1 text-sm text-zinc-400">Use pelo menos 8 caracteres, misturando letras, números e símbolos.</p>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-300">Nova senha</span>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <input className="input-dark pr-11" type={show ? 'text' : 'password'} autoComplete="new-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
              <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-300" aria-label="Mostrar senha">
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {pw && (
              <div className="mt-2">
                <div className="flex gap-1">{[0, 1, 2, 3].map((i) => <div key={i} className={cn('h-1.5 flex-1 rounded-full transition', i < s ? colors[s] : 'bg-white/10')} />)}</div>
                <p className="mt-1 text-xs text-zinc-400">{labels[s]}</p>
              </div>
            )}
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-300">Confirmar senha</span>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <input className="input-dark" type={show ? 'text' : 'password'} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </div>
          </label>
          {error && <div className="flex gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}</div>}
          <DarkButton type="submit" loading={loading}>Salvar senha e entrar</DarkButton>
        </form>
      )}
    </AuthLayout>
  );
}
