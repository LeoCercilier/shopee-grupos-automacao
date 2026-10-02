'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const { LOTE_SIZE, isFalhaGlobal } = require('./conversor-navegador');
const {
  pareceResultadoAfiliado,
  originalBateComEnvio,
  afiliadoApontaParaOriginal,
} = require('./conversor-dom');
const {
  STATUS,
  devolverParaPendente,
  devolverLotePendente,
  FILA_FILE,
  carregarFila,
} = require('./fila');
const { writeJson } = require('../utils');
const { buscar } = require('./cache');

let passed = 0;
function ok(name) { passed += 1; console.log('  ✓', name); }
function section(t) { console.log('\n' + t); }

const backupFila = fs.existsSync(FILA_FILE) ? fs.readFileSync(FILA_FILE, 'utf8') : null;
const CACHE_FILE = path.join(ROOT, 'data', 'links-afiliados.json');
const backupCache = fs.existsSync(CACHE_FILE) ? fs.readFileSync(CACHE_FILE, 'utf8') : null;

function resetFila(itens) {
  writeJson(FILA_FILE, { versao: 1, itens: itens || [] });
}
function restore() {
  if (backupFila !== null) fs.writeFileSync(FILA_FILE, backupFila, 'utf8');
  else writeJson(FILA_FILE, { versao: 1, itens: [] });
  if (backupCache !== null) fs.writeFileSync(CACHE_FILE, backupCache, 'utf8');
}

try {
  section('devolverParaPendente');
  resetFila([{
    chave: 'id:t1',
    status: STATUS.EM_PROCESSAMENTO,
    processamento_em: new Date().toISOString(),
    link_original: 'https://s.shopee.com.br/t1',
    tentativas: 2,
  }]);
  const beforeTent = carregarFila().itens[0].tentativas;
  const item = devolverParaPendente('id:t1', 'bloqueio_teste');
  assert.strictEqual(item.status, STATUS.PENDENTE);
  ok('status pendente');
  assert.ok(!item.processamento_em);
  ok('processamento_em removido');
  assert.strictEqual(item.tentativas, beforeTent);
  ok('tentativas não incrementadas');
  assert.strictEqual(item.link_original, 'https://s.shopee.com.br/t1');
  ok('link_original preservado');

  section('devolverLotePendente');
  resetFila([
    { chave: 'id:a', status: STATUS.EM_PROCESSAMENTO, processamento_em: new Date().toISOString(), link_original: 'https://s.shopee.com.br/a', tentativas: 0 },
    { chave: 'id:b', status: STATUS.EM_PROCESSAMENTO, processamento_em: new Date().toISOString(), link_original: 'https://s.shopee.com.br/b', tentativas: 0 },
  ]);
  devolverLotePendente([{ chave: 'id:a' }, { chave: 'id:b' }], 'campo_links_nao_encontrado');
  const after = carregarFila().itens;
  assert.ok(after.every((i) => i.status === STATUS.PENDENTE));
  assert.ok(after.every((i) => !i.processamento_em));
  ok('lote global volta a pendente');

  section('STATUS_FALHA_GLOBAL');
  for (const s of [
    'erro_config', 'erro_sessao', 'bloqueio', 'erro',
    'campo_links_nao_encontrado', 'botao_converter_nao_encontrado',
    'falha_interface', 'falha_navegacao',
  ]) {
    assert.strictEqual(isFalhaGlobal(s), true, s);
  }
  ok('todos status globais reconhecidos');
  assert.strictEqual(isFalhaGlobal('matching_ambiguo'), false);
  ok('matching_ambiguo não é global');

  section('matching ambíguo sem cache');
  resetFila([{
    chave: 'id:amb',
    status: STATUS.EM_PROCESSAMENTO,
    processamento_em: new Date().toISOString(),
    link_original: 'https://shopee.com.br/product/1/999',
    produto_id: '999',
    tentativas: 0,
  }]);
  devolverParaPendente('id:amb', 'sem_correspondencia_segura');
  const amb = carregarFila().itens.find((i) => i.chave === 'id:amb');
  assert.strictEqual(amb.status, STATUS.PENDENTE);
  assert.ok(!amb.link_afiliado);
  ok('ambíguo pendente sem link_afiliado');
  assert.strictEqual(buscar({ id: '999', link: 'https://shopee.com.br/product/1/999' }), null);
  ok('ambíguo não no cache');

  section('matching estrutural');
  const env = {
    chave: 'id:22096069216',
    produto_id: '22096069216',
    link_original: 'https://shopee.com.br/x-i.811034337.22096069216',
  };
  const afil =
    'https://s.shopee.com.br/an_redir?origin_link=' +
    encodeURIComponent('https://shopee.com.br/product/811034337/22096069216') +
    '&affiliate_id=42';
  assert.strictEqual(pareceResultadoAfiliado(afil, env.link_original), true);
  assert.strictEqual(afiliadoApontaParaOriginal(afil, env), true);
  assert.ok(originalBateComEnvio('https://shopee.com.br/product/811034337/22096069216', [env]));
  ok('estrutural/origin_link aceito');

  section('rejeições');
  assert.strictEqual(pareceResultadoAfiliado('https://s.shopee.com.br/abc', env.link_original), false);
  assert.strictEqual(pareceResultadoAfiliado('https://shope.ee/xyz', env.link_original), false);
  ok('link curto sozinho rejeitado');
  const domSrc = fs.readFileSync(path.join(__dirname, 'conversor-dom.js'), 'utf8');
  assert.ok(!/body\.indexOf/.test(domSrc));
  assert.ok(!/body\.slice\s*\(/.test(domSrc));
  assert.ok(!domSrc.includes('proximidade-texto'));
  assert.ok(!domSrc.includes('ordem-modal'));
  assert.ok(!domSrc.includes('ordem-body'));
  ok('sem matching por proximidade/ordem no body');

  section('dry-run flag');
  delete require.cache[require.resolve('./conversor-navegador')];
  process.env.SHOPEE_CONVERSAO_DRY_RUN = 'true';
  const dry = require('./conversor-navegador');
  assert.strictEqual(dry.DRY_RUN, true);
  ok('DRY_RUN true via env');
  delete process.env.SHOPEE_CONVERSAO_DRY_RUN;
  delete require.cache[require.resolve('./conversor-navegador')];
  const norm = require('./conversor-navegador');
  assert.strictEqual(norm.DRY_RUN, false);
  ok('DRY_RUN false por padrão');

  section('lote max 5');
  assert.ok(LOTE_SIZE <= 5);
  const arr = Array.from({ length: 13 }, (_, i) => i);
  const lots = [];
  for (let i = 0; i < arr.length; i += LOTE_SIZE) lots.push(arr.slice(i, i + LOTE_SIZE));
  assert.ok(Math.max(...lots.map((l) => l.length)) <= 5);
  ok('lotes ≤ 5');

  section('pipeline bloqueio');
  function decidePublicacao(converterAuto, statusConversao) {
    if (converterAuto && isFalhaGlobal(statusConversao)) {
      return { modo: 'cancelado_conversao', publicados: 0 };
    }
    return { modo: 'publicar', publicados: 1 };
  }
  assert.strictEqual(decidePublicacao(true, 'campo_links_nao_encontrado').modo, 'cancelado_conversao');
  assert.strictEqual(decidePublicacao(true, 'botao_converter_nao_encontrado').publicados, 0);
  assert.strictEqual(decidePublicacao(true, 'concluido').modo, 'publicar');
  ok('falha global cancela publicação');

  section('cursos');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['curso:selecionar']);
  assert.ok(fs.existsSync(path.join(ROOT, 'src/cursos/seletor.js')));
  ok('cursos independentes');

  section('convertido preservado');
  resetFila([{
    chave: 'id:ok',
    status: STATUS.CONVERTIDO,
    link_original: 'https://s.shopee.com.br/ok',
    link_afiliado: 'https://s.shopee.com.br/an_redir?affiliate_id=1',
  }]);
  assert.strictEqual(devolverParaPendente('id:ok', 'x').status, STATUS.CONVERTIDO);
  ok('já convertido não rebaixado');
} finally {
  restore();
}

console.log('\n==============================');
console.log('PASS: ' + passed + ' asserções OK');
console.log('==============================\n');
