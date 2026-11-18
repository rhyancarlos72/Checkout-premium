-- Desfaz 20261120000000_upsell_pages.sql (as páginas somem; pedidos e eventos ficam).
drop index if exists public.orders_tracking_offer_idx;
drop table if exists public.upsell_pages;
