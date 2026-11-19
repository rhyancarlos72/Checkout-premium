-- Contatos importados (ex.: compradores do checkout antigo, por CSV) para o upsell por áudio. Idempotente.
-- * wa_contacts: separados de clientes/vendas (não mexem no faturamento nem no Pixel); um por WhatsApp
-- * wa_queue.contact_id / wa_links.contact_id: envio e link de um contato importado (que não tem pedido aqui)
create table if not exists public.wa_contacts (
  id                uuid primary key default gen_random_uuid(),
  phone             text not null check (phone ~ '^55[0-9]{10,11}$'),
  name              text check (name is null or length(name) <= 160),
  first_name        text check (first_name is null or length(first_name) <= 60),
  email             text check (email is null or length(email) <= 200),
  last_product      text check (last_product is null or length(last_product) <= 200),
  products          text check (products is null or length(products) <= 2000),
  last_purchase     date,
  orders_count      integer,
  total_spent_cents integer,
  list_name         text not null default 'Importados' check (length(list_name) between 1 and 80),
  status            text not null default 'pending' check (status in ('pending','queued','sent','skipped')),
  skip_reason       text,
  queued_at         timestamptz,
  created_at        timestamptz not null default now()
);
create unique index if not exists wa_contacts_phone_idx on public.wa_contacts(phone);
create index if not exists wa_contacts_next_idx on public.wa_contacts(status, last_purchase desc nulls last);
create index if not exists wa_contacts_email_idx on public.wa_contacts(lower(email)) where email is not null;
alter table public.wa_contacts enable row level security; -- só o servidor (service role)

alter table public.wa_queue add column if not exists contact_id uuid;
do $$ begin
  alter table public.wa_queue add constraint wa_queue_contact_fk foreign key (contact_id) references public.wa_contacts(id) on delete cascade;
exception when duplicate_object then null; end $$;
create unique index if not exists wa_queue_contact_kind_attempt_idx on public.wa_queue(contact_id, kind, coalesce(attempt, 0)) where contact_id is not null;

alter table public.wa_links add column if not exists contact_id uuid;
do $$ begin
  alter table public.wa_links add constraint wa_links_contact_fk foreign key (contact_id) references public.wa_contacts(id) on delete set null;
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
