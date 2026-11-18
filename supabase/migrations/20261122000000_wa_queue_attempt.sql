-- Recuperação com áudio em mais de um lembrete (ex.: 1º e 3º): a fila guarda de qual lembrete é o envio. Idempotente.
-- Antes: um envio de recuperação por pedido. Agora: um por pedido + lembrete (o upsell segue um por pedido).
alter table public.wa_queue add column if not exists attempt integer;
create unique index if not exists wa_queue_order_kind_attempt_idx on public.wa_queue(order_id, kind, coalesce(attempt, 0)) where order_id is not null;
drop index if exists public.wa_queue_order_kind_idx;
notify pgrst, 'reload schema';
