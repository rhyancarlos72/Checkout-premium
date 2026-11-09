-- REVERSÃO da migração 20261112000000_marketplace_base.sql
-- Use só se precisar voltar à versão de loja única. NÃO apaga pedidos, produtos nem clientes:
-- remove apenas as estruturas do marketplace (organizações, taxas, livro-razão, auditoria) e a coluna org_id.
-- ATENÇÃO: se já houver produtores com vendas, os dados deles ficariam misturados com os seus. Faça backup antes.
-- cupons: volta a regra "código único" só se não houver códigos repetidos entre produtores
drop index if exists public.coupons_org_code_uq;
do $$ begin
  if not exists (select code from public.coupons group by code having count(*) > 1) then
    alter table public.coupons add constraint coupons_code_key unique (code);
  else
    raise notice 'Há cupons com o mesmo código em produtores diferentes: a regra de código único não foi restaurada.';
  end if;
exception when duplicate_object or duplicate_table then null;
end $$;

do $$ declare t text; begin
  foreach t in array array['products','checkouts','order_bumps','checkout_bumps','coupons','orders','events','upsells','invoices',
                           'member_sections','member_modules','member_lessons'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists set_org_id on public.%I', t);
      execute format('alter table public.%I drop column if exists org_id', t);
    end if;
  end loop;
end $$;
alter table public.orders drop column if exists fee_policy_id, drop column if exists platform_fee_cents, drop column if exists fee_snapshot, drop column if exists split_status;
drop policy if exists producer_media_insert on storage.objects;
drop policy if exists producer_deliverables_all on storage.objects;
drop table if exists public.ledger_entries, public.fee_policies, public.audit_logs, public.org_members cascade;
drop function if exists public.tg_set_org_id, public.tg_ledger_immutable, public.my_org_ids;
drop function if exists public.platform_owner_org;
drop table if exists public.organizations cascade;
