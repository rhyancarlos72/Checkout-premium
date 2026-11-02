-- Equipe com papéis: "owner" (dono, acesso total) e "staff" (equipe, sem integrações).
-- O admin que já existe vira dono. Credenciais (tabela settings) ficam acessíveis só ao dono,
-- e só o dono pode adicionar/remover pessoas (evita que alguém da equipe se promova).
alter table public.admins add column if not exists role text not null default 'owner';
alter table public.admins add column if not exists email text;
do $$ begin
  alter table public.admins add constraint admins_role_check check (role in ('owner','staff'));
exception when duplicate_object then null; end $$;
update public.admins a set email = u.email from auth.users u where u.id = a.user_id and a.email is null;

create or replace function public.is_owner()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid() and role = 'owner');
$$;

-- admins: cada um lê a própria linha; só o dono gerencia
drop policy if exists admin_all on public.admins;
drop policy if exists admins_read on public.admins;
drop policy if exists admins_owner_write on public.admins;
create policy admins_read on public.admins for select to authenticated using (user_id = auth.uid() or public.is_owner());
create policy admins_owner_write on public.admins for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- credenciais (Woovi, Efí, Evolution, webhooks) e logs de integração: só o dono
do $$ declare t text; begin
  foreach t in array array['settings','integration_logs','webhook_logs'] loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;
