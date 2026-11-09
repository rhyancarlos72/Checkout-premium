-- Cartão de crédito + split no gateway (Fases 6 e 7 do marketplace). Idempotente.
-- * orders.payment_method: 'pix' (padrão, pedidos antigos) ou 'card'
-- * orders.card_checkout_url: página segura do gateway onde o cliente digita o cartão (os dados nunca passam pelo nosso sistema)
-- * orders.split_info: o que foi enviado ao gateway para dividir a venda (parte do produtor x comissão da Prime)
alter table public.orders add column if not exists payment_method text not null default 'pix';
do $$ begin
  alter table public.orders add constraint orders_payment_method_check check (payment_method in ('pix','card'));
exception when duplicate_object then null; end $$;
alter table public.orders add column if not exists card_checkout_url text;
alter table public.orders add column if not exists split_info jsonb not null default '{}'::jsonb;
-- split no cartão: só quando o gateway confirmar o recurso para a conta (hoje a Woovi não documenta split de cartão)
alter table public.organizations add column if not exists card_split_enabled boolean not null default false;
