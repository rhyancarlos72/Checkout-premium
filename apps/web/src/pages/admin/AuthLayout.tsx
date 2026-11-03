import { Activity, Fingerprint, KeyRound, Lock, ShieldCheck, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandMark, useBrand } from '@/lib/brand';

/** Escudo animado: anéis orbitando, varredura e núcleo com cadeado (passa a sensação de proteção ativa). */
function SecurityCore() {
  return (
    <div className="auth-core relative mx-auto h-[260px] w-[260px]" aria-hidden>
      <div className="auth-ring absolute inset-0 rounded-full border border-emerald-400/20" />
      <div className="auth-ring auth-ring-rev absolute inset-6 rounded-full border border-dashed border-cyan-300/25" />
      <div className="auth-ring auth-ring-slow absolute inset-12 rounded-full border border-violet-300/20" />
      {/* pontos orbitando */}
      <div className="auth-orbit absolute inset-0">
        <span className="absolute left-1/2 top-0 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-300 shadow-[0_0_16px_4px_rgba(52,211,153,.7)]" />
      </div>
      <div className="auth-orbit auth-orbit-rev absolute inset-6">
        <span className="absolute bottom-0 left-1/2 h-2 w-2 -translate-x-1/2 translate-y-1/2 rounded-full bg-cyan-300 shadow-[0_0_14px_4px_rgba(103,232,249,.7)]" />
      </div>
      {/* núcleo */}
      <div className="absolute inset-[78px] flex items-center justify-center overflow-hidden rounded-[28px] border border-white/10 bg-gradient-to-br from-emerald-500/25 via-cyan-500/15 to-violet-500/25 shadow-[0_0_60px_-10px_rgba(16,185,129,.6)] backdrop-blur-md">
        <ShieldCheck className="h-14 w-14 text-emerald-200 drop-shadow-[0_0_12px_rgba(110,231,183,.8)]" strokeWidth={1.5} />
        <span className="auth-scan absolute inset-x-0 h-10 bg-gradient-to-b from-transparent via-emerald-300/35 to-transparent" />
      </div>
    </div>
  );
}

const seals = [
  { icon: Lock, title: 'Criptografia de ponta a ponta', text: 'Conexão HTTPS (TLS) e senhas nunca armazenadas em texto' },
  { icon: Fingerprint, title: 'Verificação em 2 etapas', text: 'Código do app autenticador a cada login' },
  { icon: KeyRound, title: 'Credenciais blindadas', text: 'Chaves de pagamento só no servidor, mascaradas no painel' },
];

/** Layout das telas de acesso (login, primeiro acesso, nova senha, 2FA). */
export function AuthLayout({ children }: { children: ReactNode }) {
  const brand = useBrand();
  return (
    <div className="auth-bg relative min-h-screen overflow-hidden text-white">
      {/* camadas de fundo */}
      <div className="auth-mesh pointer-events-none absolute inset-0" />
      <div className="auth-grid pointer-events-none absolute inset-x-0 bottom-0 h-[55%]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(3,5,10,.85))]" />
      {[...Array(14)].map((_, i) => (
        <span key={i} className="auth-particle pointer-events-none absolute rounded-full bg-cyan-200/70" style={{ left: `${(i * 37) % 100}%`, width: i % 3 ? 2 : 3, height: i % 3 ? 2 : 3, animationDelay: `${-i * 1.7}s`, animationDuration: `${12 + (i % 5) * 3}s` }} />
      ))}

      <div className="relative mx-auto grid min-h-screen max-w-6xl items-center gap-10 px-4 py-10 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:px-8">
        {/* vitrine (desktop) */}
        <div className="hidden lg:block">
          <div className="mb-8 flex items-center gap-3">
            <BrandMark brand={brand} className="h-11 w-11 rounded-2xl" iconClassName="h-5 w-5" fallbackClassName="bg-gradient-to-br from-emerald-400 to-cyan-500 shadow-lg shadow-emerald-500/30" />
            <span className="text-lg font-semibold tracking-tight">{brand.name}</span>
          </div>

          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-200">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" /></span>
            Todos os sistemas operando normalmente
          </div>

          <h1 className="text-[46px] font-bold leading-[1.04] tracking-tight">
            Acesso protegido
            <br />
            <span className="text-gradient">ao seu negócio.</span>
          </h1>
          <p className="mt-4 max-w-md text-[17px] leading-relaxed text-zinc-400">Vendas, Pix e integrações em um painel blindado. Só quem tem a chave entra.</p>

          <div className="mt-8 grid grid-cols-[260px_1fr] items-center gap-8">
            <SecurityCore />
            <ul className="space-y-4">
              {seals.map((s) => (
                <li key={s.title} className="flex gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[.04] text-emerald-300"><s.icon className="h-4 w-4" /></span>
                  <span>
                    <span className="block text-sm font-semibold text-white">{s.title}</span>
                    <span className="block text-xs leading-relaxed text-zinc-400">{s.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-8 flex items-center gap-5 text-xs text-zinc-500">
            <span className="flex items-center gap-1.5"><Activity className="h-3.5 w-3.5 text-cyan-300" /> Monitoramento contínuo</span>
            <span className="flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-amber-300" /> Pix aprovado em segundos</span>
          </div>
        </div>

        {/* formulário */}
        <div className="mx-auto w-full max-w-md">
          <div className="mb-7 flex flex-col items-center gap-3 lg:hidden">
            <BrandMark brand={brand} className="h-12 w-12 rounded-2xl" iconClassName="h-6 w-6" fallbackClassName="bg-gradient-to-br from-emerald-400 to-cyan-500 shadow-lg shadow-emerald-500/30" />
            <span className="text-lg font-semibold tracking-tight">{brand.name}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-200"><ShieldCheck className="h-3 w-3" /> Conexão segura</span>
          </div>

          <div className="auth-card-border animate-fade-in rounded-[26px] p-px">
            <div className="relative overflow-hidden rounded-[25px] bg-[#070b14]/90 p-7 shadow-2xl shadow-black/60 backdrop-blur-xl sm:p-9">
              <div className="pointer-events-none absolute -top-24 left-1/2 h-48 w-72 -translate-x-1/2 rounded-full bg-emerald-500/15 blur-3xl" />
              <div className="relative">{children}</div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[11px] text-zinc-500">
            <span className="flex items-center gap-1.5"><Lock className="h-3 w-3 text-emerald-400" /> Criptografado</span>
            <span className="h-1 w-1 rounded-full bg-zinc-700" />
            <span className="flex items-center gap-1.5"><Fingerprint className="h-3 w-3 text-cyan-300" /> 2FA disponível</span>
            <span className="h-1 w-1 rounded-full bg-zinc-700" />
            <span>Acesso restrito a administradores</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DarkButton({ loading, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button {...rest} disabled={loading || rest.disabled} className="btn-shine group relative flex h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-xl font-semibold text-white shadow-lg shadow-emerald-500/20 transition active:scale-[.98] disabled:opacity-60">
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
      {children}
    </button>
  );
}
