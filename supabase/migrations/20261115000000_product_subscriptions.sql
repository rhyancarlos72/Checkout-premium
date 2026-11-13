-- Assinatura mensal (Pix Automático) escolhida no PRODUTO: quando ele é oferecido como order bump,
-- o bump vira assinatura. Idempotente. Requer 20261114000000_subscriptions.sql.
-- * products.recurring: o produto é vendido como assinatura mensal quando oferecido como order bump
-- * products.recurring_price_cents: valor de cada mês (vazio = o preço da oferta no order bump)
alter table public.products add column if not exists recurring boolean not null default false;
alter table public.products add column if not exists recurring_price_cents integer;
do $$ begin
  alter table public.products add constraint products_recurring_price_check check (recurring_price_cents is null or recurring_price_cents >= 100);
exception when duplicate_object then null; end $$;

-- avisa a API do Supabase que as colunas novas existem (sem isso ela pode demorar alguns minutos para enxergar)
notify pgrst, 'reload schema';
