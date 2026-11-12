/* Portal de Marketing ThR — aprovação de posts.
   Dados no Supabase (posts, comentarios); a ponte local (automacao-redes/portal_sync.py) move as peças
   aprovadas para Postar/<Mês>/Aprovados e o publicador posta no horário. */
const { supabaseUrl, supabaseKey } = window.PORTAL_CONFIG;
const sb = supabase.createClient(supabaseUrl, supabaseKey);
const TZ = 'America/Sao_Paulo';

const STATUS = {
  pauta:      { rotulo: 'Texto para aprovar',  cor: 'var(--st-pauta)' },
  produzir:   { rotulo: 'Em produção',         cor: 'var(--st-producao)' },
  aguardando: { rotulo: 'Esperando aprovação', cor: 'var(--st-aguardando)' },
  atencao:    { rotulo: 'Precisa de atenção',  cor: 'var(--st-atencao)' },
  ajuste:     { rotulo: 'Ajuste pedido',       cor: 'var(--st-ajuste)' },
  corrigindo: { rotulo: 'Claude corrigindo',   cor: 'var(--st-ajuste)' },
  aprovado:   { rotulo: 'Agendado',            cor: 'var(--st-agendado)' },
  publicado:  { rotulo: 'Publicado',           cor: 'var(--st-publicado)' },
  falhou:     { rotulo: 'Falhou',              cor: 'var(--st-atencao)' },
  atrasado:   { rotulo: 'Não publicado',       cor: 'var(--st-atencao)' },
  reprovado:  { rotulo: 'Não aprovado',        cor: 'var(--faint)' },
};
const LEGENDA_CAL = ['pauta', 'produzir', 'aguardando', 'ajuste', 'atencao', 'aprovado', 'publicado'];

const ICONE = {
  aprovar: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  calendario: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  planejar: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
  painel: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  estatico: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  carrossel: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  reels: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
  story: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
};
const FORMATO = { estatico: 'Estático', carrossel: 'Carrossel', reels: 'Reels', story: 'Story' };
const ABAS = [['aprovar', 'Aprovar'], ['calendario', 'Calendário'], ['planejar', 'Planejar'], ['painel', 'Painel']];

const FILA = ['pauta', 'aguardando', 'atencao'];
const st = {
  sessao: null, aba: 'aprovar', histAberto: {}, posts: [], coments: {}, nomes: {}, urls: {}, urlsEm: 0,
  mes: mesDe(new Date()), produto: null, planos: [], produtos: [], refazer: null, excluirPlano: null, planoAberto: null, editProduto: null, ultimaRodada: null, formAberto: false, enviando: false, slide: {}, ajusteAberto: null, descartarAberto: null, modal: null, carregado: false,
};

/* ---------- utilidades ---------- */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function icone(nome, tam = 16) { return `<svg width="${tam}" height="${tam}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICONE[nome]}</svg>`; }
function mesDe(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(d); }
function diaDe(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
function fmt(iso, opts) { return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...opts }).format(new Date(iso)); }
function quando(iso) {
  const sem = fmt(iso, { weekday: 'short' }).replace('.', '');
  return `${sem} ${fmt(iso, { day: '2-digit', month: '2-digit' })} · ${fmt(iso, { hour: '2-digit', minute: '2-digit' }).replace(':00', 'h').replace(':', 'h')}`;
}
function pilula(status) { const s = STATUS[status] || { rotulo: status, cor: 'var(--faint)' }; return `<span class="pilula" style="--c:${s.cor}">${s.rotulo}</span>`; }
function cortar(t, n) { t = t.trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; }
function nome(p) {
  const semData = p.titulo.replace(/^\d{2}-\d{2} /, '');
  const partes = semData.split(' - ');
  const resto = partes.slice(1).join(' - ') || partes[0];
  if (/^(carrossel|estático)/i.test(resto)) {
    const linha = (p.legenda || '').split('\n').find(l => l.trim());
    if (linha) return cortar(linha.replace(/[🎉🧡👉✅🔥]/gu, ''), 72);
  }
  return resto;
}
function url(caminho) { return caminho ? st.urls[caminho] : null; }
function ehVideo(caminho) { return /\.mp4$/i.test(caminho || ''); }
function miniatura(p) { return p.formato === 'reels' ? url(p.capa) : ehVideo(p.midias[0]) ? null : url(p.midias[0]); }
function rotuloFormato(p) { return p.formato === 'story' && (p.video || ehVideo(p.midias[0])) ? 'Story (vídeo)' : FORMATO[p.formato]; }
function corProduto(nome) { return st.produtos.find(x => x.nome === nome)?.cor || '#A8A29E'; }
function chipProduto(nome) { return `<span class="chip produto" style="--pc:${corProduto(nome)}">${esc(nome)}</span>`; }
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), 3800);
}
function saudacao() {
  const h = Number(fmt(new Date().toISOString(), { hour: 'numeric', hour12: false }));
  const oi = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  return `${oi} · ${fmt(new Date().toISOString(), { weekday: 'long', day: 'numeric', month: 'long' })}`;
}

/* ---------- dados ---------- */
async function carregar() {
  const [p, c, a, pl, pt, pr] = await Promise.all([
    sb.from('posts').select('*').order('quando'),
    sb.from('comentarios').select('*').order('criado_em'),
    sb.from('aprovadores').select('*'),
    sb.from('planejamentos').select('*').order('criado_em', { ascending: false }),
    sb.from('ponte').select('*'),
    sb.from('produtos').select('*').order('ordem'),
  ]);
  if (p.error) throw p.error;
  st.posts = p.data;
  st.coments = {};
  for (const x of c.data || []) (st.coments[x.post_id] ||= []).push(x);
  st.planos = pl.data || [];
  st.produtos = pr.data || [];
  st.ultimaRodada = (pt.data || []).find(x => x.chave === 'ultima_rodada')?.valor || null;
  st.nomes = Object.fromEntries((a.data || []).map(x => [x.email, x.nome]));
  const caminhos = [...new Set(st.posts.flatMap(x => [...x.midias, x.capa]).filter(Boolean))];
  const faltam = Date.now() - st.urlsEm > 40 * 60e3 ? caminhos : caminhos.filter(k => !st.urls[k]);
  if (faltam.length) {
    if (faltam === caminhos) { st.urls = {}; st.urlsEm = Date.now(); }
    for (let i = 0; i < faltam.length; i += 200) {
      const { data } = await sb.storage.from('pecas').createSignedUrls(faltam.slice(i, i + 200), 3600);
      for (const u of data || []) if (u.signedUrl) st.urls[u.path] = u.signedUrl;
    }
  }
  st.carregado = true;
}

/* ---------- tempo do robô ---------- */
const CICLO_MIN = 15;
const ESTIMATIVA_MIN = { reels: 45, carrossel: 15, estatico: 10, story: 10 };
function estimativa(p) { return p.midias.length ? ESTIMATIVA_MIN[p.formato] : 3; }
function hora(d) { return fmt(d.toISOString(), { hour: '2-digit', minute: '2-digit' }); }
function minutosDesde(iso) { return Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60e3)); }
function proximaVerificacao() {
  if (!st.ultimaRodada) return null;
  return new Date(new Date(st.ultimaRodada).getTime() + CICLO_MIN * 60e3);
}
function textoFila() {
  const prox = proximaVerificacao();
  if (!prox) return `O robô verifica a cada ${CICLO_MIN} minutos.`;
  if (prox.getTime() < Date.now() - 5 * 60e3) return 'A próxima verificação está atrasada: o computador da ponte pode estar desligado ou fora da internet.';
  return `Na fila. O robô começa na próxima verificação, por volta das ${hora(prox)}.`;
}
function textoTrabalhando(inicio, est) {
  const m = minutosDesde(inicio);
  const base = `Começou às ${hora(new Date(inicio))} · ${m} min até agora`;
  return m <= est ? `${base} · costuma levar até ~${est} min` : `${base} · passou da estimativa de ~${est} min; vídeos podem levar até 1 hora`;
}
function porcentagem(inicio, est) { return Math.min(95, Math.round(minutosDesde(inicio) / est * 100)); }
function progresso(p) {
  const est = estimativa(p);
  return `<div class="progresso" data-inicio="${p.atualizado_em}" data-est="${est}">
    <div class="barra"><i style="width:${porcentagem(p.atualizado_em, est)}%"></i></div>
    <small class="tempo">${textoTrabalhando(p.atualizado_em, est)}</small></div>`;
}
setInterval(() => {
  for (const el of document.querySelectorAll('[data-inicio]')) {
    const { inicio, est } = el.dataset;
    const t = el.querySelector('.tempo'), b = el.querySelector('.barra i');
    if (t) t.textContent = textoTrabalhando(inicio, Number(est));
    if (b) b.style.width = porcentagem(inicio, Number(est)) + '%';
  }
}, 20e3);

/* ---------- componentes ---------- */
function midia(p) {
  if (!p.midias.length) return `<div class="midia texto"><div><span class="rotulo">${p.status === 'produzir' ? 'Peça em produção' : 'Ainda sem arte'}</span>
    <h4>${p.formato === 'reels' ? 'Roteiro do Reels' : p.video ? 'Roteiro do story em vídeo' : 'Briefing da arte'}</h4><div class="roteiro">${esc(p.roteiro || 'Sem roteiro.')}</div></div></div>`;
  const n = p.midias.length, i = Math.min(st.slide[p.id] || 0, n - 1);
  const atual = url(p.midias[i]);
  let el;
  if (!atual) el = `<div class="carregando">Prévia ainda não enviada</div>`;
  else if (p.formato === 'reels' || ehVideo(p.midias[i])) el = `<video src="${atual}" poster="${url(p.capa) || ''}" controls playsinline preload="metadata"></video>`;
  else el = `<img src="${atual}" alt="${esc(nome(p))}${n > 1 ? `, slide ${i + 1} de ${n}` : ''}">`;
  const nav = n > 1 ? `
    <button class="seta esq" data-slide="${p.id}" data-d="-1" aria-label="Slide anterior">‹</button>
    <button class="seta dir" data-slide="${p.id}" data-d="1" aria-label="Próximo slide">›</button>
    <div class="pontos">${p.midias.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>` : '';
  return `<div class="midia">${el}${nav}</div>`;
}

function historico(p) {
  const cs = st.coments[p.id] || [];
  if (!cs.length) return '';
  const aberto = st.histAberto[p.id], ocultos = aberto ? 0 : cs.length - 1;
  const botao = cs.length > 1 ? `<button class="ver-hist" data-hist="${p.id}">${aberto ? 'Recolher histórico' : `Ver histórico (${ocultos} ${ocultos > 1 ? 'anteriores' : 'anterior'})`}</button>` : '';
  return `<div class="historico${aberto ? ' tudo' : ''}">${botao}${cs.slice(ocultos).map(c => {
    const quem = c.autor === 'Claude' ? 'Claude' : (st.nomes[c.autor] || c.autor.split('@')[0]);
    const cor = { ajuste: 'var(--st-ajuste)', aprovacao: 'var(--st-publicado)', robo: 'var(--orange)', reprovacao: 'var(--st-atencao)' }[c.tipo] || 'var(--line-2)';
    const acao = { ajuste: 'pediu ajuste', aprovacao: 'aprovou', robo: 'ajustou', nota: '', reprovacao: 'não aprovou' }[c.tipo];
    return `<div class="coment" style="--c:${cor}"><b>${esc(quem)}</b> ${acao}<small>v${c.versao} · ${fmt(c.criado_em, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</small>${c.texto ? `<div>${esc(c.texto)}</div>` : ''}</div>`;
  }).join('')}</div>`;
}

function card(p) {
  const pode = FILA.includes(p.status);
  const texto = !p.midias.length;
  const reabrir = p.status === 'aprovado';
  const aberto = st.ajusteAberto === p.id;
  const descartar = st.descartarAberto === p.id;
  const podeDescartar = pode || reabrir || p.status === 'ajuste';
  let aviso = '';
  if (p.status === 'atencao') aviso = `<div class="aviso" style="--c:var(--st-atencao)">O Claude não conseguiu fazer este ajuste sozinho. A Ana Julia vai tratar no chat; você ainda pode aprovar como está ou pedir outro ajuste.</div>`;
  if (p.status === 'pauta') aviso = `<div class="aviso" style="--c:var(--st-pauta)">Aprove o texto e o roteiro. Depois disso o Claude produz a arte e o post volta aqui para a aprovação final.</div>`;
  if (p.status === 'produzir') aviso = `<div class="aviso" style="--c:var(--st-producao)">Texto aprovado. O Claude está produzindo a peça; ela volta aqui para a aprovação final.</div>`;
  if (p.status === 'ajuste') aviso = `<div class="aviso" style="--c:var(--st-ajuste)"><b>Ajuste pedido.</b> ${textoFila()} Depois disso, ${p.formato === 'reels' && p.midias.length ? 'refazer um Reels costuma levar de 20 a 45 minutos' : `leva em média ${estimativa(p)} minutos`}.</div>`;
  if (p.status === 'corrigindo') aviso = `<div class="aviso" style="--c:var(--st-ajuste)"><b>O Claude está fazendo o ajuste.</b> O post volta para aprovação assim que terminar.${progresso(p)}</div>`;
  if (p.status === 'aprovado') aviso = `<div class="aviso" style="--c:var(--st-agendado)">Aprovado${p.aprovado_por ? ` por ${esc(st.nomes[p.aprovado_por] || p.aprovado_por)}` : ''}. Será publicado ${quando(p.quando)}.</div>`;
  const redes = Object.keys(p.publicado || {});
  if (p.status === 'publicado' && redes.length) aviso = `<div class="aviso" style="--c:var(--st-publicado)">Publicado em: ${redes.map(r => r[0].toUpperCase() + r.slice(1)).join(', ')}.</div>`;
  return `
  <article class="painel card" data-id="${p.id}">
    ${midia(p)}
    <div class="corpo">
      <div class="meta">
        ${chipProduto(p.produto)}
        <span>${icone(p.formato, 14)} ${rotuloFormato(p)}</span>
        <span>· ${quando(p.quando)}</span>
        ${p.versao > 1 ? `<span>· versão ${p.versao}</span>` : ''}
        <span style="margin-left:auto">${pilula(p.status)}</span>
      </div>
      <h2>${esc(nome(p))}</h2>
      ${texto && p.cta ? `<div class="meta">CTA: <span class="chip">${esc(p.cta)}</span></div>` : ''}
      ${p.legenda ? `<div class="legenda">${esc(p.legenda)}</div>` : '<div class="legenda" style="color:var(--faint)">Story sem legenda.</div>'}
      ${aviso}
      ${historico(p)}
      ${aberto ? `
        <textarea id="txt-${p.id}" placeholder="O que precisa mudar? Ex.: troca a foto, essa tem bebida."></textarea>
        <div class="acoes">
          <button class="btn primario" data-enviar="${p.id}">Enviar pedido de ajuste</button>
          <button class="btn" data-cancelar="${p.id}">Cancelar</button>
        </div>` : descartar ? `
        <div class="aviso" style="--c:var(--st-atencao)"><b>Não aprovar este post?</b> Ele sai da fila${reabrir ? ' e da agenda' : ''} e não será publicado. Os arquivos vão para a pasta <i>Reprovados</i> do mês.</div>
        <textarea id="mot-${p.id}" placeholder="Motivo (opcional). Ex.: tema repetido, não vamos usar."></textarea>
        <div class="acoes">
          <button class="btn perigo" data-descartar-ok="${p.id}">Não aprovar e tirar da fila</button>
          <button class="btn" data-cancelar="${p.id}">Cancelar</button>
        </div>` : (pode || reabrir || podeDescartar) ? `
        <div class="acoes">
          ${pode ? `<button class="btn primario" data-aprovar="${p.id}">${icone('aprovar')} ${texto ? 'Aprovar texto' : 'Aprovar'}</button>` : ''}
          ${pode || reabrir ? `<button class="btn" data-ajuste="${p.id}">Pedir ajuste${reabrir ? ' (tira da agenda)' : ''}</button>` : ''}
          <button class="btn sutil" data-descartar="${p.id}">Não aprovar</button>
        </div>` : ''}
    </div>
  </article>`;
}

function linha(p) {
  const img = miniatura(p);
  return `<button class="linha" data-abrir="${p.id}">
    <span class="miniatura" style="${img ? `background-image:url('${img}')` : ''}">${img ? '' : icone(p.formato, 18)}</span>
    <span><strong>${esc(nome(p))}</strong><small>${rotuloFormato(p)} · <span class="ponto-prod" style="--pc:${corProduto(p.produto)}"></span>${esc(p.produto)} · ${quando(p.quando)}${p.status === 'corrigindo' ? ` · <b class="trabalhando">Claude trabalhando há ${minutosDesde(p.atualizado_em)} min</b>` : p.status === 'ajuste' && proximaVerificacao() ? ` · começa por volta das ${hora(proximaVerificacao())}` : ''}</small></span>
    ${pilula(p.status)}
  </button>`;
}

/* ---------- telas ---------- */
function telaAprovar() {
  const fila = st.posts.filter(p => FILA.includes(p.status));
  const ajustes = st.posts.filter(p => ['ajuste', 'corrigindo', 'produzir'].includes(p.status));
  const agora = new Date().toISOString();
  const proximas = st.posts.filter(p => p.status === 'aprovado' && p.quando >= agora).slice(0, 6);
  let h = fila.length
    ? `<div class="fila">${fila.map(card).join('')}</div>`
    : `<div class="painel vazio"><div class="selo"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
        <h2>Tudo em dia!</h2><p>Quando a equipe entregar posts novos, eles aparecem aqui. Enquanto isso, veja o que vem por aí.</p></div>`;
  if (ajustes.length) h += `<div class="secao-titulo"><h3>Em ajuste ou produção</h3><span>${ajustes.length}</span></div><div class="painel lista">${ajustes.map(linha).join('')}</div>`;
  h += `<div class="secao-titulo"><h3>Próximas publicações</h3><span>${proximas.length}</span></div>
        <div class="painel lista">${proximas.map(linha).join('') || '<div class="linha"><small>Nada agendado.</small></div>'}</div>`;
  return `<div class="estreito">${h}</div>`;
}

function postsDoMes() { return st.posts.filter(p => p.mes === st.mes && p.status !== 'reprovado' && (!st.produto || p.produto === st.produto)); }

function telaCalendario() {
  const [a, m] = st.mes.split('-').map(Number);
  const doMes = postsDoMes();
  const produtos = [...new Set(st.posts.filter(p => p.mes === st.mes && p.status !== 'reprovado').map(p => p.produto))].sort();
  const titulo = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(a, m - 1, 15)));
  const inicio = new Date(Date.UTC(a, m - 1, 1)), dias = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const vazios = inicio.getUTCDay(), total = Math.ceil((vazios + dias) / 7) * 7;
  const hoje = diaDe(new Date());
  const porDia = {};
  for (const p of doMes) (porDia[diaDe(new Date(p.quando))] ||= []).push(p);
  let celulas = '';
  for (let k = 0; k < total; k++) {
    const d = k - vazios + 1;
    if (d < 1 || d > dias) { celulas += '<div class="dia fora vazio-dia"></div>'; continue; }
    const chave = `${st.mes}-${String(d).padStart(2, '0')}`;
    const evs = porDia[chave] || [];
    celulas += `<div class="dia ${chave === hoje ? 'hoje' : ''} ${evs.length ? '' : 'vazio-dia'}"><span class="num">${d}</span>${evs.map(p => {
      const s = STATUS[p.status] || {};
      return `<button class="evento" style="--c:${s.cor};--pc:${corProduto(p.produto)}" data-abrir="${p.id}"><span class="tipo">${icone(p.formato, 12)} ${rotuloFormato(p)} · <span class="ponto-prod"></span><span class="nome-prod">${esc(p.produto)}</span></span><b>${esc(nome(p))}</b>${pilula(p.status)}</button>`;
    }).join('')}</div>`;
  }
  const publicados = doMes.filter(p => p.status === 'publicado').length;
  return `
  <div class="painel cal-topo">
    <button class="redondo" data-mes="-1" aria-label="Mês anterior">‹</button>
    <h2>${titulo[0].toUpperCase() + titulo.slice(1)}<small>${doMes.length} posts · ${publicados} publicados</small></h2>
    <button class="redondo" data-mes="1" aria-label="Próximo mês">›</button>
  </div>
  <div class="filtros">
    ${LEGENDA_CAL.map(pilula).join('')}
    <span class="sep"></span>
    <button class="${st.produto ? '' : 'on'}" data-produto="">Todos</button>
    ${produtos.map(x => `<button class="${st.produto === x ? 'on' : ''}" data-produto="${esc(x)}"><span class="ponto-prod" style="--pc:${corProduto(x)}"></span>${esc(x)}</button>`).join('')}
  </div>
  <div class="grade">${['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'].map(d => `<div class="dow">${d}</div>`).join('')}${celulas}</div>`;
}

const TIPOS = { mes: ['Mês completo', 'Uma peça por dia, com rodízio entre os produtos'],
                serie: ['Série paralela', 'Uma série junto com o plano que já existe'],
                avulso: ['Post avulso', 'Uma publicação fora do plano'] };
const STORIES = { nao: ['Sem stories', 'Só os posts do feed'],
                  diario: ['Todo dia', 'Inclusive fim de semana'],
                  uteis: ['Dias úteis', 'De segunda a sexta'] };
const PLANO_STATUS = { pedido: ['Na fila', 'var(--faint)'], gerando: ['Claude montando', 'var(--st-ajuste)'],
                       pronto: ['Pronto', 'var(--st-publicado)'], erro: ['Deu erro', 'var(--st-atencao)'],
                       descartado: ['Excluído', 'var(--faint)'] };
const CORES_SUGERIDAS = ['#E87018', '#E5484D', '#2E9E4F', '#2F7BEA', '#8B5CF6', '#14B8A6', '#EAB308', '#EC4899', '#A8A29E'];

function proximoMes() { const [a, m] = mesDe(new Date()).split('-').map(Number); return mesDe(new Date(Date.UTC(a, m, 15))); }
function nomeMes(mes) { const t = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(mes + '-15T12:00:00Z')); return t[0].toUpperCase() + t.slice(1); }
function produtosAtivos() { return st.produtos.filter(x => x.ativo); }

function formPlano() {
  const base = st.planos.find(x => x.id === st.refazer) || {};
  const campo = (nome, rotulo, dica) => `<label class="campo">${rotulo}<textarea name="${nome}" rows="2" placeholder="${dica}">${esc(base[nome] || '')}</textarea></label>`;
  // padrão pedido em 11/11: stories todo dia, 1 vídeo por semana
  const tipo = base.tipo || 'mes', stories = base.stories && base.stories !== 'nao' ? base.stories : 'diario';
  const videos = base.stories && base.stories !== 'nao' ? base.stories_videos : 1;
  const posts = base.id ? st.posts.filter(p => p.planejamento_id === base.id && !['aprovado', 'publicado', 'reprovado'].includes(p.status)).length : 0;
  const mantidos = base.id ? st.posts.filter(p => p.planejamento_id === base.id && ['aprovado', 'publicado'].includes(p.status)).length : 0;
  return `<form class="painel form-plano" id="form-plano">
    ${base.id ? `<div class="aviso" style="--c:var(--st-atencao)"><b>Refazendo: ${TIPOS[base.tipo][0]} · ${nomeMes(base.mes)}.</b>
      Ao mandar, os ${posts} posts deste plano que ainda não foram aprovados são excluídos${mantidos ? ` (os ${mantidos} já aprovados ficam)` : ''} e o Claude monta um plano novo com as respostas abaixo. Ajuste o que quiser antes de mandar.</div>` : ''}
    <div class="campo">Tipo de plano<div class="tipos">${Object.entries(TIPOS).map(([k, [t, d]]) =>
      `<label class="tipo"><input type="radio" name="tipo" value="${k}" ${k === tipo ? 'checked' : ''}><b>${t}</b><small>${d}</small></label>`).join('')}</div></div>
    <label class="campo">Mês<input type="month" name="mes" value="${base.mes || proximoMes()}" required></label>
    <div class="campo">Produtos<div class="chips">${produtosAtivos().map(x => `<label class="chk" style="--pc:${x.cor}"><input type="checkbox" name="produtos" value="${esc(x.nome)}" ${(base.produtos || []).includes(x.nome) ? 'checked' : ''}><span><i class="ponto-prod"></i>${esc(x.nome)}</span></label>`).join('')}</div>
      <div class="vao-entrar" id="vao-entrar">${resumoProdutos(base.produtos || [])}</div>
      <small>Clique no produto para marcar: marcado fica preenchido com a cor e com ✓. Nenhum marcado = todos, com rodízio.</small></div>
    <div class="campo">Stories<div class="tipos">${Object.entries(STORIES).map(([k, [t, d]]) =>
      `<label class="tipo"><input type="radio" name="stories" value="${k}" ${k === stories ? 'checked' : ''}><b>${t}</b><small>${d}</small></label>`).join('')}</div>
      <label class="linha-campo">Quantos desses stories por semana são vídeo?
        <select name="stories_videos">${[0, 1, 2, 3, 4, 5, 6, 7].map(n => `<option value="${n}" ${n === videos ? 'selected' : ''}>${n === 0 ? 'nenhum (só fotos)' : n === 1 ? '1 vídeo' : n + ' vídeos'}</option>`).join('')}</select></label>
      <label class="linha-campo">Stories por dia
        <select name="stories_por_dia">${[1, 2, 3].map(n => `<option value="${n}" ${n === (base.stories_por_dia || 1) ? 'selected' : ''}>${n} por dia</option>`).join('')}</select></label>
      <small>Os outros stories são fotos estáticas para divulgar os produtos, alternando com os posts do feed.</small></div>
    <label class="campo">Posts no feed por dia (deste plano)
      <select name="feed_por_dia">${[1, 2, 3].map(n => `<option value="${n}" ${n === (base.feed_por_dia || 1) ? 'selected' : ''}>${n} por dia</option>`).join('')}</select>
      <small>Somam com o que já existe no mês. Ex.: plano do mês com 1 por dia + série com 2 por dia = 3 posts no feed por dia.</small></label>
    ${campo('objetivo', 'Objetivo', 'Ex.: gerar pedidos de Proposta Comercial do Caixa Eventos para o réveillon')}
    ${campo('datas', 'Datas e campanhas', 'Ex.: Natal, réveillon, férias escolares, campanha de fim de ano até 20/12')}
    ${campo('temas', 'Temas e ideias', 'Ex.: mostrar clientes reais, bastidores da equipe, dúvidas que chegam no suporte')}
    ${campo('observacoes', 'Observações', 'Ex.: menos estático, mais Reels; nada de bebida nas fotos')}
    <div class="acoes"><button class="btn primario" ${st.enviando ? 'disabled' : ''}>${icone('planejar')} ${base.id ? 'Excluir o plano antigo e refazer' : 'Mandar para a fábrica'}</button>
      <button type="button" class="btn" data-fechar-plano>Cancelar</button></div>
  </form>`;
}

function acompanhamento(pl) {
  if (pl.status === 'pedido') return `<div class="acompanha"><div class="aviso" style="--c:var(--faint)"><b>Na fila.</b> A fábrica verifica os pedidos a cada 15 minutos; este começa na próxima verificação.</div></div>`;
  const prog = pl.progresso || {};
  const etapas = prog.etapas || [];
  if (!etapas.length && pl.status !== 'gerando') return '';
  const feitas = etapas.filter(e => e.feito_em).length;
  const atual = pl.status === 'gerando' ? etapas.findIndex(e => !e.feito_em) : -1;
  const h = iso => fmt(iso, { hour: '2-digit', minute: '2-digit' });
  let topo = '';
  if (pl.status === 'gerando' && pl.iniciado_em) {
    const min = minutosDesde(pl.iniciado_em);
    const dur = min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min} min`;
    topo = `<small class="tempo">Começou às ${h(pl.iniciado_em)} · ${dur} até agora · costuma levar de 1 a 2 horas</small>
      <div class="barra"><i style="width:${Math.max(4, Math.round(feitas / (etapas.length || 9) * 100))}%"></i></div>`;
    const visto = prog.visto_em || pl.iniciado_em;
    if (minutosDesde(visto) > 20) topo += `<div class="aviso" style="--c:var(--st-atencao)">A fábrica não dá sinal desde as ${h(visto)}. O computador da fábrica pode estar desligado ou sem a pasta de rede. Quando ele voltar, o plano recomeça sozinho.</div>`;
  }
  const lista = etapas.map((e, i) => {
    const classe = e.feito_em ? 'ok' : i === atual ? 'agora' : '';
    const marca = e.feito_em ? '✓' : i === atual ? '●' : '○';
    const quando = e.feito_em ? h(e.feito_em) : i === atual ? 'em andamento' : '';
    return `<li class="${classe}"><span>${marca}</span>${esc(e.nome)}<small>${quando}</small></li>`;
  }).join('') || '<li class="agora"><span>●</span>Lendo o briefing e a squad<small>em andamento</small></li>';
  return `<div class="acompanha">${topo}<ol class="etapas">${lista}</ol></div>`;
}

function resumoProdutos(lista) {
  return lista.length ? `<b>Vão entrar neste plano:</b> ${lista.map(n => chipProduto(n)).join(' ')}`
                      : '<b>Nenhum produto marcado:</b> o plano usa todos, com rodízio.';
}

function linhaPlano(pl) {
  const [rot, cor] = PLANO_STATUS[pl.status] || [pl.status, 'var(--faint)'];
  const qtd = st.posts.filter(p => p.planejamento_id === pl.id && p.status !== 'reprovado').length;
  const pode = ['pronto', 'erro', 'pedido'].includes(pl.status);
  const extra = [pl.produtos?.length ? pl.produtos.join(', ') : 'todos os produtos',
                 pl.stories && pl.stories !== 'nao' ? `stories ${STORIES[pl.stories][0].toLowerCase()}${pl.stories_videos ? ` (${pl.stories_videos} vídeo${pl.stories_videos > 1 ? 's' : ''}/semana)` : ''}` : ''].filter(Boolean).join(' · ');
  const confirmar = st.excluirPlano === pl.id ? `
    <div class="confirma">
      <div class="aviso" style="--c:var(--st-atencao)"><b>Excluir este plano?</b> Os posts dele que ainda não foram aprovados saem da fila e do calendário. Aprovados e publicados ficam.</div>
      <div class="acoes"><button class="btn perigo" data-excluir-ok="${pl.id}">Excluir plano</button><button class="btn" data-cancelar-plano>Cancelar</button></div>
    </div>` : '';
  const vivo = ['pedido', 'gerando'].includes(pl.status);
  const aberto = vivo || st.planoAberto === pl.id;
  return `<div class="linha plano">
    <span class="miniatura">${icone('calendario', 18)}</span>
    <span><strong>${TIPOS[pl.tipo][0]} · ${nomeMes(pl.mes)}</strong>
      <small>Pedido por ${esc(st.nomes[pl.criado_por] || pl.criado_por)} em ${fmt(pl.criado_em, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${qtd ? ` · ${qtd} posts` : ''} · ${esc(extra)}</small>
      ${pl.resumo ? `<small class="resumo">${esc(pl.resumo)}</small>` : ''}
      ${aberto ? acompanhamento(pl) : ''}
      <span class="acoes-plano">
        ${!vivo && (pl.progresso?.etapas || []).length ? `<button class="btn mini" data-ver-plano="${pl.id}">${aberto ? 'Esconder etapas' : 'Ver etapas'}</button>` : ''}
        ${pl.status === 'pronto' && qtd ? `<button class="btn mini" data-ir-aprovar>Ver os textos em Aprovar</button>` : ''}
        ${pode ? `<button class="btn mini" data-refazer="${pl.id}">Refazer</button><button class="btn mini sutil" data-excluir-plano="${pl.id}">Excluir</button>` : ''}
      </span>
      ${confirmar}</span>
    <span class="pilula" style="--c:${cor}">${rot}</span>
  </div>`;
}

function telaProdutos() {
  const ed = st.editProduto;
  const linhas = produtosAtivos().map(x => ed === x.nome ? formProduto(x) : `
    <div class="linha produto-linha">
      <span class="amostra" style="background:${x.cor}"></span>
      <span><strong>${esc(x.nome)}</strong><small>${x.descricao ? esc(cortar(x.descricao, 140)) : '<i>Sem descrição: o Claude usa o que já sabe do produto.</i>'}</small></span>
      <button class="btn mini" data-editar-produto="${esc(x.nome)}">Editar</button>
    </div>`).join('');
  return `<div class="painel lista">${linhas}${ed === '' ? formProduto({ nome: '', cor: CORES_SUGERIDAS[4], descricao: '' }) :
    `<div class="linha"><button class="btn mini" data-editar-produto="">+ Adicionar produto</button></div>`}</div>`;
}

function formProduto(x) {
  return `<form class="form-produto" id="form-produto" data-antigo="${esc(x.nome)}">
    <label class="campo">Nome<input name="nome" value="${esc(x.nome)}" required maxlength="40" placeholder="Ex.: Franquias"></label>
    <div class="campo">Cor<div class="cores-escolha">
      <input type="color" name="cor" value="${x.cor}" aria-label="Escolher cor">
      ${CORES_SUGERIDAS.map(c => `<button type="button" class="bolinha" style="background:${c}" data-cor="${c}" aria-label="Usar ${c}"></button>`).join('')}
    </div><small>Usada no calendário, nos cards e nos filtros.</small></div>
    <label class="campo">O que é este produto (opcional)<textarea name="descricao" rows="2" placeholder="Ex.: sistema para redes de franquias controlarem as unidades; público: franqueadores">${esc(x.descricao)}</textarea>
      <small>Vai junto no pedido para o Claude não inventar recursos.</small></label>
    <div class="acoes"><button class="btn primario">Salvar</button><button type="button" class="btn" data-cancelar-produto>Cancelar</button>
      ${x.nome ? `<button type="button" class="btn sutil" data-remover-produto="${esc(x.nome)}">Tirar da lista</button>` : ''}</div>
  </form>`;
}

function telaPlanejar() {
  const planos = st.planos.filter(pl => pl.status !== 'descartado').map(linhaPlano).join('');
  const excluidos = st.planos.filter(pl => pl.status === 'descartado').length;
  return `<div class="estreito">
    ${st.formAberto ? formPlano() : `<div class="painel planejar-cta">
      <div><h3>Planejar conteúdo</h3><p>Responda algumas perguntas, como numa reunião de pauta. Pode ser o plano do mês, uma série paralela ou um post avulso. Um plano não apaga o outro. Não gostou de um plano? Use <b>Refazer</b> nele, logo abaixo.</p>
        <ol class="passos"><li>Você preenche o tipo de plano, o mês, os produtos, os stories e as ideias.</li>
        <li>O Claude roda a squad de planejamento e monta a pauta e os textos, em cerca de 1 a 2 horas.</li>
        <li>Os textos aparecem em <b>Aprovar</b>. Aprovado o texto, o Claude produz a arte e ela volta para a aprovação final.</li></ol></div>
      <button class="btn primario" data-novo-plano>${icone('calendario')} Começar</button>
    </div>`}
    <div class="secao-titulo"><h3>Pedidos de planejamento</h3><span>${st.planos.length - excluidos}${excluidos ? ` · ${excluidos} excluído${excluidos > 1 ? 's' : ''}` : ''}</span></div>
    <div class="painel lista">${planos || '<div class="linha"><small>Nenhum pedido ainda.</small></div>'}</div>
    <div class="secao-titulo"><h3>Produtos e cores</h3><span>aparecem no Planejar, no calendário e nos cards</span></div>
    ${telaProdutos()}
    <div class="secao-titulo"><h3>Identidade visual</h3><span>o Claude e as squads seguem em todo trabalho</span></div>
    <div class="cards-2">
      <div class="painel identidade"><h4>ThR Softwares</h4><p>Marca mãe de todos os produtos.</p>
        <div class="cores">${['#E87018', '#1E1612', '#F58A3A', '#FFFFFF'].map(c => `<span class="cor"><i style="background:${c}"></i>${c}</span>`).join('')}</div>
        <p style="margin:12px 0 0">Fonte: Poppins</p></div>
    </div>
  </div>`;
}

function telaPainel() {
  const doMes = st.posts.filter(p => p.mes === st.mes && p.status !== 'reprovado');
  const conta = s => doMes.filter(p => s.includes(p.status)).length;
  const redes = { instagram: 0, facebook: 0, youtube: 0 };
  for (const p of doMes) if (p.status === 'publicado') for (const r of Object.keys(p.publicado || {})) if (r in redes) redes[r]++;
  const problemas = doMes.filter(p => ['falhou', 'atrasado', 'atencao'].includes(p.status));
  const n = (v, t) => `<div class="painel numero"><b>${v}</b><span>${t}</span></div>`;
  const titulo = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' }).format(new Date(st.mes + '-15T12:00:00Z'));
  return `
    <div class="numeros">
      ${n(doMes.length, `posts em ${titulo}`)}${n(conta(['publicado']), 'publicados')}
      ${n(conta(['aguardando', 'ajuste', 'corrigindo']), 'em aprovação ou ajuste')}${n(conta(['falhou', 'atrasado', 'atencao']), 'precisam de atenção')}
    </div>
    <div class="secao-titulo"><h3>Publicados por rede</h3><span>${titulo}</span></div>
    <div class="numeros">${n(redes.instagram, 'Instagram')}${n(redes.facebook, 'Facebook')}${n(redes.youtube, 'YouTube (Shorts)')}${n(conta(['aprovado']), 'agendados')}</div>
    <div class="secao-titulo"><h3>Precisam de atenção</h3><span>${problemas.length}</span></div>
    <div class="painel lista">${problemas.map(linha).join('') || '<div class="linha"><small>Nenhum problema neste mês.</small></div>'}</div>`;
}

/* ---------- moldura ---------- */
const TITULOS = { aprovar: 'Aprovação de posts', calendario: 'Calendário de posts', planejar: 'Planejamento', painel: 'Painel' };

function render() {
  const app = document.getElementById('app');
  if (!st.sessao) return renderLogin(app);
  const pendentes = st.posts.filter(p => FILA.includes(p.status)).length;
  const email = st.sessao.user.email;
  const status = pendentes
    ? `<span class="ponto laranja"></span> ${pendentes} ${pendentes === 1 ? 'post esperando' : 'posts esperando'} aprovação.`
    : '<span class="ponto"></span> Tudo em dia por aqui.';
  const telas = { aprovar: telaAprovar, calendario: telaCalendario, planejar: telaPlanejar, painel: telaPainel };
  const modal = st.modal && st.posts.find(p => p.id === st.modal);
  app.innerHTML = `
  <header class="hero">
    <div class="topbar">
      <img class="logo" src="logo.png" alt="ThR Softwares">
      <nav class="nav">${ABAS.map(([k, t]) => `<button class="${st.aba === k ? 'ativo' : ''}" data-aba="${k}">${icone(k)} ${t}${k === 'aprovar' && pendentes ? ` <span class="badge">${pendentes}</span>` : ''}</button>`).join('')}</nav>
      <div class="usuario"><button class="avatar" data-menu title="${esc(email)}">${esc((st.nomes[email] || email)[0].toUpperCase())}</button></div>
    </div>
    <div class="cabecalho">
      <div class="saudacao">${saudacao()}</div>
      <h1>${TITULOS[st.aba]}</h1>
      <div class="status-linha">${status}</div>
    </div>
  </header>
  <main>${st.carregado ? telas[st.aba]() : '<div class="carregando">Carregando…</div>'}</main>
  ${modal ? `<div class="fundo-modal" data-fundo><div style="max-width:900px;width:100%;position:relative"><button class="redondo fechar" data-fechar aria-label="Fechar">×</button>${card(modal)}</div></div>` : ''}`;
}

function renderLogin(app) {
  app.innerHTML = `
  <div class="login">
    <form class="painel" id="form-login">
      <img src="logo.png" alt="ThR Softwares">
      <h1>Portal de Marketing</h1>
      <p>Aprovação e calendário dos posts da ThR</p>
      <label>E-mail<input type="email" name="email" autocomplete="username" required></label>
      <label>Senha<input type="password" name="senha" autocomplete="current-password" required></label>
      <button class="btn primario" style="justify-content:center">Entrar</button>
      <p class="erro" id="erro-login"></p>
    </form>
  </div>`;
  document.getElementById('form-login').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({ email: f.get('email').trim().toLowerCase(), password: f.get('senha') });
    if (error) document.getElementById('erro-login').textContent = 'E-mail ou senha incorretos.';
  };
}

/* ---------- ações ---------- */
async function atualizar(silencioso = false) {
  const antes = JSON.stringify([st.posts, st.coments, st.planos, st.produtos]);
  try { await carregar(); } catch (e) { if (!silencioso) toast('Não consegui carregar os posts. Tente de novo.'); console.error(e); }
  if (silencioso && antes === JSON.stringify([st.posts, st.coments, st.planos, st.produtos])) return; // não reinicia vídeo à toa
  render();
}

document.addEventListener('click', async e => {
  const b = e.target.closest('button, [data-fundo]');
  if (!b) return;
  const d = b.dataset;
  if (d.fundo !== undefined && e.target !== b) return;
  if (d.aba) { st.aba = d.aba; st.ajusteAberto = null; st.descartarAberto = null; render(); scrollTo(0, 0); }
  else if (d.slide) {
    const p = st.posts.find(x => x.id === d.slide);
    st.slide[p.id] = ((st.slide[p.id] || 0) + Number(d.d) + p.midias.length) % p.midias.length; render();
  }
  else if (d.mes) {
    const [a, m] = st.mes.split('-').map(Number);
    st.mes = mesDe(new Date(Date.UTC(a, m - 1 + Number(d.mes), 15))); render();
  }
  else if (d.hist) { st.histAberto[d.hist] = !st.histAberto[d.hist]; render(); }
  else if (d.produto !== undefined) { st.produto = d.produto || null; render(); }
  else if (d.abrir) { st.modal = d.abrir; render(); }
  else if (d.fechar !== undefined || d.fundo !== undefined) { st.modal = null; st.ajusteAberto = null; st.descartarAberto = null; render(); }
  else if (d.ajuste) { st.ajusteAberto = d.ajuste; st.descartarAberto = null; render(); document.getElementById(`txt-${d.ajuste}`)?.focus(); }
  else if (d.cancelar) { st.ajusteAberto = null; st.descartarAberto = null; render(); }
  else if (d.descartar) { st.descartarAberto = d.descartar; st.ajusteAberto = null; render(); document.getElementById(`mot-${d.descartar}`)?.focus(); }
  else if (d.descartarOk) {
    b.disabled = true;
    const motivo = document.getElementById(`mot-${d.descartarOk}`)?.value.trim() || '';
    const { error } = await sb.rpc('reprovar', { p_id: d.descartarOk, p_texto: motivo });
    if (error) { toast(error.message); b.disabled = false; return; }
    toast('Post não aprovado. Saiu da fila; os arquivos vão para Reprovados em até 15 minutos.');
    st.descartarAberto = null; st.modal = null; await atualizar();
  }
  else if (d.aprovar) {
    b.disabled = true;
    const { error } = await sb.rpc('aprovar', { p_id: d.aprovar });
    if (error) { toast(error.message); b.disabled = false; return; }
    toast('Aprovado! Entra na agenda de publicação em até 15 minutos.');
    st.modal = null; await atualizar();
  }
  else if (d.enviar) {
    const texto = document.getElementById(`txt-${d.enviar}`).value.trim();
    if (!texto) { toast('Escreva o que precisa mudar.'); return; }
    b.disabled = true;
    const { error } = await sb.rpc('pedir_ajuste', { p_id: d.enviar, p_texto: texto });
    if (error) { toast(error.message); b.disabled = false; return; }
    toast('Pedido enviado. O Claude corrige e o post volta para aprovação.');
    st.ajusteAberto = null; st.modal = null; await atualizar();
  }
  else if (d.novoPlano !== undefined) { st.formAberto = true; st.refazer = null; render(); }
  else if (d.fecharPlano !== undefined) { st.formAberto = false; st.refazer = null; render(); }
  else if (d.refazer) { st.refazer = Number(d.refazer); st.formAberto = true; st.excluirPlano = null; render(); scrollTo(0, 0); }
  else if (d.verPlano) { st.planoAberto = st.planoAberto === Number(d.verPlano) ? null : Number(d.verPlano); render(); }
  else if (d.irAprovar !== undefined) { st.aba = 'aprovar'; render(); scrollTo(0, 0); }
  else if (d.excluirPlano) { st.excluirPlano = Number(d.excluirPlano); render(); }
  else if (d.cancelarPlano !== undefined) { st.excluirPlano = null; render(); }
  else if (d.excluirOk) {
    b.disabled = true;
    const { data, error } = await sb.rpc('descartar_planejamento', { p_id: Number(d.excluirOk), p_motivo: '' });
    if (error) { toast(error.message); b.disabled = false; return; }
    toast(`Plano excluído. ${data} posts saíram da fila e do calendário.`);
    st.excluirPlano = null; await atualizar();
  }
  else if (d.editarProduto !== undefined) { st.editProduto = d.editarProduto; render(); document.querySelector('#form-produto input[name=nome]')?.focus(); }
  else if (d.cancelarProduto !== undefined) { st.editProduto = null; render(); }
  else if (d.cor) { const i = document.querySelector('#form-produto input[name=cor]'); if (i) i.value = d.cor; }
  else if (d.removerProduto) {
    if (!confirm(`Tirar "${d.removerProduto}" da lista de produtos do Planejar? Os posts antigos dele continuam com a cor.`)) return;
    const { error } = await sb.rpc('remover_produto', { p_nome: d.removerProduto });
    if (error) { toast(error.message); return; }
    st.editProduto = null; await atualizar();
  }
  else if (d.menu !== undefined) abrirMenu();
});

document.addEventListener('submit', async e => {
  if (e.target.id === 'form-produto') {
    e.preventDefault();
    const f = new FormData(e.target);
    const { error } = await sb.rpc('salvar_produto', { p_nome: f.get('nome'), p_cor: f.get('cor'), p_descricao: f.get('descricao'),
      p_antigo: e.target.dataset.antigo || null });
    if (error) { toast(error.message); return; }
    toast('Produto salvo.'); st.editProduto = null; await atualizar(); return;
  }
  if (e.target.id !== 'form-plano') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const escolhidos = f.getAll('produtos');
  if (!confirm(`Confere antes de mandar:\n\nProdutos: ${escolhidos.join(', ') || 'todos, com rodízio'}\nFeed: ${f.get('feed_por_dia')} por dia\nStories: ${STORIES[f.get('stories')][0]}${f.get('stories') !== 'nao' ? ` (${f.get('stories_por_dia')} por dia, ${f.get('stories_videos')} vídeo(s) por semana)` : ''}\n\nEstá certo?`)) return;
  st.enviando = true; e.target.querySelector('.primario').disabled = true;
  const { error } = await sb.rpc('criar_planejamento', {
    p_tipo: f.get('tipo'), p_mes: f.get('mes'), p_produtos: f.getAll('produtos'), p_objetivo: f.get('objetivo'),
    p_datas: f.get('datas'), p_temas: f.get('temas'), p_observacoes: f.get('observacoes'),
    p_stories: f.get('stories'), p_stories_videos: Number(f.get('stories_videos')), p_substitui: st.refazer,
    p_feed_por_dia: Number(f.get('feed_por_dia')), p_stories_por_dia: Number(f.get('stories_por_dia')) });
  st.enviando = false;
  if (error) { toast(error.message); e.target.querySelector('.primario').disabled = false; return; }
  toast(st.refazer ? 'Plano antigo excluído e pedido novo enviado! A fábrica começa em até 15 minutos.' : 'Pedido enviado! A fábrica começa em até 15 minutos.');
  st.formAberto = false; st.refazer = null; await atualizar();
});

document.addEventListener('change', e => {
  if (e.target.name !== 'produtos') return;
  const el = document.getElementById('vao-entrar');
  if (el) el.innerHTML = resumoProdutos(new FormData(document.getElementById('form-plano')).getAll('produtos'));
});

document.addEventListener('keydown', e => { if (e.key === 'Escape' && st.modal) { st.modal = null; render(); } });

function abrirMenu() {
  const nova = prompt(`Conectado como ${st.sessao.user.email}.\n\nPara TROCAR A SENHA, digite a nova senha (mín. 8 caracteres).\nPara SAIR, digite: sair`);
  if (!nova) return;
  if (nova.trim().toLowerCase() === 'sair') { sb.auth.signOut(); return; }
  if (nova.length < 8) { toast('A senha precisa ter pelo menos 8 caracteres.'); return; }
  sb.auth.updateUser({ password: nova }).then(({ error }) => toast(error ? 'Não consegui trocar a senha.' : 'Senha trocada.'));
}

sb.auth.onAuthStateChange((_ev, sessao) => {
  const entrou = !st.sessao && sessao;
  st.sessao = sessao;
  if (!sessao) { st.carregado = false; render(); }
  else if (entrou) { render(); atualizar(); }
});
function editando() { return st.modal || st.ajusteAberto || st.descartarAberto || st.formAberto || st.editProduto !== null || st.excluirPlano; }
setInterval(() => { if (st.sessao && !editando() && document.visibilityState === 'visible') atualizar(true); }, 60e3);
document.addEventListener('visibilitychange', () => { if (st.sessao && document.visibilityState === 'visible' && !editando()) atualizar(true); });
render();
