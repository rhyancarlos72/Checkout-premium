-- Desfaz as abas da área de membros (as seções, módulos e aulas continuam).
alter table public.member_sections drop column if exists tab_id;
alter table public.products drop column if exists members_tabs;
notify pgrst, 'reload schema';
