# Checkout Premium

Checkout próprio para produtos digitais com **PIX (Woovi e Efí Bank)**, painel administrativo, order bumps, cupons, entrega automática por e-mail, recuperação de PIX pendente e integração com o **PayTracking**.

- **Frontend:** React + TypeScript + Vite + Tailwind CSS + TanStack Query + React Hook Form + Zod + Lucide + Recharts
- **Backend:** Node.js + TypeScript + Express (serve a API e o site no mesmo processo)
- **Banco, login e arquivos:** Supabase (Postgres + Auth + Storage, com RLS)
- **Hospedagem:** Hostinger (Node.js Web App ou VPS), deploy a partir do GitHub

## Estrutura

```
apps/api/        API Node (pedidos, gateways, webhooks, painel, jobs)
  src/providers/ Woovi e Efí atrás da interface PixProvider (fácil adicionar outro)
  src/services/  pedidos, preço, e-mail, PayTracking, jobs, configurações
  src/routes/    public (checkout), webhooks, admin
apps/web/        React (checkout /c/:slug, pagamento /pedido/:token, painel /admin)
supabase/        migration SQL (tabelas, RLS, funções, buckets)
docs/            guia de deploy
```

## Funcionalidades

| Área | O que faz |
|---|---|
| Checkout | 2 colunas no desktop / 1 coluna no celular, inputs 16px (sem zoom no iPhone), máscaras de CPF/CNPJ/telefone, teclado certo em cada campo, order bumps com 1 clique, cupom, cronômetro opcional, garantia, depoimentos, cor/logo/banner/mockup por checkout |
| Pagamento | PIX Copia e Cola + QR Code, contagem regressiva, atualização automática, botão “Já paguei”, tela de sucesso com links de acesso |
| Segurança | Preço calculado **só no servidor**; webhook nunca aprova sozinho: o status é **reconsultado no gateway**; aprovação idempotente (função SQL atômica); segredos só em variáveis de ambiente; rate limit; Helmet/CSP; RLS em todas as tabelas; painel exige usuário na tabela `admins` |
| Entrega | E-mail automático com link de acesso ou arquivo privado (link assinado de 7 dias); reenvio pelo painel |
| Recuperação | E-mail para PIX não pago após X minutos (configurável), com dados já preenchidos; conciliação automática de pendentes e expiração |
| Rastreamento | UTMs, fbclid, fbp/fbc, src/sck; funil (visita → início → PIX → pago); Pixel da Meta com `event_id` igual ao enviado ao PayTracking (deduplicação) |
| PayTracking | Porta do `paytracking.php`: `sale.pending`, `sale.approved` (com bumps), `sale.canceled`, `sale.refunded`, HMAC-SHA256 + novas tentativas; teste de conexão no painel |
| Painel | Visão geral (faturamento, conversão, ticket, funil, mais vendidos), Produtos, Checkouts, Pedidos (filtros, detalhe, CSV), Clientes, Order bumps, Cupons, Integrações |

## Rodando localmente

```bash
SKIP_POSTINSTALL_BUILD=1 npm install   # o build automático é para o servidor
cp .env.example .env        # preencha com suas chaves
npm run dev:api             # API em http://localhost:3000
npm run dev:web             # site em http://localhost:5173 (proxy /api → 3000)
```

Testes e tipos: `npm test` e `npm run typecheck`.

## Deploy

Veja **[docs/DEPLOY.md](docs/DEPLOY.md)** (Supabase → GitHub → Hostinger → Woovi/Efí → PayTracking).
