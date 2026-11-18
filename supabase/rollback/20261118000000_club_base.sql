-- Desfaz 20261118000000_club_base.sql (planos e dados de cancelamento somem; as assinaturas continuam)
alter table public.subscriptions drop constraint if exists subscriptions_canceled_by_check;
alter table public.subscriptions drop column if exists canceled_by;
alter table public.subscriptions drop column if exists cancel_reason;
alter table public.subscriptions drop column if exists started_at;
alter table public.subscriptions drop constraint if exists subscriptions_method_check;
alter table public.subscriptions drop column if exists method;
alter table public.subscriptions drop column if exists plan_name;
alter table public.subscriptions drop constraint if exists subscriptions_plan_fk;
alter table public.subscriptions drop column if exists plan_id;
drop table if exists public.club_plans;
alter table public.products drop column if exists club;
notify pgrst, 'reload schema';
