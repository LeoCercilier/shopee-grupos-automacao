'use strict';

/**
 * Conversão de links Shopee → afiliado via interface web (Playwright).
 * Dry-run: não altera fila/cache; não persiste resultado operacional.
 */

const path = require('path');
const { writeJson, nowIso } = require('../utils');
const WebSocket = require('ws');
const {
  obterPaginaCustomLink,
  executarLote: executarLoteCDP,
} = require('./conversor-cdp');
const { buscar, registrarConvertido, listarConvertidos } = require('./cache');
const {
  listarPendentes,
  enfileirar,
  marcarConvertido,
  marcarEmProcessamento,
  marcarErro,
  devolverParaPendente,
  devolverLotePendente,
  recuperarAbandonados,
  carregarFila,
} = require('./fila');
const { normalizarUrl } = require('./identidade');
const { coletarPendentes } = require('./processar-lotes');
const {
  capturarEvidencia,
  localizarCampoLinks,
  diagnosticarCamposLinks,
  localizarBotaoConverter,
  lerResultadosDoDom,
} = require('./conversor-dom');

const ROOT = path.join(__dirname, '..', '..');
const RESULTADO_FILE = path.join(ROOT, 'data', 'resultado-conversao-navegador.json');

const LOTE_SIZE = Math.min(
  5,
  Math.max(1, Number.parseInt(process.env.AFILIADOS_LOTE_SIZE || '5', 10) || 5)
);

const DRY_RUN =
  String(process.env.SHOPEE_CONVERSAO_DRY_RUN || process.env.BROWSER_DRY_RUN || 'false').toLowerCase() ===
  'true';

const SHOPEE_URL = String(process.env.SHOPEE_CONVERSAO_URL || '').trim();

const STATUS_FALHA_GLOBAL = new Set([
  'erro_config',
  'erro_sessao',
  'bloqueio',
  'erro',
  'campo_links_nao_encontrado',
  'botao_converter_nao_encontrado',
  'falha_interface',
  'falha_navegacao',
]);

const MOTIVOS_FALHA_ESTRUTURAL = new Set([
  'campo_links_nao_encontrado',
  'botao_converter_nao_encontrado',
  'falha_interface',
  'falha_navegacao',
]);

function exigirUrlConversao() {
  if (!SHOPEE_URL) {
    throw new Error(
      'SHOPEE_CONVERSAO_URL não definida. Configure a URL da página Link de Conversão / Link personalizado do Portal.'
    );
  }
  try {
    new URL(SHOPEE_URL);
  } catch (_) {
    throw new Error('SHOPEE_CONVERSAO_URL inválida: ' + SHOPEE_URL);
  }
}

function isFalhaGlobal(status) {
  return STATUS_FALHA_GLOBAL.has(String(status || ''));
}

function persistirResultado(obj) {
  if (DRY_RUN) return;
  writeJson(RESULTADO_FILE, obj);
}

async function converterPendentes({ incluirClassificadas = false } = {}) {
  console.log('');
  console.log('=== CONVERSÃO SHOPEE (NAVEGADOR) ===');
  console.log('Dry-run:', DRY_RUN);
  console.log('Lote size:', LOTE_SIZE);

  try {
    exigirUrlConversao();
  } catch (err) {
    const r = { gerado_em: nowIso(), status: 'erro_config', erro: err.message, dry_run: DRY_RUN };
    persistirResultado(r);
    console.log('❌', err.message);
    return r;
  }
  console.log('URL:', SHOPEE_URL);

  if (!DRY_RUN) {
    const rec = recuperarAbandonados();
    if (rec.recuperados.length) {
      console.log('Recuperados de em_processamento (timeout ' + rec.timeoutMin + 'min): ' + rec.recuperados.length);
    }
    const pendentesColeta = coletarPendentes({ incluirClassificadas });
    for (const p of pendentesColeta) {
      enfileirar(
        { id: p.produto_id, link: p.link_original, titulo: p.titulo },
        'conversor-navegador'
      );
    }
  }

  const vistoUrl = new Set();
  let filaPendentes = listarPendentes().filter((i) => i.link_original);
  if (DRY_RUN && filaPendentes.length === 0) {
    filaPendentes = coletarPendentes({ incluirClassificadas }).map((p) => ({
      chave: p.chave,
      produto_id: p.produto_id,
      titulo: p.titulo,
      link_original: p.link_original,
      status: 'pendente',
    }));
  }
  filaPendentes = filaPendentes.filter((i) => {
    const n = normalizarUrl(i.link_original) || i.link_original;
    if (vistoUrl.has(n)) return false;
    if (buscar({ id: i.produto_id, link: i.link_original })) return false;
    vistoUrl.add(n);
    return true;
  });

  console.log('Pendentes:', filaPendentes.length);
  console.log('Já convertidos (cache):', listarConvertidos().length);

  if (filaPendentes.length === 0) {
    const r = {
      gerado_em: nowIso(),
      status: 'nada_a_converter',
      pendentes: 0,
      convertidos: 0,
      dry_run: DRY_RUN,
    };
    persistirResultado(r);
    console.log('Nenhum link pendente. Shopee não será aberta.');
    return r;
  }

  const lotes = [];
  for (let i = 0; i < filaPendentes.length; i += LOTE_SIZE) {
    lotes.push(filaPendentes.slice(i, i + LOTE_SIZE));
  }

  const resumo = {
    gerado_em: nowIso(),
    dry_run: DRY_RUN,
    total_pendentes: filaPendentes.length,
    total_lotes: lotes.length,
    convertidos: 0,
    erros: 0,
    ambiguos: 0,
    lotes: [],
  };

  let ws;
  try {
    const pagina = await obterPaginaCustomLink();

    console.log('Aba Shopee Custom Link encontrada:');
    console.log('  ' + pagina.url);

    ws = new WebSocket(pagina.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    console.log('✅ Conexão CDP estabelecida com o Chromium existente.');

    for (let li = 0; li < lotes.length; li++) {
      const lote = lotes[li];
      console.log('');
      console.log('Lote: ' + (li + 1) + '/' + lotes.length);
      console.log('URLs enviadas: ' + lote.length);

      if (!DRY_RUN) {
        for (const item of lote) marcarEmProcessamento(item.chave);
      }

      const resultadoLote = await executarLoteCDP(ws, lote);

      if (resultadoLote.dry_run) {
        resumo.lotes.push({
          indice: li + 1,
          status: 'dry-run',
          enviados: lote.length,
          motivo: resultadoLote.motivo,
          diagnostico: resultadoLote.diagnostico,
        });
        console.log('🔍 DRY-RUN não destrutivo — fila/cache intactos; Converter não clicado');
        break;
      }

      if (!resultadoLote.ok) {
        const motivo = resultadoLote.motivo || 'erro_lote';
        const motivoTexto = String(motivo);

        const estrutural =
          MOTIVOS_FALHA_ESTRUTURAL.has(motivoTexto) ||
          /bloqueio|login|captcha|checkpoint|pagina_custom_link|campo_links|botao_obter_link|falha_preenchimento/i.test(
            motivoTexto
          );

        if (estrutural) {
          if (!DRY_RUN) devolverLotePendente(lote, motivo);

          resumo.status = MOTIVOS_FALHA_ESTRUTURAL.has(motivoTexto)
            ? motivoTexto
            : 'bloqueio';

          resumo.erro = motivo;

          resumo.lotes.push({
            indice: li + 1,
            status: 'falha_global',
            motivo,
            detalhes: resultadoLote.detalhes,
            diagnostico: resultadoLote.diagnostico,
          });

          console.log('❌ Falha estrutural/global:', motivo);
          console.log('Itens devolvidos para pendente.');
          break;
        }

        if (!DRY_RUN) devolverLotePendente(lote, motivo);

        resumo.ambiguos += lote.length;

        resumo.lotes.push({
          indice: li + 1,
          status: 'matching_ambiguo',
          motivo,
          detalhes: resultadoLote.detalhes,
          diagnostico: resultadoLote.diagnostico,
        });

        console.log('❌ Lote sem correspondência segura:', motivo);
        continue;
      }

      const convertidosLote = resultadoLote.conversoes || [];

      resumo.convertidos += convertidosLote.length;

      resumo.lotes.push({
        indice: li + 1,
        status: 'ok',
        metodo: 'cdp-local',
        detalhes: resultadoLote.detalhes,
        gravados: convertidosLote.length,
        falhas: 0,
        itens: convertidosLote,
      });

      console.log('Conversões confirmadas: ' + convertidosLote.length);
      console.log('Matching seguro: ' + convertidosLote.length + '/' + lote.length);
    }

    if (DRY_RUN) {
      resumo.status = 'dry_run';
      console.log('');
      console.log('✅ Teste não destrutivo concluído (dry-run). Nenhuma conversão gravada.');
    } else {
      resumo.status = resumo.status || 'concluido';
    }

    persistirResultado(resumo);
    if (DRY_RUN) {
      console.log('(dry-run) resultado NÃO persistido em data/resultado-conversao-navegador.json');
    }
    console.log('');
    console.log('Resumo conversão:', {
      status: resumo.status,
      convertidos: resumo.convertidos,
      erros: resumo.erros,
      ambiguos: resumo.ambiguos,
      dry_run: DRY_RUN,
    });
    if (ws) {
      ws.close();
    }
    return resumo;
  } catch (err) {
    if (ws) {
      ws.close();
    }
    if (!DRY_RUN) {
      try {
        for (const it of carregarFila().itens) {
          if (it.status === 'em_processamento') {
            devolverParaPendente(it.chave, err.message);
          }
        }
      } catch (_) {}
    }
    const r = { gerado_em: nowIso(), status: 'erro', erro: err.message, dry_run: DRY_RUN };
    persistirResultado(r);
    console.error('❌ Conversão Shopee falhou:', err.message);
    return r;
  }
}

if (require.main === module) {
  const incluirClassificadas = process.argv.includes('--todas');
  converterPendentes({ incluirClassificadas })
    .then((r) => {
      process.exit(isFalhaGlobal(r.status) ? 1 : 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = {
  converterPendentes,
  LOTE_SIZE,
  isFalhaGlobal,
  STATUS_FALHA_GLOBAL,
  DRY_RUN,
};
