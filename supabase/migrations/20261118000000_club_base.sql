-- Clube de Atividades (etapa A): produto com área de membros RECORRENTE + planos com preço travado na assinatura. Idempotente.
-- Requer 20261114000000_subscriptions.sql e 20261115000000_product_subscriptions.sql.
-- * products.club: o produto é o Clube (área de membros por mensalidade; sem pagamento, o acesso pausa)
-- * club_plans: planos do Clube (ex.: Fundador R$ 9,90, Padrão R$ 19,90); on_sale = o plano que o checkout vende agora
-- * subscriptions: plano contratado (o preço fica em price_cents e não muda), método, início e cancelamento
alter table public.products add column if not exists club boolean not null default false;

create table if not exists public.club_plans (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  name        text not null check (length(name) between 2 and 60),
  price_cents integer not null check (price_cents >= 100),
  on_sale     boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index if not exists club_plans_one_on_sale on public.club_plans(product_id) where on_sale;
create index if not exists club_plans_product_idx on public.club_plans(product_id);
alter table public.club_plans enable row level security; -- só o servidor (service role)

alter table public.subscriptions add column if not exists plan_id uuid;
do $$ begin
  alter table public.subscriptions add constraint subscriptions_plan_fk foreign key (plan_id) references public.club_plans(id) on delete set null;
exception when duplicate_object then null; end $$;
alter table public.subscriptions add column if not exists plan_name text;
alter table public.subscriptions add column if not exists method text not null default 'pix_automatico';
do $$ begin
  alter table public.subscriptions add constraint subscriptions_method_check check (method in ('pix_automatico','cartao'));
exception when duplicate_object then null; end $$;
alter table public.subscriptions add column if not exists started_at timestamptz;
alter table public.subscriptions add column if not exists cancel_reason text;
alter table public.subscriptions add column if not exists canceled_by text;
do $$ begin
  alter table public.subscriptions add constraint subscriptions_canceled_by_check check (canceled_by is null or canceled_by in ('cliente','admin','banco'));
exception when duplicate_object then null; end $$;

-- avisa a API do Supabase que as colunas novas existem
notify pgrst, 'reload schema';
