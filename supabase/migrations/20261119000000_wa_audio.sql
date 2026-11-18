-- Etapa H: áudios no WhatsApp (3º lembrete da recuperação e upsell do Clube). Idempotente.
-- * wa_audios: áudios enviados pelo painel (arquivo no armazenamento "media", nome aleatório)
-- * wa_queue: fila de envio com trava (um registro por envio; "step" = próximo passo da sequência)
-- * wa_optouts: quem respondeu SAIR / PARAR / CANCELAR (não recebe mais lembretes nem ofertas)
-- * wa_links: link rastreável /r/TOKEN (cliques e de qual áudio veio)
-- * orders.audio_id / orders.wa_link_token: a venda veio de qual áudio
create table if not exists public.wa_audios (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('recovery','upsell')),
  name       text not null check (length(name) between 2 and 80),
  file_url   text not null check (length(file_url) between 10 and 600),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists wa_audios_kind_idx on public.wa_audios(kind) where active;
alter table public.wa_audios enable row level security; -- só o servidor (service role)

create table if not exists public.wa_queue (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('recovery','upsell')),
  step        integer not null default 0,
  status      text not null default 'pending' check (status in ('pending','sending','done','skipped','failed','canceled')),
  customer_id uuid references public.customers(id) on delete cascade,
  order_id    uuid references public.orders(id) on delete cascade,
  phone       text not null,
  audio_id    uuid references public.wa_audios(id) on delete set null,
  instance    text,                          -- a conversa inteira sai do MESMO número
  link_token  text,
  run_at      timestamptz not null default now(),
  locked_at   timestamptz,
  attempts    integer not null default 0,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists wa_queue_order_kind_idx on public.wa_queue(order_id, kind) where order_id is not null;
create index if not exists wa_queue_due_idx on public.wa_queue(status, run_at);
create index if not exists wa_queue_phone_idx on public.wa_queue(phone, kind, created_at);
create index if not exists wa_queue_audio_idx on public.wa_queue(audio_id) where audio_id is not null;
alter table public.wa_queue enable row level security;

create table if not exists public.wa_optouts (
  phone      text primary key,
  word       text,
  created_at timestamptz not null default now()
);
alter table public.wa_optouts enable row level security;

create table if not exists public.wa_links (
  token         text primary key check (length(token) between 20 and 40),
  kind          text not null check (kind in ('recovery','upsell')),
  audio_id      uuid references public.wa_audios(id) on delete set null,
  customer_id   uuid references public.customers(id) on delete set null,
  order_id      uuid references public.orders(id) on delete set null,
  target_url    text not null,
  clicks        integer not null default 0,
  last_click_at timestamptz,
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists wa_links_audio_idx on public.wa_links(audio_id) where audio_id is not null;
alter table public.wa_links enable row level security;

alter table public.orders add column if not exists audio_id uuid;
alter table public.orders add column if not exists wa_link_token text;
do $$ begin
  alter table public.orders add constraint orders_audio_fk foreign key (audio_id) references public.wa_audios(id) on delete set null;
exception when duplicate_object then null; end $$;
create index if not exists orders_audio_idx on public.orders(audio_id) where audio_id is not null;

-- clique no link: soma 1 de forma atômica (sem ler e regravar)
create or replace function public.wa_link_click(p_token text)
returns setof public.wa_links language sql security definer set search_path = public as $$
  update public.wa_links set clicks = clicks + 1, last_click_at = now() where token = p_token returning *;
$$;
revoke all on function public.wa_link_click(text) from public, anon, authenticated;

-- avisa a API do Supabase que as tabelas novas existem
notify pgrst, 'reload schema';
