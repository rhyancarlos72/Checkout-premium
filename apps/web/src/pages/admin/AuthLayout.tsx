import { CheckCircle2, CreditCard, ShieldCheck, TrendingUp, Zap } from 'lucide-react';
import type { ReactNode } from 'react';

/** Layout escuro com aurora + grid usado no login, primeiro acesso e nova senha. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-aurora relative min-h-screen overflow-hidden text-white">
      <div className="bg-grid pointer-events-none absolute inset-0" />
      <div className="relative mx-auto grid min-h-screen max-w-6xl items-center gap-12 px-4 py-10 lg:grid-cols-2 lg:px-8">
        {/* Lado esquerdo — vitrine (desktop) */}
        <div className="hidden lg:block">
          <div className="mb-10 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-cyan-500 shadow-lg shadow-emerald-500/30">
              <CreditCard className="h-5 w-5 text-white" />
            </div>
            <span className="text-lg font-semibold tracking-tight">Checkout Premium</span>
          </div>
          <h1 className="text-5xl font-bold leading-[1.05] tracking-tight">
            Seu checkout.
            <br />
            <span className="text-gradient">Suas regras.</span>
          </h1>
          <p className="mt-5 max-w-md text-lg text-zinc-400">PIX aprovado em segundos, order bumps, cupons, entrega automática e rastreamento completo em um só painel.</p>

          <div className="relative mt-12 h-56">
            <div className="glass animate-float absolute left-0 top-0 w-72 rounded-2xl p-4 shadow-2xl">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/20"><CheckCircle2 className="h-5 w-5 text-emerald-400" /></div>
                <div className="flex-1">
                  <p className="text-sm font-semibold">Venda aprovada</p>
                  <p className="text-xs text-zinc-400">PIX · agora mesmo</p>
                </div>
                <p className="font-bold text-emerald-400">R$ 197,00</p>
              </div>
            </div>
            <div className="glass animate-float absolute left-40 top-24 w-64 rounded-2xl p-4 shadow-2xl [animation-delay:-3s]">
              <div className="flex items-center justify-between text-xs text-zinc-400"><span>Faturamento hoje</span><TrendingUp className="h-4 w-4 text-cyan-400" /></div>
              <p className="mt-1 text-2xl font-bold">R$ 4.380</p>
              <div className="mt-3 flex h-10 items-end gap-1">
                {[30, 45, 38, 60, 52, 75, 68, 90, 82, 100].map((h, i) => (
                  <div key={i} className="flex-1 rounded-t bg-gradient-to-t from-cyan-500/40 to-emerald-400" style={{ height: `${h}%` }} />
                ))}
              </div>
            </div>
          </div>

          <div className="mt-6 flex gap-6 text-sm text-zinc-400">
            <span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-400" /> Dados criptografados</span>
            <span className="flex items-center gap-2"><Zap className="h-4 w-4 text-amber-300" /> Liberação automática</span>
          </div>
        </div>

        {/* Lado direito — formulário */}
        <div className="mx-auto w-full max-w-md">
          <div className="mb-8 flex items-center justify-center gap-3 lg:hidden">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-cyan-500 shadow-lg shadow-emerald-500/30">
              <CreditCard className="h-5 w-5 text-white" />
            </div>
            <span className="text-lg font-semibold tracking-tight">Checkout Premium</span>
          </div>
          <div className="glass animate-fade-in rounded-3xl p-7 shadow-2xl shadow-black/40 sm:p-9">{children}</div>
          <p className="mt-6 text-center text-xs text-zinc-500">Acesso restrito a administradores</p>
        </div>
      </div>
    </div>
  );
}

export function DarkButton({ loading, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button {...rest} disabled={loading || rest.disabled} className="btn-shine flex h-12 w-full items-center justify-center gap-2 rounded-xl font-semibold text-white active:scale-[.98] disabled:opacity-60">
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
      {children}
    </button>
  );
}
