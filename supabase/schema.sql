-- Portal de aprovação de posts ThR — schema do Supabase (projeto portal-marketing)
-- Aplicar de novo é seguro (idempotente).

create table if not exists aprovadores (
  email text primary key,
  nome  text not null
);

create table if not exists posts (
  id            text primary key,            -- "2026-11-23-image" (mesmo id do schedule.json)
  mes           text not null,               -- "2026-11"
  titulo        text not null,               -- "23-11 Black Friday - Maquininha em Dobro"
  produto       text not null,               -- Caixa Eventos, Agro, Parques, Institucional...
  formato       text not null check (formato in ('estatico','carrossel','reels','story')),
  quando        timestamptz not null,
  legenda       text not null default '',
  midias        jsonb not null default '[]', -- caminhos no bucket "pecas" (prévia)
  capa          text,
  status        text not null default 'aguardando'
                check (status in ('aguardando','ajuste','corrigindo','atencao','aprovado','publicado','falhou','atrasado')),
  publicado     jsonb not null default '{}', -- {instagram: {...}, facebook: {...}} vindo do state.json
  versao        int  not null default 1,
  assinatura    text,                        -- tamanho/data dos arquivos (a ponte detecta peça alterada)
  aprovado_por  text,
  aprovado_em   timestamptz,
  atualizado_em timestamptz not null default now()
);
alter table posts add column if not exists assinatura text;
create index if not exists posts_quando on posts (quando);

create table if not exists comentarios (
  id        bigint generated always as identity primary key,
  post_id   text not null references posts(id) on delete cascade,
  autor     text not null,                   -- e-mail, ou "Claude" para o robô
  tipo      text not null check (tipo in ('ajuste','aprovacao','robo','nota')),
  texto     text not null default '',
  versao    int  not null default 1,
  criado_em timestamptz not null default now()
);
create index if not exists comentarios_post on comentarios (post_id, criado_em);

create or replace function eh_aprovador() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from aprovadores where email = lower(auth.jwt() ->> 'email'));
$$;

alter table aprovadores enable row level security;
alter table posts       enable row level security;
alter table comentarios enable row level security;

drop policy if exists ler_aprovadores on aprovadores;
create policy ler_aprovadores on aprovadores for select to authenticated using (eh_aprovador());
drop policy if exists ler_posts on posts;
create policy ler_posts on posts for select to authenticated using (eh_aprovador());
drop policy if exists ler_comentarios on comentarios;
create policy ler_comentarios on comentarios for select to authenticated using (eh_aprovador());
-- escrita só pelas funções abaixo (e pela ponte local, com a chave secreta)

create or replace function aprovar(p_id text) returns void
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  if not eh_aprovador() then raise exception 'sem permissão'; end if;
  update posts set status = 'aprovado', aprovado_por = lower(auth.jwt() ->> 'email'), aprovado_em = now(), atualizado_em = now()
   where id = p_id and status in ('aguardando','atencao') returning versao into v;
  if not found then raise exception 'este post não está esperando aprovação'; end if;
  insert into comentarios (post_id, autor, tipo, texto, versao) values (p_id, lower(auth.jwt() ->> 'email'), 'aprovacao', '', v);
end $$;

create or replace function pedir_ajuste(p_id text, p_texto text) returns void
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  if not eh_aprovador() then raise exception 'sem permissão'; end if;
  if coalesce(trim(p_texto), '') = '' then raise exception 'escreva o que precisa mudar'; end if;
  update posts set status = 'ajuste', atualizado_em = now()
   where id = p_id and status in ('aguardando','atencao','aprovado') returning versao into v;
  if not found then raise exception 'este post não pode mais ser ajustado'; end if;
  insert into comentarios (post_id, autor, tipo, texto, versao) values (p_id, lower(auth.jwt() ->> 'email'), 'ajuste', trim(p_texto), v);
end $$;

revoke all on function aprovar(text), pedir_ajuste(text, text) from public, anon;
grant execute on function aprovar(text), pedir_ajuste(text, text) to authenticated;

-- Quem pode aprovar: cadastrado direto no Supabase (tabela aprovadores), fora do repositório.

-- Peças (prévias) num bucket privado: só aprovadores logados leem
insert into storage.buckets (id, name, public) values ('pecas', 'pecas', false) on conflict (id) do nothing;
drop policy if exists ler_pecas on storage.objects;
create policy ler_pecas on storage.objects for select to authenticated using (bucket_id = 'pecas' and public.eh_aprovador());
