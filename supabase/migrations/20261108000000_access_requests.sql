-- Pedidos de cadastro feitos na tela de login ("Criar cadastro").
-- Ninguém entra sozinho: o dono aprova em Configurações → Equipe e só então a pessoa recebe o link de senha.
create table if not exists public.access_requests (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text not null,
  phone      text,
  company    text,
  message    text,
  status     text not null default 'pending' check (status in ('pending','approved','rejected')),
  ip         text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create unique index if not exists access_requests_pending_email_uq on public.access_requests (lower(email)) where status = 'pending';
alter table public.access_requests enable row level security;
drop policy if exists owner_all on public.access_requests;
create policy owner_all on public.access_requests for all to authenticated using (public.is_owner()) with check (public.is_owner());
