-- Login do aluno na área de membros: e-mail da compra + senha.
-- A senha é criada automaticamente na primeira compra com entrega pela área de membros e vai no
-- e-mail e no WhatsApp de entrega. password_enc guarda a senha gerada (criptografada) só para reenviar
-- o mesmo acesso; quando o aluno troca a senha, ela é apagada e fica só o hash.
create table if not exists public.member_accounts (
  customer_id   uuid primary key references public.customers(id) on delete cascade,
  password_hash text not null,
  password_enc  text,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.member_accounts enable row level security;
drop policy if exists admin_all on public.member_accounts;
create policy admin_all on public.member_accounts for all to authenticated using (public.is_admin()) with check (public.is_admin());
