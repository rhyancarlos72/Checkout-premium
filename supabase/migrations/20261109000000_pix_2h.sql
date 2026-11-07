-- Pix com validade de 2 horas: novos checkouts já nascem com 120 min e os atuais passam para 120 min.
alter table public.checkouts alter column pix_expires_minutes set default 120;
update public.checkouts set pix_expires_minutes = 120 where pix_expires_minutes < 120;
