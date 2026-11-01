-- Índices para as consultas mais usadas (opcional, recomendado). Pode rodar mais de uma vez.
create index if not exists orders_created_idx            on public.orders (created_at desc);
create index if not exists orders_status_expires_idx     on public.orders (status, expires_at);
create index if not exists orders_paid_at_idx            on public.orders (paid_at desc) where status = 'paid';
create index if not exists events_order_type_idx         on public.events (order_id, type);
create index if not exists events_type_created_idx       on public.events (type, created_at desc);
create index if not exists integration_logs_recent_idx   on public.integration_logs (integration, created_at desc);
create index if not exists webhook_logs_recent_idx       on public.webhook_logs (created_at desc);
create index if not exists checkouts_product_idx         on public.checkouts (product_id);
create index if not exists order_bumps_product_idx       on public.order_bumps (product_id);
