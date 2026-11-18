-- Desfaz 20261122000000_wa_queue_attempt.sql (volta a um envio de recuperação por pedido).
delete from public.wa_queue a using public.wa_queue b where a.order_id = b.order_id and a.kind = b.kind and a.ctid > b.ctid;
create unique index if not exists wa_queue_order_kind_idx on public.wa_queue(order_id, kind) where order_id is not null;
drop index if exists public.wa_queue_order_kind_attempt_idx;
alter table public.wa_queue drop column if exists attempt;
