# Marketplace multiusuário com split: auditoria e plano

Este documento faz duas coisas. Primeiro, registra o que o sistema faz hoje, verificado no código. Depois, descreve como transformá-lo em marketplace sem mexer no visual do checkout e sem perder dados.

## 1. O que já existe (verificado no código)

| Área | Situação atual | Onde está |
|---|---|---|
| Stack | Express 5 + TypeScript (API), React/Vite/Tailwind (site), Supabase (Postgres + Auth + Storage), deploy único na Hostinger (`server.js`) | `apps/api`, `apps/web`, `server.js` |
| Autenticação do painel | Supabase Auth com 2FA opcional (AAL2). Tabela `admins` com papéis `owner` e `staff`. `ADMIN_EMAIL` fixa quem é dono. Cadastro só por aprovação (`access_requests`). | `middleware/auth.ts`, `routes/auth.ts`, migração `admin_roles` |
| Permissões | Rotas de integrações, gateways, WhatsApp, webhooks e equipe só para o dono (`OWNER_ONLY_PATH`). No banco, `settings`, `integration_logs` e `webhook_logs` só para o dono. | `routes/admin.ts`, migrações |
| Produtos / checkouts | Um checkout padrão criado por produto, com link `/checkout?produto_id=`. Editor visual com tema, banner, mockup e depoimentos. | `routes/admin.ts`, `CheckoutEditor.tsx`, `CheckoutView.tsx` |
| Order bumps, cupons, upsell | Funcionando. O preço é sempre calculado no servidor (`quote`). | `services/orders.ts`, `services/pricing.ts` |
| Pix | Woovi e Efí. QR gerado no servidor, validade configurável, sem cobrança duplicada para o mesmo valor, renovação em 1 toque. | `providers/woovi.ts`, `providers/efi.ts`, `services/orders.ts` |
| Cartão de crédito | **Não existe.** | — |
| Webhooks de pagamento | Woovi (segredo opcional) e Efí (`hmac` na URL). A aprovação sempre reconsulta o gateway, e `mark_order_paid` é atômica, então não aprova duas vezes. | `routes/webhooks.ts`, migração `init` |
| Reembolso | Só marcação manual (`/orders/:id/refund`), que avisa a PayTracking. Não consulta o gateway. | `routes/admin.ts` |
| Entrega | E-mail (SMTP), WhatsApp (Evolution), área de membros com login e senha. Tudo só depois de pago. | `services/email.ts`, `services/whatsapp.ts`, `services/members.ts` |
| Nota fiscal | Spedy, **no CNPJ da Prime**, uma por venda. | `services/invoices.ts` |
| Rastreamento | Pixel por checkout (`tracking.metaPixelId`). CAPI via PayTracking (webhooks globais). Deduplicação por `event_id`, `fbp`/`fbc`, UTMs. | `lib/tracking.ts`, `services/paytracking.ts`, `services/webhooks.ts` |
| Configurações | Tabela `settings` com chaves **globais**: `general`, `gateways`, `whatsapp`, `webhooks`, `invoices`, `members`. | `services/settings.ts`, etc. |
| Dados | `products`, `checkouts`, `order_bumps`, `checkout_bumps`, `coupons`, `customers` (e-mail **único global**), `orders`, `order_items`, `events`, `upsells`, `invoices`, `member_*`, logs. **Nenhuma tabela tem dono ou organização.** | `supabase/migrations` |
| Testes | 118 testes de API e fluxo completo, mais 5 testes em navegador real (checkout, Pix, área de membros, painel). | `apps/api/src/**/*.test.ts` |

## 2. O que falta para virar marketplace

1. **Isolamento por produtor.** Hoje é tudo de uma loja só. Toda tabela de negócio precisa de `org_id`, e toda consulta do painel precisa filtrar por ele.
2. **Papel de Super Admin.** A sua conta `owner` atual vira `super_admin` da plataforma, mantendo o mesmo `user_id`. Os produtores ganham uma organização própria.
3. **Motor de taxas.** Política versionada, com isenção da organização proprietária gravada no servidor e um "retrato" das taxas em cada pedido.
4. **Livro-razão financeiro.** Lançamentos imutáveis de venda, comissão, tarifa, reembolso, chargeback e repasse. Conciliação com o gateway.
5. **Split no gateway.** Recebedor de cada produtor, cobrança com divisão e registro do que foi liquidado.
6. **Cartão de crédito.** Não existe hoje. Precisa de tokenização no navegador (os dados do cartão nunca passam pelo servidor), parcelas e webhooks.
7. **Configurações por produtor.** Pixel, PayTracking e webhooks por organização. Gateways, taxas e credenciais só no Super Admin.
8. **Painéis.** Financeiro do produtor, e gestão de produtores, taxas, conciliação e auditoria no Super Admin.

## 3. Pontos que precisam de confirmação externa (não dá para presumir)

- **Split na Woovi e na Efí.** Os sites de documentação (`developers.woovi.com` e `dev.efipay.com.br`) estão bloqueados pela rede deste ambiente, então ainda não confirmei os campos, os limites e quem pode ser recebedor. Pontos a validar:
  - Se o recebedor precisa ter conta no próprio gateway.
  - Se o split é percentual ou valor fixo.
  - Se o recurso precisa ser habilitado pelo gerente da conta.
  - Se o split vale para cartão.

  A Fase 6 só começa depois dessa leitura e de um teste em homologação.
- **Habilitação comercial.** Split e marketplace normalmente exigem contrato ou habilitação específica no gateway e verificação cadastral (KYC) de cada produtor. Precisa confirmar com o gerente da Woovi e da Efí.
- **Regulatório e fiscal.** Intermediar pagamentos de terceiros tem regras do Banco Central e obrigações fiscais. Recomendo validar com contador ou advogado. A Spedy hoje emite no **CNPJ da Prime** e não pode emitir nota das vendas dos produtores. Para eles, o certo é a Prime emitir nota só da **comissão** dela.

## 4. Arquitetura proposta

- **`organizations`** (nova). A organização proprietária é criada na migração com todos os dados atuais, preservando `user_id`, pedidos, produtos e configurações. O vínculo é feito pelo **`user_id` imutável** do dono atual, conferido com o e-mail, nunca só pelo e-mail.
- **`org_members`**: quem pertence a qual organização, com papel `owner` ou `staff`. A tabela `admins` continua e vira a lista de Super Admins.
- **`org_id`** em `products`, `checkouts`, `order_bumps`, `coupons`, `customers`, `orders`, `events`, `upsells`, `member_*` e `invoices`. Os dados atuais recebem o `org_id` da organização proprietária (preenchimento retroativo; nada é apagado).
- **`customers`**: o e-mail único global passa a ser único por organização (`unique(org_id, email)`), para dois produtores poderem ter o mesmo comprador.
- **`fee_policies`**: versionada, só inserção. Guarda taxa fixa, percentual, taxa por bump, por método e quem absorve a tarifa do gateway. Pode valer para todos ou para um produtor específico.
- **Pedido**: ganha `seller_org_id`, `fee_policy_id`, `platform_fee_cents`, `bump_fee_cents`, `gateway_fee_cents` e `split_status`, gravados **no momento da compra**. Pedidos antigos não mudam.
- **Isenção do proprietário**: `organizations.is_platform_owner = true`, definida só por migração. Nenhuma rota escreve esse campo. O cálculo de taxa devolve 0 para essa organização **no servidor**.
- **Financeiro**:
  - `ledger_entries` só aceita inserção, com bloqueio de UPDATE e DELETE por trigger.
  - `payouts` e `settlements` registram repasses e liquidações.
  - `webhook_events` tem identificador único, o que impede processar o mesmo aviso duas vezes (*replay*).
  - `audit_logs` registra as ações administrativas.
- **Configurações**: `settings` ganha `org_id`. Gateways, taxas e credenciais continuam só no nível global do Super Admin. WhatsApp, webhooks e PayTracking passam a valer por organização.
- **Checkout público**: **o visual não muda.** O servidor descobre a organização pelo checkout e aplica gateway, split e pixel daquela organização. O único acréscimo visual possível é o seletor "Pix / Cartão" na Fase 7, no mesmo padrão do botão Pix que já existe.

## 5. Fases e arquivos

### Fase 2 + 3: base multiusuário e conta proprietária (sem mudança visual no checkout)
- Novos: `supabase/migrations/20261112000000_marketplace_base.sql` (organizations, org_members, org_id + retroativo, índices, RLS), `apps/api/src/middleware/tenant.ts` (resolve a organização do usuário e impede acesso cruzado), `apps/api/src/services/fees.ts` (motor de taxas), `apps/api/src/services/ledger.ts`, `apps/api/src/services/audit.ts`.
- Alterados: `apps/api/src/middleware/auth.ts` (papéis `super_admin`, owner, staff), `apps/api/src/routes/admin.ts` (todas as consultas filtradas por `org_id`), `apps/api/src/routes/adminMembers.ts`, `apps/api/src/services/orders.ts` (`seller_org_id` e retrato das taxas), `apps/api/src/services/settings.ts`, `apps/api/src/services/webhooks.ts`, `apps/api/src/services/paytracking.ts`, `apps/api/src/services/members.ts`, `apps/api/src/routes/public.ts`, `apps/api/src/routes/auth.ts` (cadastro de produtor), `apps/api/src/test/fakeSupabase.ts`.
- Testes novos: isolamento entre produtores, isenção do proprietário (R$ 0,00 em todos os cenários), R$ 0,99 + R$ 0,40 por bump para produtor comum, checkouts antigos acessíveis.

### Fase 4 e 5: painéis
- Novos: `apps/web/src/pages/admin/FinancePage.tsx` (produtor), `apps/web/src/pages/admin/PlatformPage.tsx` (Super Admin: produtores, taxas, conciliação, auditoria), `apps/web/src/pages/admin/SignupPage.tsx` (no padrão visual do login).
- Alterados: `AdminApp.tsx` (menu conforme o papel), `LoginPage.tsx` (link de cadastro), `IntegrationsPage.tsx` (gateways só para o Super Admin), `DashboardPage.tsx` (comissões e valor líquido).

### Fase 6: split Pix
- Alterados: `apps/api/src/providers/woovi.ts`, `apps/api/src/providers/efi.ts`, `apps/api/src/providers/types.ts`, `apps/api/src/routes/webhooks.ts` (eventos idempotentes), `apps/api/src/services/jobs.ts` (conciliação).
- Novo: `apps/api/src/services/recipients.ts` (cadastro e validação do recebedor do produtor).
- **Depende de** confirmar a documentação e a habilitação do split no gateway.

### Fase 7: cartão de crédito
- Novos: `apps/api/src/providers/efiCard.ts` e/ou `wooviCard.ts`, um componente de cartão no checkout (no padrão visual atual) e webhooks de cartão.
- **Depende de** a conta estar habilitada para cartão e para split de cartão. Sem o split de cartão aprovado, cartão fica disponível só para as vendas da Prime.

### Fase 8: financeiro completo
- Livro-razão, reembolso pelo gateway (Pix devolução), chargeback, repasses, conciliação diária e relatórios por período.

### Fase 9 e 10: homologação e lançamento
- Os 30 testes da seção 20, testes em homologação dos gateways e liberação para produtores convidados primeiro.

## 6. Segurança da migração

- Migrações incrementais e reversíveis (cada uma com SQL de reversão em `supabase/rollback/`).
- **Nada é apagado.** As colunas novas aceitam vazio durante a transição e só ficam obrigatórias depois do retroativo conferido.
- Backup antes de cada fase: Supabase → Database → Backups, ou `pg_dump`.
- Cada fase é validada com a suíte completa (API + navegador) antes de seguir.

## 7. Andamento

| Fase | Situação |
|---|---|
| 1. Auditoria | ✅ Este documento |
| 2 + 3. Base multiusuário e conta proprietária | ✅ Feito: organizações, `org_id` em todas as tabelas de negócio (preenchido e travado pelo banco), filtro automático em todas as rotas do painel, Super Admin = o dono atual (mesmo `user_id`), isenção da Prime no servidor, motor de taxas versionado (R$ 0,99 + R$ 0,40/bump), livro-razão imutável, auditoria, configurações por produtor (loja, PayTracking, Spedy própria, vitrine), WhatsApp só para a Prime |
| 4 + 5. Painéis | ✅ Feito: Financeiro (produtor e Prime), Plataforma (produtores, pedidos de cadastro, taxas, financeiro global, auditoria), cadastro com CPF/CNPJ e aceite dos termos |
| 6. Split Pix | ⏳ Próxima: depende de ler a documentação (sites bloqueados neste ambiente) e da habilitação na Woovi/Efí. Até lá, produtor só vende quando o Super Admin libera, e o pedido fica marcado para o split. |
| 7. Cartão | ⏳ Depois do Pix (decisão do dono) |
| 8. Financeiro completo | Parcial: livro-razão, comissão, reembolso e chargeback; repasses e conciliação diária com o gateway entram junto com o split |

**Ordem de implantação:** 1) backup do banco; 2) rodar `supabase/migrations/20261112000000_marketplace_base.sql`; 3) redeploy. O código novo funciona também sem o SQL (modo loja única, igual a antes), então a ordem não quebra a loja.
