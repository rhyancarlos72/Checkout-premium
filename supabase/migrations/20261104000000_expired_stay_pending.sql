-- Pix vencido continua em "vendas pendentes": volta para pendente os pedidos marcados como expirados.
-- (Novos Pix vencidos já não mudam de status; o envio de sale.canceled fica registrado em events.type = 'pix_expired'.)
insert into public.events (order_id, checkout_id, type, data)
select o.id, o.checkout_id, 'pix_expired', '{}'::jsonb
from public.orders o
where o.status = 'expired'
  and not exists (select 1 from public.events e where e.order_id = o.id and e.type = 'pix_expired');

update public.orders set status = 'pending' where status = 'expired';

create index if not exists events_order_type_idx on public.events(order_id, type);
