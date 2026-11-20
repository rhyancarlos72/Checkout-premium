-- Abas da área de membros (ex.: "Atividades de alfabetização"): cada aba agrupa várias seções (fileiras estilo Netflix).
-- As abas ficam no próprio produto, em ordem: [{ "id": "a1b2c3", "title": "Alfabetização" }]. Idempotente.
alter table public.products add column if not exists members_tabs jsonb not null default '[]'::jsonb;
-- aba de cada seção (vazio = sem aba: aparece só em "Tudo"); apagar a aba não apaga a seção
alter table public.member_sections add column if not exists tab_id text;
notify pgrst, 'reload schema';
