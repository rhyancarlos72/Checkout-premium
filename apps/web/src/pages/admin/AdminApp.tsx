import { useQuery } from '@tanstack/react-query';
import { Boxes, CreditCard, Eye, EyeOff, LayoutDashboard, LogOut, Menu, Moon, PlugZap, RefreshCw, Settings, ShoppingCart, Sun, Ticket, Users, X, Zap } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { cn, PageLoader } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { AuthProvider, useAuth } from '@/lib/auth';
import { brl } from '@/lib/format';
import { BrandMark, defaultBrand, useBrand } from '@/lib/brand';
import { useMe } from '@/lib/me';
import { useHideEmail } from '@/lib/privacy';
import { supabase } from '@/lib/supabase';
import BumpsPage from './BumpsPage';
import CheckoutsPage from './CheckoutsPage';
import CouponsPage from './CouponsPage';
import CustomersPage from './CustomersPage';
import DashboardPage from './DashboardPage';
import IntegrationsPage from './IntegrationsPage';
import LoginPage, { MfaChallenge } from './LoginPage';
import NewPasswordPage from './NewPasswordPage';
import OrdersPage from './OrdersPage';
import ProductsPage from './ProductsPage';
import SettingsPage from './SettingsPage';

const nav = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/produtos', label: 'Produtos', icon: Boxes },
  { to: '/admin/pedidos', label: 'Vendas', icon: ShoppingCart },
  { to: '/admin/clientes', label: 'Clientes', icon: Users },
  { to: '/admin/checkouts', label: 'Checkouts', icon: CreditCard },
  { to: '/admin/order-bumps', label: 'Order Bumps', icon: Zap },
  { to: '/admin/cupons', label: 'Cupons', icon: Ticket },
  { to: '/admin/integracoes', label: 'Integrações', icon: PlugZap, ownerOnly: true },
  { to: '/admin/configuracoes', label: 'Configurações', icon: Settings },
];

// ------------------------------------------------------------------ tema
type AdminTheme = 'light' | 'dark';
/** Tema do painel: salvo no navegador; padrão = escuro (estilo do painel). */
function useAdminTheme(): [AdminTheme, () => void] {
  const [theme, setTheme] = useState<AdminTheme>(() => {
    try {
      const saved = localStorage.getItem('ck_admin_theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      /* ignore */
    }
    return 'dark';
  });
  useEffect(() => {
    document.documentElement.classList.toggle('admin-dark', theme === 'dark');
    try {
      localStorage.setItem('ck_admin_theme', theme);
    } catch {
      /* ignore */
    }
    return () => document.documentElement.classList.remove('admin-dark');
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

function ThemeToggle({ theme, onToggle, className }: { theme: AdminTheme; onToggle: () => void; className?: string }) {
  return (
    <button onClick={onToggle} className={cn('rounded-lg p-2 text-slate-400 transition hover:bg-white/5 hover:text-white', className)} aria-label={theme === 'dark' ? 'Usar modo claro' : 'Usar modo escuro'} title={theme === 'dark' ? 'Modo claro' : 'Modo escuro'}>
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

// ------------------------------------------------------------------ progresso da meta
function ProgressCard() {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['progress'],
    queryFn: () => adminApi.get<{ goal_cents: number; month_cents: number; updated_at: string }>('/progress'),
    refetchInterval: 120_000,
  });
  if (!data) return null;
  const goal = Math.max(1, data.goal_cents);
  const pct = Math.min(100, (data.month_cents / goal) * 100);
  const short = (c: number) => `R$ ${(c / 100).toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })}`;
  return (
    <div className="rounded-2xl border border-white/[.06] bg-white/[.03] p-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Meta do mês</p>
        <button onClick={() => refetch()} className="rounded-md border border-white/10 p-1 text-slate-400 hover:text-white" aria-label="Atualizar">
          <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="pv text-sm font-semibold text-white">{short(data.month_cents)} / {short(goal)}</p>
        <Link to="/admin/configuracoes?tab=loja" className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-bold text-white hover:bg-white/15">META</Link>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-[11px]">
        <span className="pv font-semibold text-blue-400">{pct.toFixed(0)}% concluído</span>
        <span className="pv text-slate-400">{data.month_cents >= goal ? 'Meta batida! 🎉' : `Faltam ${brl(goal - data.month_cents)}`}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ barra lateral
function Sidebar({ name, email, onNavigate, theme, onToggleTheme }: { name: string; email: string; onNavigate?: () => void; theme: AdminTheme; onToggleTheme: () => void }) {
  const brand = useBrand();
  const isOwner = useMe().data?.role === 'owner';
  const priv = useHideEmail();
  const pendingReq = useQuery({ queryKey: ['team-requests'], queryFn: () => adminApi.get<unknown[]>('/team/requests'), enabled: isOwner, refetchInterval: 120_000 }).data?.length ?? 0;
  return (
    <nav className="flex h-full flex-col border-r border-white/[.06] bg-[#0d1426] font-display text-slate-300">
      <div className="flex h-16 items-center gap-3 px-5">
        <BrandMark brand={brand} className="h-9 w-9" iconClassName="h-[18px] w-[18px]" />
        <div className="min-w-0 leading-tight">
          <p className="truncate font-semibold tracking-tight text-white">{brand.name === defaultBrand.name ? 'Checkout' : brand.name}</p>
          <p className="text-[11px] font-medium uppercase tracking-widest text-blue-300/80">{brand.name === defaultBrand.name ? 'Premium' : 'Painel'}</p>
        </div>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
        {nav.filter((n) => !('ownerOnly' in n && n.ownerOnly) || isOwner).map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[15px] font-medium transition',
                isActive ? 'bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-lg shadow-blue-600/25' : 'text-slate-300/90 hover:bg-white/[.05] hover:text-white',
              )
            }
          >
            <n.icon className="h-[19px] w-[19px]" strokeWidth={1.8} /> {n.label}
            {n.to === '/admin/configuracoes' && pendingReq > 0 && <span className="ml-auto rounded-full bg-sky-400 px-1.5 text-[10px] font-bold text-[#0d1426]" title="Pedidos de cadastro">{pendingReq}</span>}
          </NavLink>
        ))}
      </div>
      <div className="space-y-3 p-3">
        <ProgressCard />
        <div className="flex items-center gap-2 rounded-xl px-1.5 py-1.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-cyan-400 text-sm font-bold text-white">{(name || email)[0]?.toUpperCase()}</div>
          <Link to="/admin/configuracoes" onClick={onNavigate} className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{name || 'Administrador'}</p>
            <p className="truncate text-xs text-slate-400">{priv.show(email)}</p>
          </Link>
          <button onClick={priv.toggle} className="flex shrink-0 items-center rounded-md p-1 text-xs text-slate-400 transition hover:text-white" aria-label={priv.hidden ? 'Mostrar dados (sair do modo privado)' : 'Esconder dados (modo privado)'} title={priv.hidden ? 'Mostrar faturamento, vendas e nomes' : 'Esconder faturamento, vendas e nomes'} aria-pressed={priv.hidden}>
            {priv.hidden ? <EyeOff className="h-3.5 w-3.5 shrink-0" /> : <Eye className="h-3.5 w-3.5 shrink-0" />}
          </button>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button onClick={() => supabase.auth.signOut()} className="rounded-lg p-2 text-slate-400 transition hover:bg-white/5 hover:text-white" aria-label="Sair" title="Sair">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </nav>
  );
}

// ------------------------------------------------------------------ shell
function Shell() {
  const { session, loading } = useAuth();
  const [mfa, setMfa] = useState<'checking' | 'ok' | 'required'>('checking');

  useEffect(() => {
    if (!session) return setMfa('checking');
    supabase.auth.mfa
      .getAuthenticatorAssuranceLevel()
      .then(({ data }) => setMfa(data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2' ? 'required' : 'ok'))
      // Em erro, não trava o painel: o servidor continua exigindo o 2FA (MFA_REQUIRED)
      .catch(() => setMfa('ok'));
  }, [session]);

  if (loading) return <div className="bg-aurora min-h-screen"><PageLoader /></div>;
  if (!session) return <LoginPage />;
  if (mfa === 'checking') return <div className="bg-aurora min-h-screen"><PageLoader /></div>;
  if (mfa === 'required') return <MfaChallenge onDone={() => setMfa('ok')} />;
  return <AuthedShell email={session.user.email ?? ''} name={(session.user.user_metadata?.full_name as string) ?? ''} />;
}

function AuthedShell({ email, name }: { email: string; name: string }) {
  const brand = useBrand();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const [theme, toggleTheme] = useAdminTheme();

  return (
    <div className="min-h-screen bg-[#f6f7fb] font-display">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[268px] lg:block">
        <Sidebar name={name} email={email} theme={theme} onToggleTheme={toggleTheme} />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <aside className="animate-fade-in absolute inset-y-0 left-0 w-[284px] shadow-2xl">
            <button className="absolute right-3 top-4 z-10 rounded-lg p-1.5 text-slate-400" onClick={() => setOpen(false)} aria-label="Fechar menu">
              <X className="h-5 w-5" />
            </button>
            <Sidebar name={name} email={email} onNavigate={() => setOpen(false)} theme={theme} onToggleTheme={toggleTheme} />
          </aside>
        </div>
      )}
      <div className="lg:pl-[268px]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-white/[.06] bg-[#0d1426] px-4 text-white lg:hidden">
          <button onClick={() => setOpen(true)} className="rounded-lg p-1.5" aria-label="Abrir menu">
            <Menu className="h-5 w-5" />
          </button>
          <BrandMark brand={brand} className="h-7 w-7 rounded-lg" iconClassName="h-4 w-4" />
          <span className="flex-1 truncate font-semibold">{brand.name === defaultBrand.name ? 'Checkout' : brand.name}</span>
          <PrivacyToggle />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </header>
        <main key={location.pathname} className="animate-fade-in mx-auto max-w-[1440px] p-4 sm:p-6 lg:px-10 lg:py-9">
          <Routes>
            <Route index element={<DashboardPage name={name} />} />
            <Route path="produtos" element={<ProductsPage />} />
            <Route path="checkouts" element={<CheckoutsPage />} />
            <Route path="pedidos" element={<OrdersPage />} />
            <Route path="clientes" element={<CustomersPage />} />
            <Route path="order-bumps" element={<BumpsPage />} />
            <Route path="cupons" element={<CouponsPage />} />
            <Route path="integracoes" element={<OwnerOnly><IntegrationsPage /></OwnerOnly>} />
            <Route path="configuracoes" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/** Olhinho do topo (celular): liga/desliga o modo privado. */
function PrivacyToggle() {
  const priv = useHideEmail();
  return (
    <button onClick={priv.toggle} aria-pressed={priv.hidden} className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10" aria-label={priv.hidden ? 'Mostrar dados' : 'Esconder dados'} title={priv.hidden ? 'Mostrar dados' : 'Esconder dados'}>
      {priv.hidden ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
    </button>
  );
}

/** Integrações: só o dono da conta. */
function OwnerOnly({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isLoading) return <PageLoader />;
  if (me.data?.role === 'owner') return <>{children}</>;
  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600"><PlugZap className="h-6 w-6" /></div>
      <h2 className="mt-4 font-display text-lg font-semibold text-zinc-900">Acesso restrito ao dono da conta</h2>
      <p className="mt-1 text-sm text-zinc-500">As integrações com Woovi, Efí Bank, WhatsApp e webhooks só podem ser vistas e alteradas pelo dono.</p>
    </div>
  );
}

export default function AdminApp() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="nova-senha" element={<NewPasswordPage />} />
        <Route path="*" element={<Shell />} />
      </Routes>
    </AuthProvider>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="font-display text-[30px] font-bold leading-tight tracking-tight text-zinc-900">{title}</h1>
        {subtitle && <p className="mt-1 text-[15px] text-zinc-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

