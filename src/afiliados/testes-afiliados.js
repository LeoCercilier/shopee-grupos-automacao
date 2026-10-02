'use strict';

/**
 * Testes unitários de afiliados (sem navegador real / sem login Shopee).
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');

const { LOTE_SIZE, isFalhaGlobal } = require('./conversor-navegador');
const {
  pareceResultadoAfiliado,
  extrairIdsDeUrl,
  originalBateComEnvio,
} = require('./conversor-dom');
const { STATUS } = require('./fila');
const { writeJson, readJson } = require('../utils');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log('  ✓', name);
}
function section(t) {
  console.log('\n' + t);
}

section('Lote');
assert.strictEqual(LOTE_SIZE <= 5, true);
ok('LOTE_SIZE <= 5');
const itens12 = Array.from({ length: 12 }, (_, i) => i);
const lotes = [];
for (let i = 0; i < itens12.length; i += LOTE_SIZE) {
  lotes.push(itens12.slice(i, i + LOTE_SIZE));
}
assert.ok(Math.max(...lotes.map((l) => l.length)) <= 5);
ok('divisão em lotes nunca > 5');

section('Matching e reconhecimento de afiliado');
const original = 'https://s.shopee.com.br/abc123';
assert.strictEqual(pareceResultadoAfiliado(original, original), false);
ok('mesma URL original não é resultado afiliado');
assert.strictEqual(
  pareceResultadoAfiliado('https://s.shopee.com.br/xyz', 'https://s.shopee.com.br/abc'),
  false
);
ok('domínio s.shopee sozinho não confirma afiliado');
assert.strictEqual(
  pareceResultadoAfiliado(
    'https://s.shopee.com.br/an_redir?origin_link=https%3A%2F%2Fshopee.com.br%2Fproduct%2F1%2F2&affiliate_id=99',
    original
  ),
  true
);
ok('an_redir + affiliate_id conta como afiliado');
assert.strictEqual(
  pareceResultadoAfiliado('https://shopee.com.br/product/1/2?affiliate_id=99', original),
  true
);
ok('affiliate_id em URL longa conta como afiliado');

const env = {
  chave: 'id:22096069216',
  produto_id: '22096069216',
  link_original: 'https://shopee.com.br/produto-x-i.811034337.22096069216',
};
const ids = extrairIdsDeUrl(env.link_original);
assert.strictEqual(ids.itemId, '22096069216');
assert.strictEqual(ids.shopId, '811034337');
ok('extrairIdsDeUrl shop/item');
const hit = originalBateComEnvio('https://shopee.com.br/product/811034337/22096069216', [env]);
assert.ok(hit && hit.chave === env.chave);
ok('originalBateComEnvio por item ID');
const candidatosFracos = ['https://s.shopee.com.br/foo', 'https://s.shopee.com.br/bar'];
const seguros = candidatosFracos.filter((u) => pareceResultadoAfiliado(u, env.link_original));
assert.strictEqual(seguros.length, 0);
ok('candidatos só com domínio curto → zero associações');

section('Falha global');
assert.strictEqual(isFalhaGlobal('erro_sessao'), true);
assert.strictEqual(isFalhaGlobal('bloqueio'), true);
assert.strictEqual(isFalhaGlobal('erro_config'), true);
assert.strictEqual(isFalhaGlobal('erro'), true);
assert.strictEqual(isFalhaGlobal('concluido'), false);
assert.strictEqual(isFalhaGlobal('nada_a_converter'), false);
assert.strictEqual(isFalhaGlobal('dry_run'), false);
assert.strictEqual(isFalhaGlobal('pulado'), false);
ok('isFalhaGlobal classifica status bloqueantes');

section('Fila: recuperação timeout');
const filaMod = require('./fila');
const FILA_REAL = filaMod.FILA_FILE;
const backup = fs.existsSync(FILA_REAL) ? fs.readFileSync(FILA_REAL, 'utf8') : null;
try {
  const antigo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const recente = new Date(Date.now() - 1 * 60 * 1000).toISOString();
  writeJson(FILA_REAL, {
    versao: 1,
    itens: [
      {
        chave: 'id:old',
        status: STATUS.EM_PROCESSAMENTO,
        processamento_em: antigo,
        atualizado_em: antigo,
        link_original: 'https://s.shopee.com.br/old',
      },
      {
        chave: 'id:new',
        status: STATUS.EM_PROCESSAMENTO,
        processamento_em: recente,
        atualizado_em: recente,
        link_original: 'https://s.shopee.com.br/new',
      },
    ],
  });
  const rec = filaMod.recuperarAbandonados({ timeoutMin: 15 });
  assert.ok(rec.recuperados.includes('id:old'));
  assert.ok(!rec.recuperados.includes('id:new'));
  const after = readJson(FILA_REAL, { itens: [] });
  assert.strictEqual(after.itens.find((i) => i.chave === 'id:old').status, STATUS.PENDENTE);
  assert.strictEqual(
    after.itens.find((i) => i.chave === 'id:new').status,
    STATUS.EM_PROCESSAMENTO
  );
  ok('em_processamento antigo → pendente');
  ok('em_processamento recente permanece');
} finally {
  if (backup !== null) fs.writeFileSync(FILA_REAL, backup, 'utf8');
  else if (fs.existsSync(FILA_REAL))
    fs.writeFileSync(FILA_REAL, JSON.stringify({ versao: 1, itens: [] }), 'utf8');
}

section('Defaults');
assert.notStrictEqual(
  String(process.env.AFILIADOS_INCLUIR_CLASSIFICADAS || '').toLowerCase(),
  'true'
);
ok('INCLUIR_CLASSIFICADAS não está true por padrão no ambiente de teste');

section('Publicador');
const pubSrc = fs.readFileSync(path.join(ROOT, 'src/navegador/publicador.js'), 'utf8');
assert.ok(pubSrc.includes('EXIGIR_LINK_AFILIADO'));
assert.ok(pubSrc.includes('resolverLinkAfiliado'));
assert.ok(pubSrc.includes('sem_link_afiliado'));
ok('publicador ainda exige link afiliado');

section('Cursos');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.ok(pkg.scripts['curso:selecionar']);
assert.ok(pkg.scripts['curso:preparar']);
assert.ok(fs.existsSync(path.join(ROOT, 'src/cursos/seletor.js')));
ok('módulo cursos permanece disponível');

section('Dry-run código');
const convSrc = fs.readFileSync(
  path.join(ROOT, 'src/afiliados/conversor-navegador.js'),
  'utf8'
);
const m = convSrc.match(/if \(resultadoLote\.dryRun\) \{([\s\S]*?)\n      \}/);
assert.ok(m, 'bloco dryRun encontrado');
const dryBlock = m[1];
assert.ok(!/marcarErro\s*\(/.test(dryBlock));
assert.ok(!/marcarConvertido\s*\(/.test(dryBlock));
assert.ok(!/marcarEmProcessamento\s*\(/.test(dryBlock));
assert.ok(!/registrarConvertido\s*\(/.test(dryBlock));
ok('ramo dry-run não chama marcarErro/Convertido/EmProcessamento/registrar');
assert.ok(convSrc.includes('if (!DRY_RUN)') && convSrc.includes('marcarEmProcessamento'));
ok('marcarEmProcessamento protegido por !DRY_RUN');
assert.ok(convSrc.includes('não destrutivo'));
ok('mensagem de teste não destrutivo presente');

console.log('\n==============================');
console.log(`PASS: ${passed} asserções OK`);
console.log('==============================\n');
