'use strict';

/**
 * Publicador (opção C) — identidade de Página via Graph API.
 *
 * REALIDADE DA API (pós abril/2024):
 * - A Pages API oficial documenta publicação NA Página: POST /{page-id}/feed
 * - A Groups API (publish_to_groups) foi removida de todas as versões
 * - Não há endpoint oficial documentado para "Página publica em Grupo"
 *   no Facebook consumer
 *
 * Este módulo:
 * - NÃO inventa endpoints depreciados como solução garantida
 * - Associa grupo → Página via config (sem tokens no repositório)
 * - Com PUBLICAR=false: dry-run detalhado
 * - Com PUBLICAR=true: registra claramente que a API oficial
 *   não está disponível para o cenário Página→Grupo, e NÃO marca
 *   histórico como publicado
 *
 * NÃO usa senha, cookies, Playwright ou publish_to_groups.
 */

const path = require('path');
const { readJson, writeJson, nowIso } = require('./utils');
const { jaPublicadoRecentemente } = require('./historico');

const ROOT = path.join(__dirname, '..');
const SELECAO_FILE = path.join(ROOT, 'data', 'selecao-atual.json');
const GRUPOS_FILE = path.join(ROOT, 'config', 'grupos.json');
const PAGINAS_FILE = path.join(ROOT, 'config', 'paginas.json');
const RESULTADO_FILE = path.join(ROOT, 'data', 'resultado-publicacao.json');

const PUBLICAR = String(process.env.PUBLICAR || 'false').toLowerCase() === 'true';

const MSG_API_INDISPONIVEL =
  'API oficial não disponível para este grupo/cenário. ' +
  'A Meta removeu a Groups API (publish_to_groups) em abril/2024. ' +
  'A Pages API cobre apenas publicação na própria Página (POST /{page-id}/feed), ' +
  'não em grupos do Facebook consumer.';

function carregarPaginas() {
  const cfg = readJson(PAGINAS_FILE, { paginas: [] });
  const map = {};
  for (const p of cfg.paginas || []) {
    if (p && p.id) map[p.id] = p;
  }
  return map;
}

function carregarGruposConfig() {
  const cfg = readJson(GRUPOS_FILE, { grupos: [] });
  const map = {};
  for (const g of cfg.grupos || []) {
    if (g && g.id) map[g.id] = g;
  }
  return map;
}

function resolverToken(pagina) {
  if (!pagina) return { token: '', fonte: null };
  const envName = pagina.token_env || 'FACEBOOK_PAGE_ACCESS_TOKEN';
  const token = process.env[envName] || process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '';
  return { token, fonte: envName };
}

function montarMensagem(item) {
  const oferta = item.oferta || {};
  if (item.texto) return item.texto;
  return [
    '🔥 OFERTA DO DIA',
    '',
    oferta.titulo || '',
    '',
    `💰 ${oferta.preco_formatado || oferta.preco || ''}`,
    '',
    '🛍️ Confira na Shopee:',
    oferta.link || '',
  ].join('\n');
}

/**
 * Publicação Página→Grupo no Facebook consumer não é suportada
 * pela Graph API pública atual. Não chama endpoints inventados.
 */
async function tentarPublicarNoGrupo(/* contexto */) {
  return {
    ok: false,
    status: 'api_indisponivel',
    erro: MSG_API_INDISPONIVEL,
  };
}

async function publicarSelecoes({ dryRun = !PUBLICAR } = {}) {
  console.log('=== PUBLICADOR (opção C — Página / Graph API) ===');
  console.log(`Modo: ${dryRun ? 'DRY-RUN (não publica de verdade)' : 'PUBLICAR=true'}`);
  console.log('Escopo oficial Pages API: POST /{page-id}/feed (na Página).');
  console.log('Cenário Página→Grupo (Facebook consumer): sem endpoint oficial documentado.');

  const selecao = readJson(SELECAO_FILE);
  const paginas = carregarPaginas();
  const gruposCfg = carregarGruposConfig();

  if (!selecao || !Array.isArray(selecao.selecoes) || selecao.selecoes.length === 0) {
    console.log('Nenhuma seleção em data/selecao-atual.json.');
    const vazio = {
      gerado_em: nowIso(),
      modo: dryRun ? 'dry-run' : 'real',
      total: 0,
      resultados: [],
      nota: MSG_API_INDISPONIVEL,
    };
    writeJson(RESULTADO_FILE, vazio);
    return vazio;
  }

  const resultados = [];

  for (const item of selecao.selecoes) {
    const grupoSel = item.grupo || {};
    const oferta = item.oferta || {};
    const grupoIdInterno = grupoSel.id;
    const cfgGrupo = gruposCfg[grupoIdInterno] || {};
    const groupId = grupoSel.group_id || cfgGrupo.group_id || '';
    const paginaKey = cfgGrupo.pagina_id || grupoSel.pagina_id || 'pagina-principal';
    const pagina = paginas[paginaKey] || null;
    const { token, fonte } = resolverToken(pagina);
    const message = montarMensagem(item);

    const entrada = {
      grupo_id_interno: grupoIdInterno,
      grupo_nome: grupoSel.nome || cfgGrupo.nome,
      group_id: groupId || null,
      pagina_config_id: paginaKey,
      pagina_nome: pagina ? pagina.nome : null,
      page_id: pagina && pagina.page_id ? pagina.page_id : null,
      token_env: fonte,
      token_presente: Boolean(token),
      oferta_id: oferta.id,
      titulo: oferta.titulo,
      link: oferta.link,
      imagem: oferta.imagem || null,
      nicho: oferta.nicho,
      status: 'pendente',
    };

    if (!groupId) {
      entrada.status = 'ignorado';
      entrada.erro = 'group_id vazio';
      resultados.push(entrada);
      console.log(`⏭  ${entrada.grupo_nome}: sem group_id`);
      continue;
    }

    if (jaPublicadoRecentemente(grupoIdInterno, oferta)) {
      entrada.status = 'ignorado';
      entrada.erro = 'já publicado recentemente (histórico 7 dias)';
      resultados.push(entrada);
      console.log(`⏭  ${entrada.grupo_nome}: já no histórico recente`);
      continue;
    }

    if (dryRun) {
      entrada.status = 'dry-run';
      entrada.preview = {
        group_id: groupId,
        page_id: entrada.page_id,
        message_preview: message.slice(0, 140) + (message.length > 140 ? '…' : ''),
        imagem: oferta.imagem || null,
        link: oferta.link || null,
      };
      entrada.limitacao_api = MSG_API_INDISPONIVEL;
      resultados.push(entrada);
      console.log(
        `🔍 DRY-RUN → ${entrada.grupo_nome} (${groupId}) / Página=${paginaKey} ` +
          `token=${entrada.token_presente ? 'ok' : 'ausente'}: ${(oferta.titulo || '').slice(0, 48)}…`
      );
      console.log(`   ⚠ ${MSG_API_INDISPONIVEL.slice(0, 90)}…`);
      continue;
    }

    // PUBLICAR=true: não inventa chamada a endpoint de grupo sem suporte oficial
    const tentativa = await tentarPublicarNoGrupo({
      groupId,
      pageId: entrada.page_id,
      token,
      message,
      link: oferta.link,
      imageUrl: oferta.imagem,
    });

    entrada.status = tentativa.status;
    entrada.erro = tentativa.erro || null;
    // NÃO chama registrarPublicacao — não houve sucesso real
    resultados.push(entrada);
    console.log(`⛔ ${entrada.grupo_nome}: ${entrada.status} — ${entrada.erro}`);
  }

  const payload = {
    gerado_em: nowIso(),
    modo: dryRun ? 'dry-run' : 'real',
    total: resultados.length,
    publicados: resultados.filter((r) => r.status === 'publicado').length,
    api_indisponivel: resultados.filter((r) => r.status === 'api_indisponivel').length,
    erros: resultados.filter((r) => r.status === 'erro').length,
    resultados,
    nota: MSG_API_INDISPONIVEL,
    referencia:
      'Pages API: https://developers.facebook.com/docs/pages-api — publicação em /{page-id}/feed. ' +
      'Groups API removida: changelog Graph API v19.0 (abril/2024).',
  };

  writeJson(RESULTADO_FILE, payload);
  console.log(`Resultado → ${RESULTADO_FILE}`);
  console.log(
    `Publicados: ${payload.publicados} | API indisponível: ${payload.api_indisponivel} | Total: ${payload.total}`
  );
  return payload;
}

if (require.main === module) {
  publicarSelecoes()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Publicador falhou:', err.message);
      process.exit(1);
    });
}

module.exports = {
  publicarSelecoes,
  tentarPublicarNoGrupo,
  MSG_API_INDISPONIVEL,
};
