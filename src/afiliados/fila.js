'use strict';

const path = require('path');
const { readJson, writeJson, nowIso } = require('../utils');
const { chaveProduto, normalizarUrl } = require('./identidade');

const ROOT = path.join(__dirname, '..', '..');
const FILA_FILE = path.join(ROOT, 'data', 'fila-links-afiliados.json');

const STATUS = {
  PENDENTE: 'pendente',
  EM_PROCESSAMENTO: 'em_processamento',
  CONVERTIDO: 'convertido',
  ERRO: 'erro',
  IGNORADO: 'ignorado',
};

function carregarFila() {
  const data = readJson(FILA_FILE, { versao: 1, itens: [] });
  if (!Array.isArray(data.itens)) data.itens = [];
  return data;
}

function salvarFila(data) {
  data.atualizado_em = nowIso();
  writeJson(FILA_FILE, data);
}

function enfileirar(oferta, motivo = 'sem_link_afiliado_confirmado') {
  const data = carregarFila();
  const chave = chaveProduto(oferta);
  if (!chave) return { ok: false, motivo: 'chave_invalida' };

  const existente = data.itens.find((i) => i.chave === chave);
  if (existente) {
    if (existente.status === STATUS.CONVERTIDO) {
      return { ok: true, item: existente, ja_existia: true };
    }
    if (existente.status === STATUS.PENDENTE || existente.status === STATUS.EM_PROCESSAMENTO) {
      return { ok: true, item: existente, ja_existia: true };
    }
    existente.status = STATUS.PENDENTE;
    existente.motivo = motivo;
    existente.atualizado_em = nowIso();
    existente.tentativas = (existente.tentativas || 0) + 1;
    salvarFila(data);
    return { ok: true, item: existente, reenfileirado: true };
  }

  const item = {
    chave,
    produto_id: oferta.id ? String(oferta.id) : null,
    titulo: oferta.titulo || oferta.nome || '',
    link_original: oferta.link || '',
    link_original_norm: normalizarUrl(oferta.link),
    status: STATUS.PENDENTE,
    motivo,
    tentativas: 0,
    criado_em: nowIso(),
    atualizado_em: nowIso(),
  };
  data.itens.push(item);
  salvarFila(data);
  return { ok: true, item, ja_existia: false };
}

function marcarConvertido(chave, linkAfiliado) {
  const data = carregarFila();
  const item = data.itens.find((i) => i.chave === chave);
  if (!item) return null;
  item.status = STATUS.CONVERTIDO;
  item.link_afiliado = linkAfiliado;
  item.atualizado_em = nowIso();
  salvarFila(data);
  return item;
}

function marcarEmProcessamento(chave) {
  const data = carregarFila();
  const item = data.itens.find((i) => i.chave === chave);
  if (!item) return null;
  item.status = STATUS.EM_PROCESSAMENTO;
  item.atualizado_em = nowIso();
  salvarFila(data);
  return item;
}

function marcarErro(chave, erro) {
  const data = carregarFila();
  const item = data.itens.find((i) => i.chave === chave);
  if (!item) return null;
  item.status = STATUS.ERRO;
  item.erro = String(erro || '');
  item.atualizado_em = nowIso();
  item.tentativas = (item.tentativas || 0) + 1;
  salvarFila(data);
  return item;
}

function listarPendentes() {
  return carregarFila().itens.filter((i) => i.status === STATUS.PENDENTE);
}

module.exports = {
  FILA_FILE,
  STATUS,
  carregarFila,
  salvarFila,
  enfileirar,
  marcarConvertido,
  marcarEmProcessamento,
  marcarErro,
  listarPendentes,
};
