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

-- ================= Planejar (fábrica de conteúdo) =================
-- pauta     = texto planejado esperando aprovação (ainda sem arte)
-- produzir  = texto aprovado; a fábrica está produzindo a peça (vira "aguardando" quando a arte chega)
alter table posts drop constraint if exists posts_status_check;
alter table posts add constraint posts_status_check check (status in
  ('pauta','produzir','aguardando','ajuste','corrigindo','atencao','aprovado','publicado','falhou','atrasado'));
alter table posts add column if not exists roteiro text;          -- briefing visual / roteiro do Reels
alter table posts add column if not exists cta text;
alter table posts add column if not exists planejamento_id bigint;

create table if not exists planejamentos (
  id           bigint generated always as identity primary key,
  criado_por   text not null,
  tipo         text not null check (tipo in ('mes','serie','avulso')),
  mes          text not null,              -- "2026-12"
  produtos     text[] not null default '{}',
  objetivo     text not null default '',
  datas        text not null default '',
  temas        text not null default '',
  observacoes  text not null default '',
  status       text not null default 'pedido' check (status in ('pedido','gerando','pronto','erro')),
  resumo       text,
  criado_em    timestamptz not null default now(),
  concluido_em timestamptz
);
alter table planejamentos enable row level security;
drop policy if exists ler_planejamentos on planejamentos;
create policy ler_planejamentos on planejamentos for select to authenticated using (eh_aprovador());

create or replace function criar_planejamento(p_tipo text, p_mes text, p_produtos text[], p_objetivo text,
                                              p_datas text, p_temas text, p_observacoes text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if not eh_aprovador() then raise exception 'sem permissão'; end if;
  if p_mes !~ '^\d{4}-\d{2}$' then raise exception 'mês inválido'; end if;
  insert into planejamentos (criado_por, tipo, mes, produtos, objetivo, datas, temas, observacoes)
  values (lower(auth.jwt() ->> 'email'), p_tipo, p_mes, coalesce(p_produtos, '{}'), coalesce(p_objetivo, ''),
          coalesce(p_datas, ''), coalesce(p_temas, ''), coalesce(p_observacoes, ''))
  returning id into v;
  return v;
end $$;
revoke all on function criar_planejamento(text, text, text[], text, text, text, text) from public, anon;
grant execute on function criar_planejamento(text, text, text[], text, text, text, text) to authenticated;

-- aprovar: texto sem arte vai para produção; peça com arte vai para a agenda
create or replace function aprovar(p_id text) returns void
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  if not eh_aprovador() then raise exception 'sem permissão'; end if;
  update posts set status = case when jsonb_array_length(midias) = 0 then 'produzir' else 'aprovado' end,
                   aprovado_por = lower(auth.jwt() ->> 'email'), aprovado_em = now(), atualizado_em = now()
   where id = p_id and status in ('pauta','aguardando','atencao') returning versao into v;
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
   where id = p_id and status in ('pauta','aguardando','atencao','aprovado') returning versao into v;
  if not found then raise exception 'este post não pode mais ser ajustado'; end if;
  insert into comentarios (post_id, autor, tipo, texto, versao) values (p_id, lower(auth.jwt() ->> 'email'), 'ajuste', trim(p_texto), v);
end $$;

-- ================= Estado da ponte (para o portal mostrar "próxima verificação") =================
create table if not exists ponte (
  chave text primary key,
  valor text not null,
  atualizado_em timestamptz not null default now()
);
alter table ponte enable row level security;
drop policy if exists ler_ponte on ponte;
create policy ler_ponte on ponte for select to authenticated using (eh_aprovador());

-- ================= Não aprovar (descartar o post) =================
-- reprovado = descartado pelo aprovador: sai da fila e da agenda; a ponte move os arquivos para Postar/<Mês>/Reprovados
alter table posts drop constraint if exists posts_status_check;
alter table posts add constraint posts_status_check check (status in
  ('pauta','produzir','aguardando','ajuste','corrigindo','atencao','aprovado','publicado','falhou','atrasado','reprovado'));
alter table comentarios drop constraint if exists comentarios_tipo_check;
alter table comentarios add constraint comentarios_tipo_check check (tipo in ('ajuste','aprovacao','robo','nota','reprovacao'));

create or replace function reprovar(p_id text, p_texto text) returns void
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  if not eh_aprovador() then raise exception 'sem permissão'; end if;
  update posts set status = 'reprovado', atualizado_em = now()
   where id = p_id and status in ('pauta','aguardando','atencao','aprovado','ajuste') returning versao into v;
  if not found then raise exception 'este post não pode mais ser descartado'; end if;
  insert into comentarios (post_id, autor, tipo, texto, versao) values (p_id, lower(auth.jwt() ->> 'email'), 'reprovacao', coalesce(trim(p_texto), ''), v);
end $$;
revoke all on function reprovar(text, text) from public, anon;
grant execute on function reprovar(text, text) to authenticated;

-- ================= Produtos e cores (11/11) =================
-- Lista de produtos do Planejar + cor de cada um (chip, calendário). Editável no portal (aba Planejar).
create table if not exists produtos (
  nome      text primary key,
  cor       text not null default '#A8A29E' check (cor ~ '^#[0-9A-Fa-f]{6}$'),
  descricao text not null default '',        -- o que é o produto: vai para o briefing da squad
  ordem     int  not null default 100,
  ativo     boolean not null default true
);
alter table produtos enable row level security;
drop policy if exists ler_produtos on produtos;
create policy ler_produtos on produtos for select to authenticated using (eh_aprovador());
insert into produtos (nome, cor, ordem) values
  ('Caixa Eventos', '#E87018', 1), ('Agro', '#2E9438', 2), ('Parques', '#2F7BEA', 3), ('Franquias', '#8B5CF6', 4),
  ('ERP', '#14B8A6', 5), ('Nota Fiscal', '#EAB308', 6), ('Food', '#E5484D', 7), ('Institucional', '#A8A29E', 8)
on conflict (nome) do nothing;

create or replace function salvar_produto(p_nome text, p_cor text, p_descricao text, p_antigo text default null) returns void
language plpgsql security definer set search_path = public as $$
declare n text := trim(p_nome);
begin
  if not eh_aprovador() then raise exception 'sem permissão'; end if;
  if coalesce(n, '') = '' then raise exception 'dê um nome ao produto'; end if;
  if p_cor !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'cor inválida'; end if;
  if p_antigo is not null and p_antigo <> n then
    if exists (select 1 from produtos where nome = n) then raise exception 'já existe um produto com esse nome'; end if;
    update produtos set nome = n where nome = p_antigo;
    update posts set produto = n where produto = p_antigo;
  end if;
  insert into produtos (nome, cor, descricao, ordem) values (n, p_cor, coalesce(p_descricao, ''),
         (select coalesce(max(ordem), 0) + 1 from produtos))
  on conflict (nome) do update set cor = excluded.cor, descricao = excluded.descricao, ativo = true;
end $$;

create or replace function remover_produto(p_nome text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not eh_aprovador() then raise exception 'sem permissão'; end if;
  update produtos set ativo = false where nome = p_nome;   -- some do Planejar; posts antigos mantêm a cor
end $$;
revoke all on function salvar_produto(text, text, text, text), remover_produto(text) from public, anon;
grant execute on function salvar_produto(text, text, text, text), remover_produto(text) to authenticated;

-- ================= Stories no plano + refazer/excluir plano (11/11) =================
alter table planejamentos add column if not exists stories text not null default 'nao';
alter table planejamentos add column if not exists stories_videos int not null default 0;
alter table planejamentos add column if not exists substitui bigint;   -- plano refeito: id do plano antigo
alter table planejamentos drop constraint if exists planejamentos_status_check;
alter table planejamentos add constraint planejamentos_status_check check (status in ('pedido','gerando','pronto','erro','descartado'));
alter table posts add column if not exists video boolean not null default false;  -- story em vídeo

-- Exclui os posts de um plano: texto sem arte é apagado; peça já feita (ou em produção) vira "reprovado"
-- (a ponte manda os arquivos para Reprovados). Aprovados e publicados ficam.
create or replace function descartar_planejamento(p_id bigint, p_motivo text default '') returns int
language plpgsql security definer set search_path = public as $$
declare st text; n int := 0; k int;
begin
  if not eh_aprovador() then raise exception 'sem permissão'; end if;
  select status into st from planejamentos where id = p_id;
  if st is null then raise exception 'plano não encontrado'; end if;
  if st = 'gerando' then raise exception 'o Claude está montando este plano agora; espere terminar para refazer'; end if;
  if st = 'descartado' then raise exception 'este plano já foi excluído'; end if;
  delete from posts where planejamento_id = p_id and jsonb_array_length(midias) = 0
     and status in ('pauta','ajuste','corrigindo','atencao');
  get diagnostics n = row_count;
  insert into comentarios (post_id, autor, tipo, texto, versao)
    select id, lower(auth.jwt() ->> 'email'), 'reprovacao', coalesce(nullif(trim(p_motivo), ''), 'Plano refeito.'), versao
      from posts where planejamento_id = p_id and status in ('pauta','produzir','aguardando','ajuste','corrigindo','atencao');
  update posts set status = 'reprovado', atualizado_em = now()
   where planejamento_id = p_id and status in ('pauta','produzir','aguardando','ajuste','corrigindo','atencao');
  get diagnostics k = row_count;
  update planejamentos set status = 'descartado' where id = p_id;
  return n + k;
end $$;
revoke all on function descartar_planejamento(bigint, text) from public, anon;
grant execute on function descartar_planejamento(bigint, text) to authenticated;

drop function if exists criar_planejamento(text, text, text[], text, text, text, text);
create or replace function criar_planejamento(p_tipo text, p_mes text, p_produtos text[], p_objetivo text,
                                              p_datas text, p_temas text, p_observacoes text,
                                              p_stories text default 'nao', p_stories_videos int default 0,
                                              p_substitui bigint default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if not eh_aprovador() then raise exception 'sem permissão'; end if;
  if p_mes !~ '^\d{4}-\d{2}$' then raise exception 'mês inválido'; end if;
  if coalesce(p_stories, 'nao') not in ('nao','diario','uteis') then raise exception 'opção de stories inválida'; end if;
  if p_substitui is not null then perform descartar_planejamento(p_substitui, 'Plano refeito.'); end if;
  insert into planejamentos (criado_por, tipo, mes, produtos, objetivo, datas, temas, observacoes, stories, stories_videos, substitui)
  values (lower(auth.jwt() ->> 'email'), p_tipo, p_mes, coalesce(p_produtos, '{}'), coalesce(p_objetivo, ''),
          coalesce(p_datas, ''), coalesce(p_temas, ''), coalesce(p_observacoes, ''), coalesce(p_stories, 'nao'),
          greatest(0, least(7, coalesce(p_stories_videos, 0))), p_substitui)
  returning id into v;
  return v;
end $$;
revoke all on function criar_planejamento(text, text, text[], text, text, text, text, text, int, bigint) from public, anon;
grant execute on function criar_planejamento(text, text, text[], text, text, text, text, text, int, bigint) to authenticated;
alter table planejamentos add column if not exists iniciado_em timestamptz;
alter table planejamentos add column if not exists progresso jsonb not null default '{}';
-- 12/11/2026: volume por dia no Planejar
alter table planejamentos add column if not exists feed_por_dia int not null default 1;
alter table planejamentos add column if not exists stories_por_dia int not null default 1;

drop function if exists criar_planejamento(text, text, text[], text, text, text, text, text, int, bigint);
create or replace function criar_planejamento(p_tipo text, p_mes text, p_produtos text[], p_objetivo text,
                                              p_datas text, p_temas text, p_observacoes text,
                                              p_stories text default 'nao', p_stories_videos int default 0,
                                              p_substitui bigint default null,
                                              p_feed_por_dia int default 1, p_stories_por_dia int default 1) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if not eh_aprovador() then raise exception 'sem permissão'; end if;
  if p_mes !~ '^\d{4}-\d{2}$' then raise exception 'mês inválido'; end if;
  if coalesce(p_stories, 'nao') not in ('nao','diario','uteis') then raise exception 'opção de stories inválida'; end if;
  if p_substitui is not null then perform descartar_planejamento(p_substitui, 'Plano refeito.'); end if;
  insert into planejamentos (criado_por, tipo, mes, produtos, objetivo, datas, temas, observacoes, stories, stories_videos,
                             substitui, feed_por_dia, stories_por_dia)
  values (lower(auth.jwt() ->> 'email'), p_tipo, p_mes, coalesce(p_produtos, '{}'), coalesce(p_objetivo, ''),
          coalesce(p_datas, ''), coalesce(p_temas, ''), coalesce(p_observacoes, ''), coalesce(p_stories, 'nao'),
          greatest(0, least(7, coalesce(p_stories_videos, 0))), p_substitui,
          greatest(1, least(3, coalesce(p_feed_por_dia, 1))), greatest(1, least(3, coalesce(p_stories_por_dia, 1))))
  returning id into v;
  return v;
end $$;
revoke all on function criar_planejamento(text, text, text[], text, text, text, text, text, int, bigint, int, int) from public, anon;
grant execute on function criar_planejamento(text, text, text[], text, text, text, text, text, int, bigint, int, int) to authenticated;
