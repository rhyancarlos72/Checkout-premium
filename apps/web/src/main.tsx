import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { PageLoader } from './components/ui';
import './index.css';
import CheckoutPage from './pages/checkout/CheckoutPage';
import PaymentPage from './pages/checkout/PaymentPage';

// Painel carregado sob demanda → o checkout fica leve e rápido
const AdminApp = lazy(() => import('./pages/admin/AdminApp'));

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 15_000 } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/c/:slug" element={<CheckoutPage />} />
            <Route path="/pedido/:token" element={<PaymentPage />} />
            <Route path="/admin/*" element={<AdminApp />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
