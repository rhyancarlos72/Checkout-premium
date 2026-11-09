-- =============================================================================
-- MARKETPLACE — base multiusuário (Fase 2 + 3)
-- * Cria a organização PROPRIETÁRIA da plataforma (Prime) e coloca nela TODOS os dados atuais.
--   Nada é apagado; nenhum pedido antigo muda de valor.
-- * Cada produtor terá a própria organização; toda tabela de negócio ganha org_id.
-- * org_id é preenchido pelo próprio banco a partir do "pai" (produto, checkout, pedido) e o banco
--   recusa vínculos cruzados (ex.: checkout de um produtor apontando para produto de outro).
-- * Motor de taxas versionado + livro-razão imutável + auditoria.
-- Pode rodar mais de uma vez (idempotente). Reversão: supabase/rollback/20261112000000_marketplace_base.sql
-- =============================================================================

-- ---------------------------------------------------------------- organizações
create table if not exists public.organizations (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  legal_name        text,
  document          text,                 -- CPF/CNPJ do produtor
  phone             text,
  status            text not null default 'pending' check (status in ('pending','active','suspended')),
  is_platform_owner boolean not null default false,  -- SÓ por migração; nenhuma rota escreve este campo
  pix_provider      text check (pix_provider in ('woovi','efi')),  -- gateway do produtor (definido pelo Super Admin)
  recipient         jsonb not null default '{}'::jsonb,            -- dados do recebedor no gateway (split)
  split_enabled     boolean not null default false,                -- vendas do produtor só com split ativo
  terms_accepted_at timestamptz,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- no máximo UMA organização proprietária
create unique index if not exists organizations_single_owner on public.organizations ((is_platform_owner)) where is_platform_owner;

create table if not exists public.org_members (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null,
  role       text not null default 'owner' check (role in ('owner','staff')),
  email      text,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user_idx on public.org_members(user_id);

-- organização proprietária (Prime) com o nome da loja atual
insert into public.organizations (name, legal_name, status, is_platform_owner, split_enabled)
select coalesce(nullif((select value->'store'->>'name' from public.settings where key = 'general'), 'Minha Loja'), 'Prime Tecnologia e Negócios LTDA'),
       'Prime Tecnologia e Negócios LTDA', 'active', true, true
where not exists (select 1 from public.organizations where is_platform_owner);

create or replace function public.platform_owner_org()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.organizations where is_platform_owner limit 1;
$$;

-- equipe atual (tabela admins) = equipe da organização proprietária, com o MESMO user_id
insert into public.org_members (org_id, user_id, role, email)
select public.platform_owner_org(), a.user_id, case when coalesce(a.role, 'owner') = 'staff' then 'staff' else 'owner' end, a.email
from public.admins a
on conflict (org_id, user_id) do nothing;

-- ---------------------------------------------------------------- org_id nas tabelas de negócio
do $$ declare t text; begin
  foreach t in array array['products','checkouts','order_bumps','checkout_bumps','coupons','orders','events','upsells','invoices',
                           'member_sections','member_modules','member_lessons'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I add column if not exists org_id uuid references public.organizations(id)', t);
      execute format('update public.%I set org_id = public.platform_owner_org() where org_id is null', t);
      execute format('alter table public.%I alter column org_id set not null', t);
      execute format('create index if not exists %I on public.%I(org_id)', t || '_org_idx', t);
    end if;
  end loop;
end $$;

-- cupom: o código é único POR produtor (dois produtores podem ter "DEZ")
alter table public.coupons drop constraint if exists coupons_code_key;
create unique index if not exists coupons_org_code_uq on public.coupons(org_id, code);

-- ---------------------------------------------------------------- org_id automático + trava de vínculo cruzado
create or replace function public.tg_set_org_id()
returns trigger language plpgsql security definer set search_path = public as $$
declare parent uuid;
begin
  if tg_table_name in ('checkouts','order_bumps','upsells','member_sections','member_modules','member_lessons') then
    select org_id into parent from public.products where id = new.product_id;
  elsif tg_table_name = 'checkout_bumps' then
    select org_id into parent from public.checkouts where id = new.checkout_id;
    -- o order bump precisa ser do mesmo produtor do checkout
    if exists (select 1 from public.order_bumps b where b.id = new.bump_id and b.org_id is distinct from parent) then
      raise exception 'order bump de outro produtor' using errcode = '42501';
    end if;
  elsif tg_table_name = 'orders' then
    select org_id into parent from public.checkouts where id = new.checkout_id;
  elsif tg_table_name = 'invoices' then
    select org_id into parent from public.orders where id = new.order_id;
  elsif tg_table_name = 'events' then
    if new.order_id is not null then select org_id into parent from public.orders where id = new.order_id; end if;
    if parent is null and new.checkout_id is not null then select org_id into parent from public.checkouts where id = new.checkout_id; end if;
  end if;
  if parent is not null then
    if new.org_id is not null and new.org_id <> parent then
      raise exception 'vínculo entre produtores diferentes não é permitido (%)', tg_table_name using errcode = '42501';
    end if;
    new.org_id := parent;
  end if;
  if new.org_id is null then new.org_id := public.platform_owner_org(); end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['products','checkouts','order_bumps','checkout_bumps','coupons','orders','events','upsells','invoices',
                           'member_sections','member_modules','member_lessons'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists set_org_id on public.%I', t);
      execute format('create trigger set_org_id before insert or update on public.%I for each row execute function public.tg_set_org_id()', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- motor de taxas (versionado: só INSERT)
create table if not exists public.fee_policies (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid references public.organizations(id) on delete cascade, -- null = regra geral
  fixed_cents       integer not null default 0 check (fixed_cents >= 0),   -- por venda aprovada (produto principal)
  percent_bps       integer not null default 0 check (percent_bps between 0 and 10000), -- 100 = 1%
  bump_cents        integer not null default 0 check (bump_cents >= 0),    -- por order bump vendido
  gateway_fee_payer text not null default 'producer' check (gateway_fee_payer in ('producer','platform')),
  refund_policy     text not null default 'keep_fee' check (refund_policy in ('keep_fee','refund_fee')),
  note              text,
  created_by        uuid,
  created_at        timestamptz not null default now()
);
create index if not exists fee_policies_lookup_idx on public.fee_policies(org_id, created_at desc);
-- regra inicial: R$ 0,99 por venda + R$ 0,40 por order bump (produtores comuns)
insert into public.fee_policies (org_id, fixed_cents, percent_bps, bump_cents, note)
select null, 99, 0, 40, 'Regra inicial da plataforma'
where not exists (select 1 from public.fee_policies where org_id is null);

-- retrato das taxas no pedido (pedidos antigos ficam com 0 = vendas da Prime)
alter table public.orders add column if not exists fee_policy_id      uuid references public.fee_policies(id);
alter table public.orders add column if not exists platform_fee_cents integer not null default 0;
alter table public.orders add column if not exists fee_snapshot       jsonb not null default '{}'::jsonb;
alter table public.orders add column if not exists split_status       text not null default 'none' check (split_status in ('none','pending','done','failed'));

-- ---------------------------------------------------------------- livro-razão (imutável)
create table if not exists public.ledger_entries (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id),
  order_id     uuid references public.orders(id) on delete set null,
  type         text not null check (type in ('sale','platform_fee','gateway_fee','refund','fee_reversal','chargeback','payout','adjustment')),
  amount_cents integer not null,      -- + entra para o produtor / − sai
  data         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists ledger_org_idx on public.ledger_entries(org_id, created_at desc);
-- uma venda/comissão por pedido (webhook repetido nunca duplica)
create unique index if not exists ledger_once_per_order on public.ledger_entries(order_id, type) where type in ('sale','platform_fee','refund','fee_reversal','chargeback');

create or replace function public.tg_ledger_immutable()
returns trigger language plpgsql as $$
begin
  -- única exceção: pedido de teste excluído pelo dono → o lançamento fica, só perde o vínculo (order_id = null)
  if tg_op = 'UPDATE' and new.order_id is null and old.order_id is not null
     and new.org_id = old.org_id and new.type = old.type and new.amount_cents = old.amount_cents then
    return new;
  end if;
  raise exception 'lançamentos financeiros não podem ser alterados nem apagados';
end $$;
drop trigger if exists ledger_immutable on public.ledger_entries;
create trigger ledger_immutable before update or delete on public.ledger_entries for each row execute function public.tg_ledger_immutable();

-- ---------------------------------------------------------------- auditoria
create table if not exists public.audit_logs (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid,
  actor_email text,
  org_id     uuid,
  action     text not null,
  target     text,
  data       jsonb not null default '{}'::jsonb,
  ip         text,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on public.audit_logs(created_at desc);

-- pedido de cadastro de produtor (tela "Criar cadastro")
alter table public.access_requests add column if not exists document text;
alter table public.access_requests add column if not exists terms_accepted_at timestamptz;

-- ---------------------------------------------------------------- RLS (o servidor usa a service role; o navegador não lê estas tabelas)
do $$ declare t text; begin
  foreach t in array array['organizations','org_members','fee_policies','ledger_entries','audit_logs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- uploads dos produtores (Storage)
-- produtores enviam imagens (media) e arquivos (deliverables/<org_id>/...) só da própria organização
create or replace function public.my_org_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select m.org_id from public.org_members m join public.organizations o on o.id = m.org_id
  where m.user_id = auth.uid() and o.status = 'active';
$$;
drop policy if exists producer_media_insert on storage.objects;
create policy producer_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and exists (select 1 from public.my_org_ids()));
drop policy if exists producer_deliverables_all on storage.objects;
create policy producer_deliverables_all on storage.objects for all to authenticated
  using (bucket_id = 'deliverables' and (storage.foldername(name))[1] in (select id::text from public.my_org_ids()))
  with check (bucket_id = 'deliverables' and (storage.foldername(name))[1] in (select id::text from public.my_org_ids()));
