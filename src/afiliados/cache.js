'use strict';

/**
 * Cache persistente de links afiliados confirmados.
 * Fonte de verdade: importação de CSV do Portal de Afiliados Shopee.
 * NÃO inventa links a partir de product ID + código.
 */

const path = require('path');
const { readJson, writeJson, nowIso } = require('../utils');
const { chaveProduto, normalizarUrl } = require('./identidade');

const ROOT = path.join(__dirname, '..', '..');
const CACHE_FILE = path.join(ROOT, 'data', 'links-afiliados.json');

function carregarCache() {
  const data = readJson(CACHE_FILE, { versao: 1, registros: {} });
  if (!data.registros || typeof data.registros !== 'object') data.registros = {};
  return data;
}

function salvarCache(data) {
  data.atualizado_em = nowIso();
  writeJson(CACHE_FILE, data);
}

function buscar(oferta) {
  const data = carregarCache();
  const chave = chaveProduto(oferta);
  if (chave && data.registros[chave]) {
    const r = data.registros[chave];
    if (r.status === 'convertido' && r.link_afiliado) return { ...r, chave };
  }
  const linkNorm = normalizarUrl(oferta && oferta.link);
  if (linkNorm) {
    for (const [k, r] of Object.entries(data.registros)) {
      if (
        r.status === 'convertido' &&
        r.link_afiliado &&
        normalizarUrl(r.link_original) === linkNorm
      ) {
        return { ...r, chave: k };
      }
    }
  }
  return null;
}

function registrarConvertido(oferta, linkAfiliado, meta = {}) {
  const data = carregarCache();
  const chave = chaveProduto(oferta);
  if (!chave) throw new Error('Não foi possível gerar chave do produto para o cache');
  if (!linkAfiliado || !String(linkAfiliado).startsWith('http')) {
    throw new Error('link_afiliado inválido');
  }

  const afiliadoNorm = normalizarUrl(linkAfiliado);
  const originalNorm = normalizarUrl(oferta && oferta.link);
  if (afiliadoNorm && originalNorm && afiliadoNorm === originalNorm) {
    throw new Error(
      'link_afiliado idêntico ao link original — conversão não confirmada'
    );
  }

  data.registros[chave] = {
    produto_id: oferta.id ? String(oferta.id) : null,
    link_original: oferta.link || null,
    link_original_norm: normalizarUrl(oferta.link),
    link_afiliado: String(linkAfiliado).trim(),
    link_curto: meta.link_curto || null,
    link_longo: meta.link_longo || null,
    sub_id: meta.sub_id || null,
    status: 'convertido',
    data_conversao: nowIso(),
    origem: meta.origem || 'csv-portal',
    ultima_validacao: nowIso(),
    ...meta.extra,
  };
  salvarCache(data);
  return data.registros[chave];
}

function listarConvertidos() {
  const data = carregarCache();
  return Object.entries(data.registros)
    .filter(([, r]) => r.status === 'convertido')
    .map(([chave, r]) => ({ chave, ...r }));
}

module.exports = {
  buscar,
  registrarConvertido,
  listarConvertidos,
  carregarCache,
  CACHE_FILE,
};
