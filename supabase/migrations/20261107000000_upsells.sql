-- Upsell pós-compra: 1 oferta por produto principal, exibida em popup quando o Pix é aprovado.
-- Aceitou → novo pedido só do produto oferecido (Pix próprio), ligado ao pedido original.
create table if not exists public.upsells (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null unique references public.products(id) on delete cascade, -- produto principal
  offer_product_id uuid not null references public.products(id) on delete cascade,        -- produto oferecido
  headline         text,
  title            text,
  description      text,
  image_url        text,
  price_cents      integer not null check (price_cents >= 1),
  compare_at_cents integer,
  cta_text         text,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.upsells enable row level security;
drop policy if exists admin_all on public.upsells;
create policy admin_all on public.upsells for all to authenticated using (public.is_admin()) with check (public.is_admin());
create index if not exists orders_upsell_of_idx on public.orders ((tracking->>'upsell_of'));
