'use strict';

/**
 * Conversão de links Shopee → afiliado via interface web (Playwright).
 * Dry-run: não altera fila/cache; não persiste resultado operacional.
 */

const path = require('path');
const { writeJson, nowIso } = require('../utils');
const { criarContexto, novaPagina } = require('../navegador/browser');
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
  detectarBloqueioShopee,
  verificarSessaoShopee,
  localizarCampoLinks,
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

async function converterLote(page, itens) {
  const campo = await localizarCampoLinks(page);
  if (!campo) {
    return {
      ok: false,
      motivo: 'campo_links_nao_encontrado',
      screenshot: await capturarEvidencia(page, 'shopee-sem-campo'),
      mensagem: 'Campo de links não encontrado. Verifique SHOPEE_CONVERSAO_URL.',
    };
  }

  await campo.click({ timeout: 5000 }).catch(() => {});
  await campo.fill('').catch(() => {});
  await campo.fill(itens.map((i) => i.link_original).join('\n'));

  const botao = await localizarBotaoConverter(page);

  if (DRY_RUN) {
    return {
      ok: true,
      dryRun: true,
      pares: [],
      campo_ok: true,
      botao_ok: Boolean(botao),
      screenshot: await capturarEvidencia(page, 'shopee-dry-run'),
      mensagem:
        'DRY-RUN não destrutivo: campo preenchido; Converter NÃO clicado; fila/cache NÃO alterados',
    };
  }

  if (!botao) {
    return {
      ok: false,
      motivo: 'botao_converter_nao_encontrado',
      screenshot: await capturarEvidencia(page, 'shopee-sem-botao'),
    };
  }

  await botao.click();
  await page.waitForTimeout(1500);
  await page
    .locator('[role="dialog"], .ant-modal, table, [class*="result"], [class*="success"]')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 })
    .catch(() => {});

  const bloqueio = await detectarBloqueioShopee(page);
  if (bloqueio.bloqueado) {
    return {
      ok: false,
      ...bloqueio,
      screenshot: await capturarEvidencia(page, 'shopee-bloqueio'),
    };
  }

  const leitura = await lerResultadosDoDom(page, itens);
  if (!leitura.ok && (!leitura.pares || leitura.pares.length === 0)) {
    return { ...leitura, screenshot: await capturarEvidencia(page, 'shopee-matching') };
  }

  return {
    ok: true,
    parcial: Boolean(leitura.parcial),
    pares: leitura.pares || [],
    metodo: leitura.metodo,
    detalhes: leitura.detalhes,
    aviso: leitura.aviso || null,
    screenshot: await capturarEvidencia(page, 'shopee-sucesso'),
  };
}

function gravarPares(itens, pares) {
  const mapa = new Map();
  for (const p of pares) {
    if (p.chave) mapa.set('chave:' + p.chave, p);
    mapa.set(normalizarUrl(p.original), p);
    mapa.set(p.original, p);
  }
  const gravados = [];
  const falhas = [];
  for (const item of itens) {
    const par =
      mapa.get('chave:' + item.chave) ||
      mapa.get(item.link_original) ||
      mapa.get(normalizarUrl(item.link_original));
    if (!par || !par.afiliado || !/^https?:\/\//i.test(par.afiliado)) {
      devolverParaPendente(item.chave, 'sem_correspondencia_segura');
      falhas.push({ chave: item.chave, motivo: 'sem_correspondencia_segura' });
      continue;
    }
    try {
      registrarConvertido(
        { id: item.produto_id, link: item.link_original, titulo: item.titulo },
        par.afiliado,
        { origem: 'navegador-shopee', extra: { metodo_matching: par.metodo || 'desconhecido' } }
      );
      marcarConvertido(item.chave, par.afiliado);
      gravados.push({
        chave: item.chave,
        original: item.link_original,
        afiliado: par.afiliado,
        metodo: par.metodo,
      });
    } catch (err) {
      devolverParaPendente(item.chave, err.message);
      falhas.push({ chave: item.chave, motivo: err.message });
    }
  }
  return { gravados, falhas };
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

  let context;
  try {
    context = await criarContexto();
    const page = await novaPagina(context);

    const sessao = await verificarSessaoShopee(page, SHOPEE_URL);
    if (!sessao.ok) {
      resumo.status = 'erro_sessao';
      resumo.erro = sessao.motivo;
      resumo.screenshot = await capturarEvidencia(page, 'shopee-sessao');
      persistirResultado(resumo);
      console.log('❌', sessao.motivo);
      await context.close().catch(() => {});
      return resumo;
    }

    for (let li = 0; li < lotes.length; li++) {
      const lote = lotes[li];
      console.log('');
      console.log('Lote: ' + (li + 1) + '/' + lotes.length);
      console.log('URLs enviadas: ' + lote.length);

      if (!DRY_RUN) {
        for (const item of lote) marcarEmProcessamento(item.chave);
      }

      try {
        await page.goto(SHOPEE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      } catch (navErr) {
        if (!DRY_RUN) devolverLotePendente(lote, navErr.message);
        resumo.status = 'falha_navegacao';
        resumo.erro = navErr.message;
        console.log('❌ Falha de navegação:', navErr.message);
        break;
      }

      const bloqueio = await detectarBloqueioShopee(page);
      if (bloqueio.bloqueado) {
        if (!DRY_RUN) devolverLotePendente(lote, bloqueio.motivo);
        resumo.status = 'bloqueio';
        resumo.erro = bloqueio.motivo;
        resumo.screenshot = await capturarEvidencia(page, 'shopee-bloqueio-lote');
        console.log('⛔', bloqueio.motivo);
        console.log('Itens devolvidos para pendente (falha global).');
        break;
      }

      const resultadoLote = await converterLote(page, lote);

      if (resultadoLote.dryRun) {
        resumo.lotes.push({
          indice: li + 1,
          status: 'dry-run',
          enviados: lote.length,
          campo_ok: resultadoLote.campo_ok,
          botao_ok: resultadoLote.botao_ok,
          screenshot: resultadoLote.screenshot,
        });
        console.log('🔍 DRY-RUN não destrutivo — fila/cache intactos; Converter não clicado');
        break;
      }

      if (!resultadoLote.ok && (!resultadoLote.pares || resultadoLote.pares.length === 0)) {
        const motivo = resultadoLote.motivo || resultadoLote.detalhes || 'erro_lote';
        const estrutural =
          MOTIVOS_FALHA_ESTRUTURAL.has(String(resultadoLote.motivo || '')) ||
          /bloqueio|login|captcha|checkpoint/i.test(String(motivo));

        if (estrutural) {
          if (!DRY_RUN) devolverLotePendente(lote, motivo);
          resumo.status = MOTIVOS_FALHA_ESTRUTURAL.has(String(resultadoLote.motivo || ''))
            ? String(resultadoLote.motivo)
            : 'bloqueio';
          resumo.erro = motivo;
          resumo.lotes.push({
            indice: li + 1,
            status: 'falha_global',
            motivo,
            detalhes: resultadoLote.detalhes,
            screenshot: resultadoLote.screenshot,
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
          screenshot: resultadoLote.screenshot,
        });
        console.log('❌ Lote sem correspondência segura:', motivo);
        continue;
      }

      const { gravados, falhas } = gravarPares(lote, resultadoLote.pares || []);
      resumo.convertidos += gravados.length;
      resumo.erros += falhas.length;
      resumo.ambiguos += falhas.filter((f) => f.motivo === 'sem_correspondencia_segura').length;
      resumo.lotes.push({
        indice: li + 1,
        status: gravados.length ? 'ok' : 'erro',
        metodo: resultadoLote.metodo,
        detalhes: resultadoLote.detalhes,
        gravados: gravados.length,
        falhas: falhas.length,
        itens: gravados,
      });
      console.log('Conversões confirmadas: ' + gravados.length);
      console.log('Matching seguro: ' + gravados.length + '/' + lote.length);
      console.log('Sem correspondência: ' + falhas.length);
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
    await context.close().catch(() => {});
    return resumo;
  } catch (err) {
    if (context) await context.close().catch(() => {});
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
