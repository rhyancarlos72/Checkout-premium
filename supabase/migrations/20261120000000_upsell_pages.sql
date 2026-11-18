-- Páginas de vendas de upsell (VSL + botão + pagamento na própria página). Idempotente.
-- * upsell_pages: uma página por oferta; cobra pelo checkout escolhido (ex.: o do Clube, com Pix Automático)
-- * vídeo comprimido no painel (720p + 480p para internet fraca) + capa, tudo no armazenamento "media"
-- * visitas e cliques ficam na tabela events (offer_view / offer_click); as vendas, no pedido (tracking.offer)
create table if not exists public.upsell_pages (
  id                   uuid primary key default gen_random_uuid(),
  slug                 text not null check (slug ~ '^[a-z0-9-]{3,60}$'),
  checkout_id          uuid not null references public.checkouts(id) on delete restrict,
  title                text not null check (length(title) between 2 and 120),       -- nome interno no painel
  headline             text not null check (length(headline) between 2 and 200),    -- título grande da página
  subheadline          text check (subheadline is null or length(subheadline) <= 400),
  video_url            text check (video_url is null or length(video_url) <= 600),  -- 720p
  video_sd_url         text check (video_sd_url is null or length(video_sd_url) <= 600), -- 480p (internet fraca)
  poster_url           text check (poster_url is null or length(poster_url) <= 600),
  cta_text             text not null default 'Quero entrar agora' check (length(cta_text) between 2 and 60),
  bullets              jsonb not null default '[]'::jsonb,                          -- até 4 frases curtas
  guarantee            text check (guarantee is null or length(guarantee) <= 200),
  button_delay_seconds integer not null default 0 check (button_delay_seconds between 0 and 3600),
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists upsell_pages_slug_idx on public.upsell_pages(slug);
create index if not exists upsell_pages_checkout_idx on public.upsell_pages(checkout_id);
alter table public.upsell_pages enable row level security; -- só o servidor (service role)

-- vendas por página: pedidos com tracking.offer = slug
create index if not exists orders_tracking_offer_idx on public.orders ((tracking->>'offer')) where tracking ? 'offer';

notify pgrst, 'reload schema';
