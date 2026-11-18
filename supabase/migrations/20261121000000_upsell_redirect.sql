-- Upsell com redirecionamento para a página de vendas + visual VSL da página. Idempotente.
-- * upsell_pages: faixa do topo, texto acima do título, texto do "não quero", formato do vídeo e cor de destaque
-- * upsells.page_id: depois de pagar o produto, a pessoa vai para esta página de vendas (sem página = popup, como antes)
alter table public.upsell_pages add column if not exists banner_text text;
alter table public.upsell_pages add column if not exists pre_headline text;
alter table public.upsell_pages add column if not exists decline_text text not null default 'Não quero, obrigado';
alter table public.upsell_pages add column if not exists video_ratio text not null default '16:9';
alter table public.upsell_pages add column if not exists accent_color text not null default '#f97316';
do $$ begin
  alter table public.upsell_pages add constraint upsell_pages_banner_check check (banner_text is null or length(banner_text) <= 80);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.upsell_pages add constraint upsell_pages_pre_headline_check check (pre_headline is null or length(pre_headline) <= 120);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.upsell_pages add constraint upsell_pages_decline_check check (length(decline_text) between 2 and 80);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.upsell_pages add constraint upsell_pages_ratio_check check (video_ratio in ('16:9','9:16','1:1','4:5'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.upsell_pages add constraint upsell_pages_accent_check check (accent_color ~ '^#[0-9a-fA-F]{6}$');
exception when duplicate_object then null; end $$;

alter table public.upsells add column if not exists page_id uuid;
do $$ begin
  alter table public.upsells add constraint upsells_page_fk foreign key (page_id) references public.upsell_pages(id) on delete set null;
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
