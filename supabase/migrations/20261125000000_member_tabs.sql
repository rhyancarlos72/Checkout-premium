-- Abas da área de membros (ex.: "Atividades de alfabetização"): cada aba agrupa várias seções (fileiras estilo Netflix).
-- As abas ficam no próprio produto, em ordem: [{ "id": "a1b2c3", "title": "Alfabetização" }]. Idempotente.
alter table public.products add column if not exists members_tabs jsonb not null default '[]'::jsonb;
-- aba de cada seção (vazio = sem aba: aparece só em "Tudo"); apagar a aba não apaga a seção
alter table public.member_sections add column if not exists tab_id text;
-- Se o SQL antigo (tabela member_tabs + tab_id uuid) já rodou: a aba passa a ser texto, sem a tabela separada
alter table public.member_sections drop constraint if exists member_sections_tab_id_fkey;
alter table public.member_sections alter column tab_id type text using tab_id::text;
drop table if exists public.member_tabs;
notify pgrst, 'reload schema';
