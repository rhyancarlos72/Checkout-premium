-- Área de membros (estilo Netflix): cada produto pode ter seções → módulos (capas verticais) → aulas.
-- Quem comprou o produto (inclusive como order bump) acessa; os outros cursos aparecem em "Cursos adicionais".
alter table public.products add column if not exists members_enabled boolean not null default false;
-- banner horizontal de destaque do curso na área de membros (opcional)
alter table public.products add column if not exists members_banner_url text;

create table if not exists public.member_sections (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  title       text not null,
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists member_sections_product_idx on public.member_sections(product_id, sort);

create table if not exists public.member_modules (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  section_id  uuid not null references public.member_sections(id) on delete cascade,
  title       text not null,
  subtitle    text,
  cover_url   text,
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists member_modules_section_idx on public.member_modules(section_id, sort);
create index if not exists member_modules_product_idx on public.member_modules(product_id);

create table if not exists public.member_lessons (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  module_id   uuid not null references public.member_modules(id) on delete cascade,
  title       text not null,
  description text,
  video_url   text,
  duration    text,
  attachments jsonb not null default '[]'::jsonb, -- [{ "name": "...", "url": "https://..." }]
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists member_lessons_module_idx on public.member_lessons(module_id, sort);

create table if not exists public.member_progress (
  customer_id  uuid not null references public.customers(id) on delete cascade,
  lesson_id    uuid not null references public.member_lessons(id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (customer_id, lesson_id)
);

-- código de 6 dígitos por e-mail para o aluno entrar (só o hash é guardado)
create table if not exists public.member_login_codes (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  code_hash   text not null,
  attempts    integer not null default 0,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists member_login_codes_email_idx on public.member_login_codes(lower(email), created_at desc);

do $$ declare t text; begin
  foreach t in array array['member_sections','member_modules','member_lessons','member_progress','member_login_codes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;
