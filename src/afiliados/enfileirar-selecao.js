'use strict';

/**
 * Percorre data/selecao-atual.json e enfileira ofertas sem link afiliado confirmado.
 */

const path = require('path');
const { readJson, nowIso, writeJson } = require('../utils');
const { resolverLinkAfiliado } = require('./resolver');
const { exportar } = require('./exportar-pendentes');

const ROOT = path.join(__dirname, '..', '..');
const SELECAO_FILE = path.join(ROOT, 'data', 'selecao-atual.json');
const RELATORIO = path.join(ROOT, 'data', 'relatorio-afiliados-selecao.json');

function main() {
  const selecao = readJson(SELECAO_FILE, { selecoes: [] });
  const selecoes = selecao.selecoes || [];
  const rel = {
    gerado_em: nowIso(),
    total: selecoes.length,
    com_afiliado: 0,
    sem_afiliado: 0,
    itens: [],
  };

  for (const item of selecoes) {
    const oferta = item.oferta || {};
    const r = resolverLinkAfiliado(oferta);
    if (r.ok) {
      rel.com_afiliado++;
      rel.itens.push({
        titulo: oferta.titulo,
        status: 'com_afiliado',
        link_afiliado: r.link_afiliado,
      });
    } else {
      rel.sem_afiliado++;
      rel.itens.push({
        titulo: oferta.titulo,
        status: 'sem_afiliado',
        motivo: r.motivo,
        link_original: oferta.link,
      });
    }
  }

  writeJson(RELATORIO, rel);
  exportar();
  console.log(
    `Seleção: ${rel.total} | com afiliado: ${rel.com_afiliado} | sem afiliado (enfileirados): ${rel.sem_afiliado}`
  );
  console.log(`Relatório → ${RELATORIO}`);
  return rel;
}

if (require.main === module) {
  main();
}

module.exports = { main };
