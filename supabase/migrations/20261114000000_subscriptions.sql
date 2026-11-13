-- Assinatura mensal por Pix Automático em order bumps escolhidos. Idempotente.
-- * order_bumps.recurring: o bump é uma assinatura mensal (só o produto marcado no painel)
-- * order_bumps.recurring_price_cents: valor de cada mês (vazio = o mesmo preço do bump)
-- * order_items.recurring: o item comprado é assinatura → o acesso vale enquanto a assinatura estiver em dia
-- * orders.kind: 'sale' (venda normal) ou 'renewal' (mensalidade); orders.subscription_id: assinatura da mensalidade
-- * subscriptions: uma por pedido com bump de assinatura; guarda a autorização do Pix Automático (idRec),
--   a cobrança do mês (txid), até quando o acesso está pago e o status
alter table public.order_bumps add column if not exists recurring boolean not null default false;
alter table public.order_bumps add column if not exists recurring_price_cents integer;
do $$ begin
  alter table public.order_bumps add constraint order_bumps_recurring_price_check check (recurring_price_cents is null or recurring_price_cents >= 100);
exception when duplicate_object then null; end $$;

alter table public.order_items add column if not exists recurring boolean not null default false;

alter table public.orders add column if not exists kind text not null default 'sale';
do $$ begin
  alter table public.orders add constraint orders_kind_check check (kind in ('sale','renewal'));
exception when duplicate_object then null; end $$;
alter table public.orders add column if not exists subscription_id uuid;
alter table public.orders add column if not exists rec_id text;

create table if not exists public.subscriptions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid,
  customer_id      uuid not null references public.customers(id) on delete cascade,
  origin_order_id  uuid references public.orders(id) on delete set null,
  status           text not null default 'pending' check (status in ('pending','active','past_due','expired','canceled')),
  price_cents      integer not null check (price_cents >= 100),
  product_ids      uuid[] not null default '{}',
  items            jsonb not null default '[]'::jsonb,       -- [{ product_id, bump_id, name, price_cents }]
  provider         text not null default 'efi',
  rec_id           text,                                     -- autorização do Pix Automático (idRec)
  rec_status       text,                                     -- CRIADA / APROVADA / REJEITADA / EXPIRADA / CANCELADA
  paid_until       timestamptz,                              -- acesso pago até (tolerância de 3 dias depois)
  next_due         date,                                     -- vencimento da próxima mensalidade
  cobr_txid        text,                                     -- cobrança automática do mês em andamento
  cobr_status      text,
  renewal_order_id uuid,                                     -- Pix de renovação enviado (sem autorização)
  notices          jsonb not null default '{}'::jsonb,       -- avisos já enviados (não repete)
  canceled_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists subscriptions_customer_idx on public.subscriptions(customer_id);
create index if not exists subscriptions_status_idx on public.subscriptions(status, paid_until);
create unique index if not exists subscriptions_rec_idx on public.subscriptions(rec_id) where rec_id is not null;
create unique index if not exists subscriptions_origin_idx on public.subscriptions(origin_order_id) where origin_order_id is not null;
do $$ begin
  if to_regclass('public.organizations') is not null then
    alter table public.subscriptions add constraint subscriptions_org_fk foreign key (org_id) references public.organizations(id);
  end if;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.orders add constraint orders_subscription_fk foreign key (subscription_id) references public.subscriptions(id) on delete set null;
exception when duplicate_object then null; end $$;
create index if not exists orders_subscription_idx on public.orders(subscription_id) where subscription_id is not null;

-- só o servidor (service role) lê e grava assinaturas
alter table public.subscriptions enable row level security;

-- avisa a API do Supabase que as colunas novas existem (sem isso ela pode demorar alguns minutos para enxergar)
notify pgrst, 'reload schema';
