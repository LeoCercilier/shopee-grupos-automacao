'use strict';

/**
 * Pipeline principal do projeto.
 * Executa: coletor → classificador → seletor.
 * Não publica em grupos (API oficial indisponível).
 */

const { coletarOfertas } = require('./coletor');
const { executar: classificar } = require('./classificador');
const { selecionar } = require('./seletor');
const { nowIso } = require('./utils');

async function run() {
  console.log('========================================');
  console.log(' PIPELINE SHOPEE GRUPOS AUTOMAÇÃO');
  console.log(` Início: ${nowIso()}`);
  console.log('========================================');

  const coleta = await coletarOfertas();
  console.log(`Coletadas: ${coleta.total}`);

  const classificadas = classificar();
  console.log(`Classificadas: ${classificadas.total}`);

  const selecao = selecionar();
  console.log(`Seleções prontas: ${selecao.total_selecoes}`);

  console.log('----------------------------------------');
  console.log('Pipeline concluído sem publicação em grupos.');
  console.log(
    'Motivo: Facebook Groups API (publish_to_groups) foi removida pela Meta em abril/2024.'
  );
  console.log('O projeto está preparado para receber um mecanismo futuro de publicação.');
  console.log('========================================');

  return {
    coleta_total: coleta.total,
    classificadas_total: classificadas.total,
    selecoes_total: selecao.total_selecoes,
  };
}

if (require.main === module) {
  run()
    .then((r) => {
      console.log('Resumo:', r);
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Pipeline falhou:', err.message);
      process.exit(1);
    });
}

module.exports = { run };
