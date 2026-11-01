import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { PageLoader } from './components/ui';
import './index.css';
import CheckoutPage from './pages/checkout/CheckoutPage';

// Painel carregado sob demanda → o checkout fica leve e rápido
const AdminApp = lazy(() => import('./pages/admin/AdminApp'));
// Página do Pix em arquivo separado: o checkout baixa menos código na primeira visita
const PaymentPage = lazy(() => import('./pages/checkout/PaymentPage'));

// Links de e-mail do Supabase (recuperação/convite) podem cair na raiz: leva para a tela de nova senha mantendo o token.
function RootRedirect() {
  const { hash } = useLocation();
  const isAuthLink = /type=(recovery|invite|signup|magiclink)|error_description/.test(hash);
  return <Navigate to={(isAuthLink ? '/admin/nova-senha' : '/admin') + hash} replace />;
}

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 15_000 } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/checkout" element={<CheckoutPage />} />
            <Route path="/c/:slug" element={<CheckoutPage />} />
            <Route path="/pedido/:token" element={<PaymentPage />} />
            <Route path="/admin/*" element={<AdminApp />} />
            <Route path="*" element={<RootRedirect />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
