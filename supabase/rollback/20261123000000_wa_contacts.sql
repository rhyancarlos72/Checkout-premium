-- Desfaz 20261123000000_wa_contacts.sql (os contatos importados e os envios para eles somem).
delete from public.wa_queue where contact_id is not null;
alter table public.wa_links drop constraint if exists wa_links_contact_fk;
alter table public.wa_links drop column if exists contact_id;
drop index if exists public.wa_queue_contact_kind_attempt_idx;
alter table public.wa_queue drop constraint if exists wa_queue_contact_fk;
alter table public.wa_queue drop column if exists contact_id;
drop table if exists public.wa_contacts;
