'use strict';

/**
 * Pipeline principal do projeto.
 * Executa: coletor → classificador → seletor → publicador (opcional).
 *
 * Publicação real só ocorre com PUBLICAR=true e FACEBOOK_PAGE_ACCESS_TOKEN.
 * Por padrão o publicador roda em dry-run.
 */

const { coletarOfertas } = require('./coletor');
const { executar: classificar } = require('./classificador');
const { selecionar } = require('./seletor');
const { publicarSelecoes } = require('./publicador');
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

  const publicacao = await publicarSelecoes();
  console.log(
    `Publicação: modo=${publicacao.modo} publicados=${publicacao.publicados || 0} erros=${publicacao.erros || 0}`
  );

  console.log('----------------------------------------');
  if (publicacao.modo === 'dry-run') {
    console.log('Dry-run: nenhum post foi enviado ao Facebook.');
    console.log('Para publicar de verdade: PUBLICAR=true + FACEBOOK_PAGE_ACCESS_TOKEN');
    console.log('(somente em grupos que aceitam postagem da Página)');
  }
  console.log('========================================');

  return {
    coleta_total: coleta.total,
    classificadas_total: classificadas.total,
    selecoes_total: selecao.total_selecoes,
    publicacao_modo: publicacao.modo,
    publicados: publicacao.publicados || 0,
    erros_publicacao: publicacao.erros || 0,
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
