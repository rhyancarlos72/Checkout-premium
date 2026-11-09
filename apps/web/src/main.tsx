import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { PageLoader } from './components/ui';
// Fontes servidas pelo próprio site (sem bloquear a renderização com o Google Fonts)
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/outfit/latin-400.css';
import '@fontsource/outfit/latin-500.css';
import '@fontsource/outfit/latin-600.css';
import '@fontsource/outfit/latin-700.css';
import '@fontsource/outfit/latin-800.css';
import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-500.css';
import '@fontsource/poppins/latin-600.css';
import '@fontsource/poppins/latin-700.css';
import '@fontsource/poppins/latin-800.css';
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

// Ao trocar de página (ex.: "Finalizar compra" → página do Pix), começa do topo, onde ficam o QR Code e o código Pix.
// Sem isso o navegador mantém a rolagem da página anterior e o cliente cai no meio/fim da página do Pix.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
function ScrollToTop() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 15_000 } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ScrollToTop />
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
