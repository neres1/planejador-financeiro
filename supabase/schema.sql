-- Planejador Financeiro — schema do Supabase.
-- Todo conteúdo financeiro chega aqui já criptografado pelo app (coluna `data`);
-- o banco só guarda texto ilegível + o mínimo para sincronizar.
-- Cada usuário só enxerga as próprias linhas (Row Level Security).

-- Cofre: a chave de dados do usuário, embrulhada pela senha e pela chave de recuperação.
create table if not exists public.vault (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  kdf_iter integer not null,
  salt text not null,
  rec_salt text not null,
  wrapped_key_pw text not null,
  wrapped_key_rec text not null,
  updated_at timestamptz not null default now()
);

-- Itens criptografados (lançamentos e categorias). `updated_at` é o relógio do app
-- (vence a alteração mais recente); `server_updated_at` serve para baixar só o que mudou.
create table if not exists public.items (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  data text,
  deleted boolean not null default false,
  updated_at timestamptz not null,
  server_updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists items_sync_idx on public.items (user_id, server_updated_at);

alter table public.vault enable row level security;
alter table public.items enable row level security;

drop policy if exists "vault: dono" on public.vault;
create policy "vault: dono" on public.vault for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "items: dono" on public.items;
create policy "items: dono" on public.items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Visitantes sem login não acessam nada.
revoke all on public.vault, public.items from anon;
grant select, insert, update, delete on public.vault, public.items to authenticated;

-- Envio em lote: grava cada item só se ele for mais novo que o que já está no banco.
create or replace function public.push_items(rows jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.items as t (user_id, id, data, deleted, updated_at, server_updated_at)
  select (select auth.uid()), r->>'id', r->>'data', coalesce((r->>'deleted')::boolean, false), (r->>'updated_at')::timestamptz, now()
  from jsonb_array_elements(rows) as r
  on conflict (user_id, id) do update
    set data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at, server_updated_at = now()
    where t.updated_at < excluded.updated_at;
$$;
revoke execute on function public.push_items(jsonb) from public, anon;
grant execute on function public.push_items(jsonb) to authenticated;
