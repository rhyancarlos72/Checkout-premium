-- Modelos da página de vendas upsell (ex.: "Destaque": faixa animada, foto de fundo, logo, preço em destaque). Idempotente.
-- design = { template: 'classic' | 'spotlight', bg_url, logo_url, marquee, price_note }. Vazio = modelo clássico (o atual).
alter table public.upsell_pages add column if not exists design jsonb not null default '{}'::jsonb;
notify pgrst, 'reload schema';
