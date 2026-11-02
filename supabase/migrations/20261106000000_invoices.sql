-- Notas fiscais (Spedy): UMA nota por pedido (order_id único), somando produto + order bumps.
create table if not exists public.invoices (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null unique references public.orders(id) on delete cascade,
  type         text not null check (type in ('service','product')),
  status       text not null default 'processing' check (status in ('processing','issued','error','canceled')),
  provider_id  text,               -- id da nota na Spedy
  amount_cents integer not null,
  number       text,
  message      text,               -- motivo de erro / detalhe da prefeitura/SEFAZ
  response     jsonb not null default '{}'::jsonb,
  attempts     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists invoices_status_idx on public.invoices(status, updated_at);

alter table public.invoices enable row level security;
drop policy if exists admin_all on public.invoices;
create policy admin_all on public.invoices for all to authenticated using (public.is_admin()) with check (public.is_admin());
