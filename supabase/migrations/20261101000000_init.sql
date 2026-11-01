-- =============================================================================
-- Checkout Premium — schema inicial (Supabase / PostgreSQL)
-- Execute no SQL Editor do Supabase ou via `supabase db push`.
-- O backend usa a SERVICE ROLE (ignora RLS). O painel usa o JWT do admin,
-- liberado pelas policies abaixo apenas para usuários na tabela `admins`.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- admins
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------- produtos
create table if not exists public.products (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  description    text,
  price_cents    integer not null check (price_cents >= 0),
  image_url      text,
  delivery_type  text not null default 'link' check (delivery_type in ('link','file','none')),
  delivery_url   text,               -- link de acesso ou caminho do arquivo no Storage
  delivery_note  text,               -- instruções extras enviadas no e-mail
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------- checkouts
create table if not exists public.checkouts (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9-]{3,60}$'),
  name         text not null,
  product_id   uuid not null references public.products(id) on delete restrict,
  provider     text not null default 'woovi' check (provider in ('woovi','efi')),
  price_cents  integer check (price_cents is null or price_cents >= 0), -- sobrescreve preço do produto
  theme        jsonb not null default '{}'::jsonb,
  fields       jsonb not null default '{"phone":true,"document":true}'::jsonb,
  tracking     jsonb not null default '{}'::jsonb,  -- meta pixel id, etc (dados públicos)
  pix_expires_minutes integer not null default 30 check (pix_expires_minutes between 5 and 1440),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- order bumps
create table if not exists public.order_bumps (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products(id) on delete cascade,
  title        text not null,
  description  text,
  price_cents  integer not null check (price_cents >= 0),
  compare_at_cents integer,          -- preço "de" riscado
  image_url    text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists public.checkout_bumps (
  checkout_id uuid not null references public.checkouts(id) on delete cascade,
  bump_id     uuid not null references public.order_bumps(id) on delete cascade,
  sort        integer not null default 0,
  primary key (checkout_id, bump_id)
);

-- ---------------------------------------------------------------- cupons
create table if not exists public.coupons (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9_-]{3,40}$'),
  type        text not null check (type in ('percent','fixed')),
  value       integer not null check (value > 0), -- percent: 1..100 | fixed: centavos
  max_uses    integer,
  used_count  integer not null default 0,
  min_cents   integer not null default 0,
  checkout_id uuid references public.checkouts(id) on delete cascade, -- null = todos
  expires_at  timestamptz,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint coupon_percent_range check (type <> 'percent' or value <= 100)
);

-- ---------------------------------------------------------------- clientes
create table if not exists public.customers (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  name       text not null,
  phone      text,
  document   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- pedidos
create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  number             bigserial unique,
  public_token       text not null unique default encode(gen_random_bytes(24), 'hex'),
  checkout_id        uuid references public.checkouts(id) on delete set null,
  customer_id        uuid references public.customers(id) on delete set null,
  status             text not null default 'pending'
                     check (status in ('pending','paid','expired','canceled','refunded','failed')),
  provider           text not null check (provider in ('woovi','efi')),
  provider_charge_id text,
  subtotal_cents     integer not null,
  discount_cents     integer not null default 0,
  total_cents        integer not null,
  coupon_id          uuid references public.coupons(id) on delete set null,
  pix_code           text,
  pix_qr_image       text,
  expires_at         timestamptz,
  paid_at            timestamptz,
  delivered_at       timestamptz,
  recovery_sent_at   timestamptz,
  tracking           jsonb not null default '{}'::jsonb,
  ip                 text,
  user_agent         text,
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists orders_provider_charge_uq on public.orders(provider, provider_charge_id);
create index if not exists orders_status_created_idx on public.orders(status, created_at desc);
create index if not exists orders_customer_idx on public.orders(customer_id);

create table if not exists public.order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  product_id  uuid references public.products(id) on delete set null,
  bump_id     uuid references public.order_bumps(id) on delete set null,
  kind        text not null check (kind in ('main','bump')),
  name        text not null,
  price_cents integer not null
);
create index if not exists order_items_order_idx on public.order_items(order_id);

-- ---------------------------------------------------------------- eventos / logs
create table if not exists public.events (
  id          bigserial primary key,
  checkout_id uuid references public.checkouts(id) on delete cascade,
  order_id    uuid references public.orders(id) on delete cascade,
  type        text not null, -- page_view, initiate_checkout, pix_generated, purchase, pix_copied...
  session_id  text,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists events_checkout_type_idx on public.events(checkout_id, type, created_at desc);

create table if not exists public.webhook_logs (
  id         bigserial primary key,
  provider   text not null,
  reference  text,
  payload    jsonb,
  status     text not null default 'received', -- received | processed | ignored | error
  error      text,
  created_at timestamptz not null default now()
);

create table if not exists public.integration_logs (
  id          bigserial primary key,
  integration text not null,  -- paytracking, email...
  order_id    uuid references public.orders(id) on delete cascade,
  event       text,
  ok          boolean not null,
  http_status integer,
  message     text,
  created_at  timestamptz not null default now()
);

-- configurações não-secretas editáveis no painel (segredos ficam nas variáveis de ambiente)
create table if not exists public.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- updated_at
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

do $$ declare t text; begin
  foreach t in array array['products','checkouts','customers','orders'] loop
    execute format('drop trigger if exists trg_touch_%1$s on public.%1$s', t);
    execute format('create trigger trg_touch_%1$s before update on public.%1$s for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- funções atômicas
-- Marca pedido como pago uma única vez (idempotente). Retorna true só na transição.
create or replace function public.mark_order_paid(p_order_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_coupon uuid;
begin
  update public.orders
     set status = 'paid', paid_at = now()
   where id = p_order_id and status in ('pending','expired')
  returning coupon_id into v_coupon;
  if not found then return false; end if;
  if v_coupon is not null then
    update public.coupons set used_count = used_count + 1 where id = v_coupon;
  end if;
  return true;
end; $$;

revoke all on function public.mark_order_paid(uuid) from public, anon, authenticated;

-- Dashboard: agregados por dia
create or replace function public.sales_by_day(p_from timestamptz, p_to timestamptz)
returns table(day date, orders bigint, paid bigint, revenue_cents bigint)
language sql stable security definer set search_path = public as $$
  select (created_at at time zone 'America/Sao_Paulo')::date as day,
         count(*) as orders,
         count(*) filter (where status = 'paid') as paid,
         coalesce(sum(total_cents) filter (where status = 'paid'), 0) as revenue_cents
    from public.orders
   where created_at >= p_from and created_at < p_to
   group by 1 order by 1;
$$;
revoke all on function public.sales_by_day(timestamptz, timestamptz) from public, anon;

-- ---------------------------------------------------------------- RLS
do $$ declare t text; begin
  foreach t in array array['admins','products','checkouts','order_bumps','checkout_bumps','coupons',
                           'customers','orders','order_items','events','webhook_logs',
                           'integration_logs','settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- Storage
insert into storage.buckets (id, name, public)
values ('media', 'media', true)       -- banners, mockups, imagens (leitura pública)
on conflict (id) do nothing;
insert into storage.buckets (id, name, public)
values ('deliverables', 'deliverables', false) -- arquivos entregues (link assinado temporário)
on conflict (id) do nothing;

drop policy if exists media_admin_write on storage.objects;
create policy media_admin_write on storage.objects for all to authenticated
  using (bucket_id in ('media','deliverables') and public.is_admin())
  with check (bucket_id in ('media','deliverables') and public.is_admin());

-- =============================================================================
-- Depois de criar seu usuário em Authentication > Users, torne-o admin:
--   insert into public.admins (user_id) select id from auth.users where email = 'SEU_EMAIL';
-- =============================================================================
