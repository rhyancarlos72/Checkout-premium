-- Desfaz 20261114000000_subscriptions.sql (as assinaturas e o histórico de mensalidades somem).
alter table public.orders drop constraint if exists orders_subscription_fk;
drop index if exists public.orders_subscription_idx;
drop table if exists public.subscriptions;
alter table public.orders drop column if exists rec_id;
alter table public.orders drop column if exists subscription_id;
alter table public.orders drop constraint if exists orders_kind_check;
alter table public.orders drop column if exists kind;
alter table public.order_items drop column if exists recurring;
alter table public.order_bumps drop constraint if exists order_bumps_recurring_price_check;
alter table public.order_bumps drop column if exists recurring_price_cents;
alter table public.order_bumps drop column if exists recurring;
