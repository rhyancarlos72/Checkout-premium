import { BarChart3, Boxes, CreditCard, LogOut, Menu, Moon, PlugZap, ShoppingBag, Sparkles, Sun, Ticket, Users, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { cn, PageLoader } from '@/components/ui';
import { AuthProvider, useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import BumpsPage from './BumpsPage';
import CheckoutsPage from './CheckoutsPage';
import CouponsPage from './CouponsPage';
import CustomersPage from './CustomersPage';
import DashboardPage from './DashboardPage';
import IntegrationsPage from './IntegrationsPage';
import LoginPage from './LoginPage';
import NewPasswordPage from './NewPasswordPage';
import OrdersPage from './OrdersPage';
import ProductsPage from './ProductsPage';

const groups = [
  {
    label: 'Geral',
    items: [
      { to: '/admin', label: 'Visão geral', icon: BarChart3, end: true },
      { to: '/admin/pedidos', label: 'Pedidos', icon: ShoppingBag },
      { to: '/admin/clientes', label: 'Clientes', icon: Users },
    ],
  },
  {
    label: 'Vendas',
    items: [
      { to: '/admin/produtos', label: 'Produtos', icon: Boxes },
      { to: '/admin/checkouts', label: 'Checkouts', icon: CreditCard },
      { to: '/admin/order-bumps', label: 'Order bumps', icon: Sparkles },
      { to: '/admin/cupons', label: 'Cupons', icon: Ticket },
    ],
  },
  { label: 'Sistema', items: [{ to: '/admin/integracoes', label: 'Integrações', icon: PlugZap }] },
];

type AdminTheme = 'light' | 'dark';
/** Tema do painel: salvo no navegador; padrão = preferência do aparelho. */
function useAdminTheme(): [AdminTheme, () => void] {
  const [theme, setTheme] = useState<AdminTheme>(() => {
    try {
      const saved = localStorage.getItem('ck_admin_theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      /* ignore */
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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

function ThemeToggle({ theme, onToggle }: { theme: AdminTheme; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className="rounded-lg p-2 text-zinc-500 transition hover:bg-white/5 hover:text-white" aria-label={theme === 'dark' ? 'Usar modo claro' : 'Usar modo escuro'} title={theme === 'dark' ? 'Modo claro' : 'Modo escuro'}>
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function Sidebar({ email, onNavigate, theme, onToggleTheme }: { email: string; onNavigate?: () => void; theme: AdminTheme; onToggleTheme: () => void }) {
  const initial = (email[0] ?? '?').toUpperCase();
  return (
    <nav className="relative flex h-full flex-col overflow-hidden bg-[#07090f] text-zinc-300">
      <div className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full bg-emerald-500/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-20 h-72 w-72 rounded-full bg-violet-600/15 blur-3xl" />
      <div className="relative flex h-16 items-center gap-3 px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-cyan-500 shadow-lg shadow-emerald-500/30">
          <CreditCard className="h-[18px] w-[18px] text-white" />
        </div>
        <div className="leading-tight">
          <p className="font-semibold tracking-tight text-white">Checkout</p>
          <p className="text-[11px] font-medium uppercase tracking-widest text-emerald-300/80">Premium</p>
        </div>
      </div>
      <div className="relative flex-1 space-y-6 overflow-y-auto px-3 py-4">
        {groups.map((g) => (
          <div key={g.label}>
            <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">{g.label}</p>
            <div className="space-y-0.5">
              {g.items.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                      isActive ? 'bg-white/[.08] text-white shadow-inner shadow-white/5' : 'text-zinc-400 hover:bg-white/[.04] hover:text-zinc-100',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-gradient-to-b from-emerald-300 to-cyan-400" />}
                      <n.icon className={cn('h-[18px] w-[18px] transition', isActive ? 'text-emerald-300' : 'text-zinc-500 group-hover:text-zinc-300')} />
                      {n.label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="relative border-t border-white/[.06] p-3">
        <div className="flex items-center gap-3 rounded-xl px-2 py-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-cyan-400 text-sm font-bold text-white">{initial}</div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">Administrador</p>
            <p className="truncate text-xs text-zinc-500">{email}</p>
          </div>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button onClick={() => supabase.auth.signOut()} className="rounded-lg p-2 text-zinc-500 transition hover:bg-white/5 hover:text-white" aria-label="Sair" title="Sair">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </nav>
  );
}

function Shell() {
  const { session, loading } = useAuth();
  if (loading) return <div className="bg-aurora min-h-screen"><PageLoader /></div>;
  if (!session) return <LoginPage />;
  return <AuthedShell email={session.user.email ?? ''} />;
}

function AuthedShell({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const [theme, toggleTheme] = useAdminTheme();

  return (
    <div className="min-h-screen bg-[#f6f7fb]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[264px] lg:block">
        <Sidebar email={email} theme={theme} onToggleTheme={toggleTheme} />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <aside className="animate-fade-in absolute inset-y-0 left-0 w-[280px] shadow-2xl">
            <button className="absolute right-3 top-4 z-10 rounded-lg p-1.5 text-zinc-400" onClick={() => setOpen(false)} aria-label="Fechar menu">
              <X className="h-5 w-5" />
            </button>
            <Sidebar email={email} onNavigate={() => setOpen(false)} theme={theme} onToggleTheme={toggleTheme} />
          </aside>
        </div>
      )}
      <div className="lg:pl-[264px]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-white/5 bg-[#07090f] px-4 text-white lg:hidden">
          <button onClick={() => setOpen(true)} className="rounded-lg p-1.5" aria-label="Abrir menu">
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500"><CreditCard className="h-4 w-4" /></div>
          <span className="flex-1 font-semibold">Checkout</span>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </header>
        <main key={location.pathname} className="animate-fade-in mx-auto max-w-7xl p-4 sm:p-6 lg:p-10">
          <Routes>
            <Route index element={<DashboardPage />} />
            <Route path="produtos" element={<ProductsPage />} />
            <Route path="checkouts" element={<CheckoutsPage />} />
            <Route path="pedidos" element={<OrdersPage />} />
            <Route path="clientes" element={<CustomersPage />} />
            <Route path="order-bumps" element={<BumpsPage />} />
            <Route path="cupons" element={<CouponsPage />} />
            <Route path="integracoes" element={<IntegrationsPage />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </main>
      </div>
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
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-zinc-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
