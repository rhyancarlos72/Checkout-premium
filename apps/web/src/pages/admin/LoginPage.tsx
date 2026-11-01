import { CreditCard, Lock, Mail } from 'lucide-react';
import { useState } from 'react';
import { Button, Field, Input } from '@/components/ui';
import { supabase, supabaseConfigured } from '@/lib/supabase';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) setError(error.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos' : error.message);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-600 text-white">
            <CreditCard className="h-5 w-5" />
          </div>
          <div>
            <p className="font-semibold leading-tight">Painel do checkout</p>
            <p className="text-xs text-gray-500">Acesso restrito</p>
          </div>
        </div>
        {!supabaseConfigured && (
          <p className="mb-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-800">Defina SUPABASE_URL e SUPABASE_ANON_KEY nas variáveis de ambiente do servidor e reinicie o app.</p>
        )}
        <div className="space-y-4">
          <Field label="E-mail">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} icon={<Mail className="h-4 w-4" />} required />
          </Field>
          <Field label="Senha">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} icon={<Lock className="h-4 w-4" />} required />
          </Field>
          {error && <p className="text-sm font-medium text-red-600">{error}</p>}
          <Button type="submit" className="w-full" loading={loading}>
            Entrar
          </Button>
        </div>
      </form>
    </div>
  );
}
