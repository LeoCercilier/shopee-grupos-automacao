'use strict';

/**
 * Exporta pendentes da fila para conversão manual no Portal Shopee.
 */

const fs = require('fs');
const path = require('path');
const { ensureDir, nowIso, writeJson } = require('../utils');
const { listarPendentes } = require('./fila');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'data', 'exports');

function exportar({ loteSize = 5 } = {}) {
  ensureDir(OUT_DIR);
  const pendentes = listarPendentes();
  const urls = pendentes.map((p) => p.link_original).filter(Boolean);

  const payload = {
    gerado_em: nowIso(),
    total: pendentes.length,
    instrucoes: [
      '1. Abra a Plataforma de Afiliados Shopee (Web ou App).',
      '2. Link de Conversão: até 5 URLs por operação (uma por linha).',
      '3. Ou use Oferta de Produto > selecionar > Obter Link > CSV (coluna Offer Link).',
      '4. Salve o CSV em data/imports/ e rode: npm run afiliados:importar-csv -- data/imports/seu.csv',
      '5. Não publique oferta sem status convertido no cache.',
    ],
    pendentes,
  };

  const jsonPath = path.join(OUT_DIR, 'pendentes-afiliados.json');
  writeJson(jsonPath, payload);

  const txtPath = path.join(OUT_DIR, 'pendentes-urls.txt');
  const lotes = [];
  for (let i = 0; i < urls.length; i += loteSize) {
    lotes.push(urls.slice(i, i + loteSize).join('\n'));
  }
  fs.writeFileSync(
    txtPath,
    `# Lotes de até ${loteSize} URLs (Link de Conversão)\n` +
      `# Separados por ---\n\n` +
      lotes.join('\n\n---\n\n') +
      '\n',
    'utf8'
  );

  console.log(`Pendentes: ${pendentes.length}`);
  console.log(`JSON → ${jsonPath}`);
  console.log(`TXT  → ${txtPath}`);
  return payload;
}

if (require.main === module) {
  exportar();
}

module.exports = { exportar, OUT_DIR };
