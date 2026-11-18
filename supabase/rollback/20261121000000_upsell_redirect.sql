-- Desfaz 20261121000000_upsell_redirect.sql (o upsell volta a ser só popup).
alter table public.upsells drop constraint if exists upsells_page_fk;
alter table public.upsells drop column if exists page_id;
alter table public.upsell_pages drop constraint if exists upsell_pages_accent_check;
alter table public.upsell_pages drop constraint if exists upsell_pages_ratio_check;
alter table public.upsell_pages drop constraint if exists upsell_pages_decline_check;
alter table public.upsell_pages drop constraint if exists upsell_pages_pre_headline_check;
alter table public.upsell_pages drop constraint if exists upsell_pages_banner_check;
alter table public.upsell_pages drop column if exists accent_color;
alter table public.upsell_pages drop column if exists video_ratio;
alter table public.upsell_pages drop column if exists decline_text;
alter table public.upsell_pages drop column if exists pre_headline;
alter table public.upsell_pages drop column if exists banner_text;
