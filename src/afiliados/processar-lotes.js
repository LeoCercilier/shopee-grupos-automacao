'use strict';

/**
 * Organiza URLs Shopee pendentes em lotes de no máximo 5,
 * prontos para conversão manual no Portal de Afiliados (Link de Conversão).
 *
 * Não converte automaticamente, não faz login na Shopee, não altera o publicador.
 *
 * Fontes de pendentes:
 * 1. data/fila-links-afiliados.json (status pendente)
 * 2. data/selecao-atual.json (ofertas sem cache convertido)
 * 3. data/ofertas-classificadas.json (opcional, via --todas)
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, nowIso, ensureDir } = require('../utils');
const { listarPendentes, enfileirar } = require('./fila');
const { buscar, listarConvertidos } = require('./cache');
const { chaveProduto, normalizarUrl } = require('./identidade');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'data', 'exports');
const SELECAO_FILE = path.join(ROOT, 'data', 'selecao-atual.json');
const CLASS_FILE = path.join(ROOT, 'data', 'ofertas-classificadas.json');
const MANIFEST_FILE = path.join(OUT_DIR, 'lotes-manifesto.json');

const LOTE_SIZE = Math.min(
  5,
  Math.max(1, Number.parseInt(process.env.AFILIADOS_LOTE_SIZE || '5', 10) || 5)
);

function pareceUrlShopee(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url.trim());
    if (!/^https?:$/i.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    return (
      h === 'shopee.com.br' ||
      h.endsWith('.shopee.com.br') ||
      h === 's.shopee.com.br' ||
      h === 'shope.ee' ||
      h.endsWith('.shope.ee')
    );
  } catch (_) {
    return false;
  }
}

function coletarPendentes({ incluirClassificadas = false } = {}) {
  const mapa = new Map();

  const add = (oferta, origem) => {
    if (!oferta || !oferta.link) return;
    if (!pareceUrlShopee(oferta.link)) return;
    if (buscar(oferta)) return;
    const chave = chaveProduto(oferta);
    if (!chave) return;
    if (mapa.has(chave)) return;
    mapa.set(chave, {
      chave,
      produto_id: oferta.id ? String(oferta.id) : null,
      titulo: oferta.titulo || oferta.nome || '',
      link_original: String(oferta.link).trim(),
      link_original_norm: normalizarUrl(oferta.link),
      origem,
    });
  };

  for (const item of listarPendentes()) {
    add(
      {
        id: item.produto_id,
        link: item.link_original,
        titulo: item.titulo,
      },
      'fila'
    );
  }

  const selecao = readJson(SELECAO_FILE, { selecoes: [] });
  for (const item of selecao.selecoes || []) {
    add(item.oferta || {}, 'selecao');
  }

  if (incluirClassificadas) {
    const classif = readJson(CLASS_FILE, { ofertas: [] });
    for (const o of classif.ofertas || []) {
      add(o, 'classificadas');
    }
  }

  return [...mapa.values()];
}

function montarLotes(itens, tamanho = LOTE_SIZE) {
  const lotes = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    lotes.push(itens.slice(i, i + tamanho));
  }
  return lotes;
}

function escreverCsvLote(caminho, itens) {
  const header = 'lote,posicao,produto_id,chave,titulo,link_original';
  const lines = [header];
  itens.forEach((item, idx) => {
    const titulo = String(item.titulo || '')
      .replace(/"/g, '""')
      .replace(/\r?\n/g, ' ');
    lines.push(
      [
        item.lote_id,
        idx + 1,
        item.produto_id || '',
        item.chave,
        `"${titulo}"`,
        item.link_original,
      ].join(',')
    );
  });
  fs.writeFileSync(caminho, lines.join('\n') + '\n', 'utf8');
}

function escreverTxtLote(caminho, itens) {
  const corpo = itens.map((i) => i.link_original).join('\n') + '\n';
  fs.writeFileSync(caminho, corpo, 'utf8');
}

function processar({ incluirClassificadas = false, enfileirarNovos = true } = {}) {
  console.log('');
  console.log('=== PROCESSAMENTO DE LINKS AFILIADOS ===');
  console.log('');

  const convertidos = listarConvertidos();
  const pendentes = coletarPendentes({ incluirClassificadas });

  if (enfileirarNovos) {
    for (const p of pendentes) {
      enfileirar(
        {
          id: p.produto_id,
          link: p.link_original,
          titulo: p.titulo,
        },
        'processar-lotes'
      );
    }
  }

  const lotes = montarLotes(pendentes, LOTE_SIZE);

  ensureDir(OUT_DIR);

  for (const nome of fs.readdirSync(OUT_DIR)) {
    if (/^lote-\d{3}\.(csv|txt)$/i.test(nome)) {
      fs.unlinkSync(path.join(OUT_DIR, nome));
    }
  }

  const lotesMeta = [];

  lotes.forEach((itens, i) => {
    const num = String(i + 1).padStart(3, '0');
    const loteId = `lote-${num}`;
    const comMeta = itens.map((item) => ({ ...item, lote_id: loteId }));

    const csvPath = path.join(OUT_DIR, `${loteId}.csv`);
    const txtPath = path.join(OUT_DIR, `${loteId}.txt`);
    escreverCsvLote(csvPath, comMeta);
    escreverTxtLote(txtPath, comMeta);

    lotesMeta.push({
      lote_id: loteId,
      total: comMeta.length,
      arquivos: {
        csv: path.relative(ROOT, csvPath),
        txt: path.relative(ROOT, txtPath),
      },
      itens: comMeta.map((x) => ({
        chave: x.chave,
        produto_id: x.produto_id,
        titulo: x.titulo,
        link_original: x.link_original,
        origem: x.origem,
      })),
    });

    console.log(`Lote ${i + 1}: ${comMeta.length} URL(s)`);
  });

  const manifesto = {
    gerado_em: nowIso(),
    lote_size: LOTE_SIZE,
    convertidos_no_cache: convertidos.length,
    pendentes_encontrados: pendentes.length,
    total_lotes: lotes.length,
    instrucoes: [
      '1. Abra a Plataforma de Afiliados Shopee (App ou Web).',
      '2. Use Link de Conversão e cole o conteúdo de cada lote-XXX.txt (máx. 5 URLs).',
      '3. Converta e baixe/salve o resultado oficial.',
      '4. Coloque o CSV em data/imports/ e rode: npm run afiliados:importar-csv -- data/imports/seu.csv',
      '5. O publicador só posta ofertas com status convertido no cache (EXIGIR_LINK_AFILIADO=true).',
    ],
    lotes: lotesMeta,
  };

  writeJson(MANIFEST_FILE, manifesto);

  const indexPath = path.join(OUT_DIR, 'lotes-urls-por-lote.txt');
  const indexLines = lotesMeta.map(
    (l) =>
      `# ${l.lote_id} (${l.total})\n` +
      l.itens.map((i) => i.link_original).join('\n')
  );
  fs.writeFileSync(indexPath, indexLines.join('\n\n') + '\n', 'utf8');

  console.log('');
  console.log(`Pendentes encontrados: ${pendentes.length}`);
  console.log(`Já convertidos (cache): ${convertidos.length}`);
  console.log(`Novos links para processar: ${pendentes.length}`);
  console.log(`Total de lotes: ${lotes.length}`);
  console.log('');
  console.log('Arquivos gerados:');
  for (const l of lotesMeta) {
    console.log(`  ${l.arquivos.csv}`);
    console.log(`  ${l.arquivos.txt}`);
  }
  console.log(`  ${path.relative(ROOT, MANIFEST_FILE)}`);
  console.log(`  ${path.relative(ROOT, indexPath)}`);
  console.log('');

  const maxNoLote = Math.max(0, ...lotesMeta.map((l) => l.total));
  if (maxNoLote > LOTE_SIZE) {
    throw new Error(`Lote excedeu tamanho máximo: ${maxNoLote} > ${LOTE_SIZE}`);
  }

  const vistas = new Set();
  for (const l of lotesMeta) {
    for (const item of l.itens) {
      if (vistas.has(item.chave)) {
        throw new Error(`URL/chave duplicada entre lotes: ${item.chave}`);
      }
      vistas.add(item.chave);
      if (buscar({ id: item.produto_id, link: item.link_original })) {
        throw new Error(`Item já convertido entrou em lote: ${item.chave}`);
      }
    }
  }

  console.log('Validação: ok (máx. 5 por lote, sem duplicatas, sem já convertidos)');
  console.log('');

  return manifesto;
}

if (require.main === module) {
  const incluirClassificadas =
    process.argv.includes('--todas') ||
    String(process.env.AFILIADOS_INCLUIR_CLASSIFICADAS || '').toLowerCase() ===
      'true';
  try {
    processar({ incluirClassificadas });
    process.exit(0);
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
}

module.exports = {
  processar,
  coletarPendentes,
  montarLotes,
  pareceUrlShopee,
  LOTE_SIZE,
};
