-- Desfaz 20261119000000_wa_audio.sql (áudios, fila, descadastros e links somem).
drop function if exists public.wa_link_click(text);
drop index if exists public.orders_audio_idx;
alter table public.orders drop constraint if exists orders_audio_fk;
alter table public.orders drop column if exists wa_link_token;
alter table public.orders drop column if exists audio_id;
drop table if exists public.wa_links;
drop table if exists public.wa_optouts;
drop table if exists public.wa_queue;
drop table if exists public.wa_audios;
