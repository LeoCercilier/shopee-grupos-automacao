'use strict';

/**
 * Publicador em grupos do Facebook via Graph API + Page Access Token.
 *
 * Opção C: funciona apenas em grupos que permitem postagem como Página
 * (Página adicionada ao grupo / configuração do grupo permitindo posts de Páginas).
 *
 * NÃO usa publish_to_groups (removida).
 * NÃO usa senha nem sessão de usuário.
 *
 * Controle:
 *   PUBLICAR=true  → tenta publicar de verdade
 *   PUBLICAR=false ou ausente → dry-run (só loga o que faria)
 *
 * Secrets / env:
 *   FACEBOOK_PAGE_ACCESS_TOKEN  (obrigatório para publicação real)
 *   FACEBOOK_GRAPH_VERSION      (opcional, padrão v21.0)
 */

const path = require('path');
const { readJson, writeJson, nowIso } = require('./utils');
const { jaPublicadoRecentemente, registrarPublicacao } = require('./historico');

const ROOT = path.join(__dirname, '..');
const SELECAO_FILE = path.join(ROOT, 'data', 'selecao-atual.json');
const RESULTADO_FILE = path.join(ROOT, 'data', 'resultado-publicacao.json');

const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v21.0';
const PAGE_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '';
const PUBLICAR = String(process.env.PUBLICAR || 'false').toLowerCase() === 'true';

function graphUrl(pathname, params = {}) {
  const u = new URL(`https://graph.facebook.com/${GRAPH_VERSION}${pathname}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function postToGroupFeed(groupId, { message, link, imageUrl }) {
  if (!PAGE_TOKEN) {
    throw new Error('FACEBOOK_PAGE_ACCESS_TOKEN não configurado');
  }
  if (!groupId) {
    throw new Error('group_id ausente');
  }

  // Preferência: post com foto (url) + legenda; fallback: feed com message + link
  if (imageUrl) {
    const body = new URLSearchParams();
    body.set('url', imageUrl);
    body.set('caption', message || '');
    body.set('access_token', PAGE_TOKEN);

    const res = await fetch(
      graphUrl(`/${groupId}/photos`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      // Fallback para /feed se /photos não for aceito no grupo
      const errMsg = data.error?.message || res.statusText || 'erro desconhecido';
      console.warn(`  /photos falhou (${errMsg}). Tentando /feed...`);
    } else {
      return { tipo: 'photo', id: data.id || data.post_id || null, raw: data };
    }
  }

  const body = new URLSearchParams();
  body.set('message', message || '');
  if (link) body.set('link', link);
  body.set('access_token', PAGE_TOKEN);

  const res = await fetch(graphUrl(`/${groupId}/feed`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.message || res.statusText || 'erro desconhecido';
    const code = data.error?.code;
    const err = new Error(msg);
    err.code = code;
    err.raw = data;
    throw err;
  }
  return { tipo: 'feed', id: data.id || null, raw: data };
}

async function publicarSelecoes({ dryRun = !PUBLICAR } = {}) {
  console.log('=== PUBLICADOR (Página → grupos que aceitam Página) ===');
  console.log(`Modo: ${dryRun ? 'DRY-RUN (não publica de verdade)' : 'PUBLICAÇÃO REAL'}`);
  console.log(`Graph: ${GRAPH_VERSION}`);
  console.log(`Token configurado: ${PAGE_TOKEN ? 'sim' : 'não'}`);

  const selecao = readJson(SELECAO_FILE);
  if (!selecao || !Array.isArray(selecao.selecoes) || selecao.selecoes.length === 0) {
    console.log('Nenhuma seleção em data/selecao-atual.json. Nada a publicar.');
    const vazio = {
      gerado_em: nowIso(),
      modo: dryRun ? 'dry-run' : 'real',
      total: 0,
      resultados: [],
    };
    writeJson(RESULTADO_FILE, vazio);
    return vazio;
  }

  const resultados = [];

  for (const item of selecao.selecoes) {
    const grupo = item.grupo || {};
    const oferta = item.oferta || {};
    const groupId = grupo.group_id;
    const entrada = {
      grupo_id_interno: grupo.id,
      grupo_nome: grupo.nome,
      group_id: groupId,
      oferta_id: oferta.id,
      titulo: oferta.titulo,
      link: oferta.link,
      nicho: oferta.nicho,
      status: 'pendente',
    };

    if (!groupId) {
      entrada.status = 'ignorado';
      entrada.erro = 'group_id vazio';
      resultados.push(entrada);
      console.log(`⏭  ${grupo.nome}: sem group_id`);
      continue;
    }

    if (jaPublicadoRecentemente(grupo.id, oferta)) {
      entrada.status = 'ignorado';
      entrada.erro = 'já publicado recentemente (histórico 7 dias)';
      resultados.push(entrada);
      console.log(`⏭  ${grupo.nome}: já no histórico recente`);
      continue;
    }

    const message = item.texto || [
      '🔥 OFERTA DO DIA',
      '',
      oferta.titulo || '',
      '',
      `💰 ${oferta.preco_formatado || oferta.preco || ''}`,
      '',
      '🛍️ Confira na Shopee:',
      oferta.link || '',
    ].join('\n');

    if (dryRun) {
      entrada.status = 'dry-run';
      entrada.preview = {
        group_id: groupId,
        message_preview: message.slice(0, 120) + (message.length > 120 ? '…' : ''),
        imagem: oferta.imagem || null,
        link: oferta.link || null,
      };
      resultados.push(entrada);
      console.log(`🔍 DRY-RUN → grupo ${grupo.nome} (${groupId}): ${oferta.titulo?.slice(0, 50) || ''}…`);
      continue;
    }

    try {
      const pub = await postToGroupFeed(groupId, {
        message,
        link: oferta.link,
        imageUrl: oferta.imagem,
      });
      entrada.status = 'publicado';
      entrada.post_id = pub.id;
      entrada.tipo = pub.tipo;
      entrada.publicado_em = nowIso();

      registrarPublicacao(grupo.id, oferta, {
        post_id: pub.id,
        tipo: pub.tipo,
        group_id: groupId,
      });

      resultados.push(entrada);
      console.log(`✅ Publicado em ${grupo.nome}: ${pub.tipo} id=${pub.id}`);
    } catch (err) {
      entrada.status = 'erro';
      entrada.erro = err.message || String(err);
      entrada.codigo = err.code || null;
      resultados.push(entrada);
      console.error(`❌ Falha em ${grupo.nome}: ${entrada.erro}`);
    }
  }

  const payload = {
    gerado_em: nowIso(),
    modo: dryRun ? 'dry-run' : 'real',
    total: resultados.length,
    publicados: resultados.filter((r) => r.status === 'publicado').length,
    erros: resultados.filter((r) => r.status === 'erro').length,
    resultados,
    nota:
      'Publicação via Page Access Token em /{group-id}/feed ou /photos. ' +
      'Só funciona se o grupo permitir posts da Página. ' +
      'Defina PUBLICAR=true e FACEBOOK_PAGE_ACCESS_TOKEN para publicação real.',
  };

  writeJson(RESULTADO_FILE, payload);
  console.log(`Resultado → ${RESULTADO_FILE}`);
  console.log(`Publicados: ${payload.publicados} | Erros: ${payload.erros} | Total: ${payload.total}`);
  return payload;
}

if (require.main === module) {
  publicarSelecoes()
    .then((r) => {
      process.exit(r.erros > 0 && r.modo === 'real' ? 1 : 0);
    })
    .catch((err) => {
      console.error('❌ Publicador falhou:', err.message);
      process.exit(1);
    });
}

module.exports = { publicarSelecoes, postToGroupFeed };
