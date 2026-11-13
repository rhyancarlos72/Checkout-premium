-- Desfaz 20261115000000_product_subscriptions.sql
alter table public.products drop constraint if exists products_recurring_price_check;
alter table public.products drop column if exists recurring_price_cents;
alter table public.products drop column if exists recurring;
