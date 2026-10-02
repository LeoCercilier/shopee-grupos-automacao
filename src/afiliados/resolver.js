'use strict';

/**
 * Resolve se uma oferta tem link afiliado CONFIRMADO no cache.
 * Não trata URL da API como afiliada automaticamente.
 */

const { buscar } = require('./cache');
const { enfileirar } = require('./fila');
const { chaveProduto } = require('./identidade');

function resolverLinkAfiliado(oferta) {
  if (!oferta || !oferta.link) {
    return { ok: false, motivo: 'oferta_sem_link' };
  }

  const reg = buscar(oferta);
  if (reg && reg.link_afiliado) {
    return {
      ok: true,
      link_afiliado: reg.link_afiliado,
      registro: reg,
      chave: chaveProduto(oferta),
    };
  }

  enfileirar(oferta, 'sem_link_afiliado_confirmado_no_cache');
  return {
    ok: false,
    motivo: 'sem_link_afiliado_confirmado',
    chave: chaveProduto(oferta),
  };
}

function aplicarLinkNoTexto(texto, linkAntigo, linkNovo) {
  if (!texto || !linkNovo) return texto || '';
  if (linkAntigo && texto.includes(linkAntigo)) {
    return texto.split(linkAntigo).join(linkNovo);
  }
  const linhas = String(texto).split('\n');
  for (let i = linhas.length - 1; i >= 0; i--) {
    if (/^https?:\/\//i.test(linhas[i].trim())) {
      linhas[i] = linkNovo;
      return linhas.join('\n');
    }
  }
  return `${texto}\n${linkNovo}`;
}

module.exports = {
  resolverLinkAfiliado,
  aplicarLinkNoTexto,
};
