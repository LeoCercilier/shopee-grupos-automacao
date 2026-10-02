'use strict';

/**
 * Pipeline principal do projeto.
 * Executa: coletor → classificador → seletor → [conversão afiliado] → publicador.
 *
 * Conversão Shopee (navegador): AFILIADOS_CONVERTER=true + SHOPEE_CONVERSAO_URL
 * Publicação navegador: PUBLICADOR=navegador (sessão local .browser-session/)
 */

const { coletarOfertas } = require('./coletor');
const { executar: classificar } = require('./classificador');
const { selecionar } = require('./seletor');
const { publicarSelecoes } = require('./publicador');
const { publicarSelecoesNavegador } = require('./navegador/publicador');
const {
  converterPendentes,
  isFalhaGlobal,
} = require('./afiliados/conversor-navegador');
const { nowIso } = require('./utils');

function usarPublicadorNavegador() {
  return ['navegador', 'browser'].includes(
    String(process.env.PUBLICADOR || '').trim().toLowerCase()
  );
}

async function executarPublicador() {
  if (usarPublicadorNavegador()) {
    const modo = String(
      process.env.MODO_PUBLICACAO_BROWSER || 'preparar'
    ).toLowerCase();

    console.log('=== PUBLICADOR NAVEGADOR (SESSÃO LOCAL) ===');
    console.log('Modo:', modo);

    const resultado = await publicarSelecoesNavegador({
      dryRun:
        String(process.env.BROWSER_DRY_RUN || 'false').toLowerCase() ===
        'true',
    });

    return {
      modo: resultado.modo || modo,
      publicados: Number(resultado.publicados || 0),
      erros: Number(resultado.erros || 0),
      resultado,
    };
  }

  console.log('=== PUBLICADOR GRAPH API ===');
  return publicarSelecoes();
}

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

  let conversao = { status: 'pulado' };
  const converterAuto =
    String(process.env.AFILIADOS_CONVERTER || '').toLowerCase() === 'true' ||
    String(process.env.AFILIADOS_CONVERTER || '').toLowerCase() === '1';

  if (converterAuto) {
    console.log('=== ETAPA CONVERSÃO AFILIADOS (NAVEGADOR) ===');
    conversao = await converterPendentes({
      incluirClassificadas:
        String(process.env.AFILIADOS_INCLUIR_CLASSIFICADAS || '').toLowerCase() ===
        'true',
    });
    console.log(
      `Conversão: status=${conversao.status} convertidos=${conversao.convertidos || 0} erros=${conversao.erros || 0}`
    );
  } else {
    console.log(
      'Conversão Shopee automática desligada (defina AFILIADOS_CONVERTER=true para ativar).'
    );
  }

  let publicacao = { modo: 'pulado', publicados: 0, erros: 0 };

  if (converterAuto && isFalhaGlobal(conversao.status)) {
    console.log('');
    console.log(
      '⛔ Conversão Shopee falhou de forma bloqueante. Publicação Shopee deste ciclo cancelada.'
    );
    console.log(`   Motivo: ${conversao.erro || conversao.status}`);
    console.log('   Itens permanecem pendentes para a próxima tentativa.');
    publicacao = {
      modo: 'cancelado_conversao',
      publicados: 0,
      erros: 0,
      motivo: conversao.erro || conversao.status,
    };
  } else {
    publicacao = await executarPublicador();
  }

  console.log(
    `Publicação: modo=${publicacao.modo} publicados=${publicacao.publicados || 0} erros=${publicacao.erros || 0}`
  );

  console.log('----------------------------------------');
  if (publicacao.modo === 'dry-run') {
    console.log('Dry-run: nenhum post foi enviado ao Facebook.');
  }
  if (publicacao.modo === 'cancelado_conversao') {
    console.log('Publicação Shopee não executada por falha na conversão de afiliados.');
  }
  console.log('========================================');

  return {
    coleta_total: coleta.total,
    classificadas_total: classificadas.total,
    selecoes_total: selecao.total_selecoes,
    conversao_status: conversao.status,
    conversao_convertidos: conversao.convertidos || 0,
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
