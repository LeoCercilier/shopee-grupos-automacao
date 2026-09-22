'use strict';

const path = require('path');
const { readJson, writeJson, nowIso, formatPrice } = require('./utils');
const { jaPublicadoRecentemente } = require('./historico');

const ROOT = path.join(__dirname, '..');
const CLASS_FILE = path.join(ROOT, 'data', 'ofertas-classificadas.json');
const GRUPOS_FILE = path.join(ROOT, 'config', 'grupos.json');
const OUT_FILE = path.join(ROOT, 'data', 'selecao-atual.json');

function carregarGruposAtivos() {
  const cfg = readJson(GRUPOS_FILE, { grupos: [] });
  return (cfg.grupos || [])
    .filter((g) => g.ativo === true)
    .sort((a, b) => (a.prioridade || 99) - (b.prioridade || 99));
}

function montarTextoPublicacao(oferta) {
  const preco =
    oferta.preco_formatado ||
    formatPrice(oferta.preco) ||
    'Confira o preço';
  return [
    '🔥 OFERTA DO DIA',
    '',
    oferta.titulo,
    '',
    `💰 ${preco}`,
    '',
    '🛍️ Confira na Shopee:',
    oferta.link,
  ].join('\n');
}

/**
 * Seleciona pares (oferta, grupo) elegíveis:
 * - grupo ativo
 * - nicho compatível (ou grupo "geral")
 * - oferta ainda não publicada recentemente naquele grupo
 */
function selecionar({ maxPorGrupo = 1, maxTotal = 8 } = {}) {
  console.log('=== SELETOR OFERTA × GRUPO ===');

  const classificadas = readJson(CLASS_FILE);
  if (!classificadas || !Array.isArray(classificadas.ofertas)) {
    throw new Error(`Arquivo classificado inválido: ${CLASS_FILE}`);
  }

  const grupos = carregarGruposAtivos();
  if (grupos.length === 0) {
    console.warn(
      '⚠️ Nenhum grupo ativo em config/grupos.json. Seleção vazia (esperado até cadastrar grupos).'
    );
  }

  const selecoes = [];
  const usadosPorGrupo = {};

  for (const grupo of grupos) {
    if (selecoes.length >= maxTotal) break;
    usadosPorGrupo[grupo.id] = usadosPorGrupo[grupo.id] || 0;

    const candidatas = classificadas.ofertas.filter((o) => {
      if (grupo.nicho === 'geral') return true;
      return o.nicho === grupo.nicho;
    });

    for (const oferta of candidatas) {
      if (usadosPorGrupo[grupo.id] >= maxPorGrupo) break;
      if (selecoes.length >= maxTotal) break;

      if (jaPublicadoRecentemente(grupo.id, oferta)) {
        continue;
      }

      selecoes.push({
        grupo: {
          id: grupo.id,
          nome: grupo.nome,
          group_id: grupo.group_id || null,
          nicho: grupo.nicho,
        },
        oferta: {
          id: oferta.id,
          titulo: oferta.titulo,
          preco: oferta.preco,
          preco_formatado: oferta.preco_formatado,
          link: oferta.link,
          imagem: oferta.imagem,
          nicho: oferta.nicho,
        },
        texto: montarTextoPublicacao(oferta),
        status: 'pendente',
        selecionado_em: nowIso(),
      });

      usadosPorGrupo[grupo.id] += 1;
    }
  }

  const payload = {
    gerado_em: nowIso(),
    total_selecoes: selecoes.length,
    grupos_ativos: grupos.length,
    selecoes,
    aviso:
      'Publicação automática em grupos NÃO está implementada. Groups API oficial da Meta foi removida em abril/2024.',
  };

  writeJson(OUT_FILE, payload);
  console.log(`✅ ${selecoes.length} seleção(ões) geradas → ${OUT_FILE}`);
  return payload;
}

if (require.main === module) {
  try {
    selecionar();
    process.exit(0);
  } catch (err) {
    console.error('❌ Falha no seletor:', err.message);
    process.exit(1);
  }
}

module.exports = { selecionar, montarTextoPublicacao };
