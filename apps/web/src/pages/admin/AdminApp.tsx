import { BarChart3, Boxes, CreditCard, LogOut, Menu, PlugZap, ShoppingBag, Sparkles, Ticket, Users, X } from 'lucide-react';
import { useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
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
import OrdersPage from './OrdersPage';
import ProductsPage from './ProductsPage';

const nav = [
  { to: '/admin', label: 'Visão geral', icon: BarChart3, end: true },
  { to: '/admin/produtos', label: 'Produtos', icon: Boxes },
  { to: '/admin/checkouts', label: 'Checkouts', icon: CreditCard },
  { to: '/admin/pedidos', label: 'Pedidos', icon: ShoppingBag },
  { to: '/admin/clientes', label: 'Clientes', icon: Users },
  { to: '/admin/order-bumps', label: 'Order bumps', icon: Sparkles },
  { to: '/admin/cupons', label: 'Cupons', icon: Ticket },
  { to: '/admin/integracoes', label: 'Integrações', icon: PlugZap },
];

function Shell() {
  const { session, loading } = useAuth();
  const [open, setOpen] = useState(false);
  if (loading) return <PageLoader />;
  if (!session) return <LoginPage />;

  const sidebar = (
    <nav className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2 px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
          <CreditCard className="h-4 w-4" />
        </div>
        <span className="font-semibold tracking-tight">Checkout</span>
      </div>
      <div className="flex-1 space-y-0.5 px-3 py-2">
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            onClick={() => setOpen(false)}
            className={({ isActive }) =>
              cn('flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition', isActive ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')
            }
          >
            <n.icon className="h-[18px] w-[18px]" /> {n.label}
          </NavLink>
        ))}
      </div>
      <div className="border-t border-gray-100 p-3">
        <p className="truncate px-3 pb-2 text-xs text-gray-500">{session.user.email}</p>
        <button onClick={() => supabase.auth.signOut()} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-100">
          <LogOut className="h-[18px] w-[18px]" /> Sair
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-gray-200 bg-white lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-gray-900/40" onClick={() => setOpen(false)} />
          <aside className="animate-fade-in absolute inset-y-0 left-0 w-72 bg-white shadow-xl">
            <button className="absolute right-3 top-4 rounded-lg p-1.5 text-gray-500" onClick={() => setOpen(false)} aria-label="Fechar menu">
              <X className="h-5 w-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-gray-200 bg-white/90 px-4 backdrop-blur lg:hidden">
          <button onClick={() => setOpen(true)} className="rounded-lg p-1.5 text-gray-700" aria-label="Abrir menu">
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-semibold">Checkout</span>
        </header>
        <main className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
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
      <Shell />
    </AuthProvider>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
