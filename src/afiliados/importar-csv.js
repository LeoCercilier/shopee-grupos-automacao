'use strict';

/**
 * Importa CSV gerado pelo Portal de Afiliados Shopee.
 *
 * Colunas documentadas (Help BR / outros mercados):
 * - "Offer Link" (confirmado na Central de Ajuda BR)
 * - "Trackable Link" (outros mercados — também aceito)
 *
 * Matching prioritário:
 * 1. produto_id / item id em colunas conhecidas
 * 2. URL original normalizada
 * 3. Ambíguo → erro, não publica
 */

const fs = require('fs');
const path = require('path');
const { nowIso } = require('../utils');
const { registrarConvertido } = require('./cache');
const { marcarConvertido, marcarErro, carregarFila } = require('./fila');
const { chaveProduto, normalizarUrl, extrairIdsDeUrl } = require('./identidade');

function parseCsv(texto) {
  const lines = String(texto)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const splitLine = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (q && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = !q;
      } else if (c === ',' && !q) {
        out.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    out.push(cur.trim());
    return out;
  };

  const headers = splitLine(lines[0]).map((h) => h.replace(/^"|"$/g, '').trim());
  const rows = lines.slice(1).map((line) => {
    const cols = splitLine(line).map((c) => c.replace(/^"|"$/g, '').trim());
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = cols[i] != null ? cols[i] : '';
    });
    return obj;
  });
  return { headers, rows };
}

function pick(row, names) {
  const keys = Object.keys(row);
  for (const name of names) {
    const found = keys.find((k) => k.toLowerCase() === name.toLowerCase());
    if (found && row[found]) return row[found];
  }
  for (const name of names) {
    const found = keys.find((k) => k.toLowerCase().includes(name.toLowerCase()));
    if (found && row[found]) return row[found];
  }
  return '';
}

function importarArquivo(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Arquivo não encontrado: ${csvPath}`);
  }
  const raw = fs.readFileSync(csvPath, 'utf8');
  const { headers, rows } = parseCsv(raw);
  console.log('Colunas CSV:', headers.join(' | ') || '(vazio)');

  const fila = carregarFila();
  const resultados = {
    gerado_em: nowIso(),
    arquivo: csvPath,
    total_linhas: rows.length,
    convertidos: 0,
    ambiguos: 0,
    sem_match: 0,
    erros: 0,
    detalhes: [],
  };

  for (const row of rows) {
    const offerLink =
      pick(row, ['Offer Link', 'Trackable Link', 'offer_link', 'Affiliate Link', 'Link']) || '';
    const originalHint =
      pick(row, [
        'Original Link',
        'Product Link',
        'Product URL',
        'URL',
        'Link Original',
        'Shopee Link',
      ]) || '';
    const itemId =
      pick(row, ['Item ID', 'itemid', 'ItemId', 'Product ID', 'product_id', 'ItemId']) || '';
    const shopId = pick(row, ['Shop ID', 'shopid', 'ShopId']) || '';

    if (!offerLink || !/^https?:\/\//i.test(offerLink)) {
      resultados.erros++;
      resultados.detalhes.push({ status: 'erro', motivo: 'offer_link_invalido', row });
      continue;
    }

    let candidatos = [];
    if (itemId) {
      const chaveId = `id:${itemId}`;
      const chaveItem = shopId ? `item:${shopId}.${itemId}` : `item:${itemId}`;
      candidatos = fila.itens.filter(
        (i) =>
          i.chave === chaveId ||
          i.chave === chaveItem ||
          String(i.produto_id) === String(itemId)
      );
    }
    if (candidatos.length === 0 && originalHint) {
      const norm = normalizarUrl(originalHint);
      candidatos = fila.itens.filter((i) => i.link_original_norm === norm);
    }
    if (candidatos.length === 0) {
      const ids = extrairIdsDeUrl(offerLink);
      if (ids.itemId) {
        candidatos = fila.itens.filter(
          (i) =>
            String(i.produto_id) === String(ids.itemId) ||
            i.chave === `id:${ids.itemId}` ||
            (ids.shopId && i.chave === `item:${ids.shopId}.${ids.itemId}`)
        );
      }
    }

    if (candidatos.length === 0 && originalHint) {
      candidatos = fila.itens.filter(
        (i) =>
          i.link_original === originalHint ||
          i.link_original_norm === normalizarUrl(originalHint)
      );
    }

    if (candidatos.length === 0) {
      resultados.sem_match++;
      resultados.detalhes.push({
        status: 'sem_match',
        offerLink,
        itemId,
        originalHint,
      });
      continue;
    }

    if (candidatos.length > 1) {
      const chaves = new Set(candidatos.map((c) => c.chave));
      if (chaves.size > 1) {
        resultados.ambiguos++;
        resultados.detalhes.push({
          status: 'ambiguo',
          offerLink,
          chaves: [...chaves],
        });
        candidatos.forEach((c) => marcarErro(c.chave, 'matching_ambiguo_csv'));
        continue;
      }
    }

    const alvo = candidatos[0];
    const oferta = {
      id: alvo.produto_id,
      link: alvo.link_original,
      titulo: alvo.titulo,
    };
    try {
      registrarConvertido(oferta, offerLink, {
        origem: 'csv-portal',
        sub_id: pick(row, ['Sub_id', 'Sub ID', 'sub_id']) || null,
      });
      marcarConvertido(alvo.chave, offerLink);
      resultados.convertidos++;
      resultados.detalhes.push({
        status: 'convertido',
        chave: alvo.chave,
        offerLink,
      });
    } catch (err) {
      resultados.erros++;
      marcarErro(alvo.chave, err.message);
      resultados.detalhes.push({ status: 'erro', chave: alvo.chave, erro: err.message });
    }
  }

  console.log(
    `Import CSV: convertidos=${resultados.convertidos} sem_match=${resultados.sem_match} ambiguos=${resultados.ambiguos} erros=${resultados.erros}`
  );
  return resultados;
}

if (require.main === module) {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Uso: node src/afiliados/importar-csv.js <caminho.csv>');
    process.exit(1);
  }
  try {
    const r = importarArquivo(path.resolve(csvPath));
    console.log(JSON.stringify({ ...r, detalhes: r.detalhes.slice(0, 20) }, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
}

module.exports = { importarArquivo, parseCsv };
