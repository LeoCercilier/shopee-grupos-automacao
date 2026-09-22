'use strict';

const path = require('path');
const { readJson, writeJson, nowIso, daysAgo, productKey } = require('./utils');

const ROOT = path.join(__dirname, '..');
const HIST_FILE = path.join(ROOT, 'data', 'historico-publicacoes.json');
const DIAS_COOLDOWN = 7;

function carregarHistorico() {
  const data = readJson(HIST_FILE, { versao: 1, registros: [] });
  if (!Array.isArray(data.registros)) data.registros = [];
  return data;
}

function salvarHistorico(data) {
  data.atualizado_em = nowIso();
  writeJson(HIST_FILE, data);
}

/**
 * Remove registros mais antigos que o período de retenção (padrão 30 dias).
 */
function limparAntigos(data, diasRetencao = 30) {
  const limite = daysAgo(diasRetencao).getTime();
  data.registros = data.registros.filter((r) => {
    const t = new Date(r.publicado_em || 0).getTime();
    return Number.isFinite(t) && t >= limite;
  });
  return data;
}

/**
 * Verifica se a oferta já foi publicada no grupo nos últimos `dias` dias.
 */
function jaPublicadoRecentemente(grupoId, produto, dias = DIAS_COOLDOWN) {
  const data = carregarHistorico();
  const chave = productKey(produto);
  const limite = daysAgo(dias).getTime();

  return data.registros.some((r) => {
    if (String(r.grupo_id) !== String(grupoId)) return false;
    if (r.produto_chave !== chave && r.link !== produto.link) return false;
    const t = new Date(r.publicado_em || 0).getTime();
    return Number.isFinite(t) && t >= limite;
  });
}

/**
 * Registra uma publicação bem-sucedida (chamar apenas após sucesso real).
 */
function registrarPublicacao(grupoId, produto, meta = {}) {
  const data = carregarHistorico();
  data.registros.push({
    grupo_id: String(grupoId),
    produto_chave: productKey(produto),
    titulo: produto.titulo || produto.nome || '',
    link: produto.link || '',
    nicho: produto.nicho || null,
    publicado_em: nowIso(),
    ...meta,
  });
  limparAntigos(data);
  salvarHistorico(data);
}

module.exports = {
  carregarHistorico,
  salvarHistorico,
  limparAntigos,
  jaPublicadoRecentemente,
  registrarPublicacao,
  DIAS_COOLDOWN,
  HIST_FILE,
};
