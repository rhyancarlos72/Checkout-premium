-- Desfaz 20261124000000_upsell_page_design.sql (as páginas voltam ao modelo clássico).
alter table public.upsell_pages drop column if exists design;
