'use strict';

/**
 * Seletor de cursos próprios × grupos compatíveis.
 * Não altera a seleção Shopee (data/selecao-atual.json).
 *
 * Saída: data/selecao-cursos.json no mesmo formato de item
 * esperado pelo publicador de navegador (grupo + oferta + texto).
 */

const path = require('path');
const { readJson, writeJson, nowIso } = require('../utils');
const {
  jaPublicadoRecentemente,
} = require('../historico-cursos');

const ROOT = path.join(__dirname, '..', '..');
const CURSOS_FILE = path.join(ROOT, 'data', 'cursos.json');
const GRUPOS_FILE = path.join(ROOT, 'config', 'grupos.json');
const OUT_FILE = path.join(ROOT, 'data', 'selecao-cursos.json');

function montarTextoCurso(curso) {
  const nome = String(curso.nome || '').trim();
  const desc = String(curso.descricao_curta || '').trim();
  const preco = String(curso.preco || '').trim();
  const link = String(curso.link || '').trim();

  const linhas = ['📚 CURSO PRÁTICO', '', nome];
  if (desc) {
    linhas.push('', `🎓 ${desc}`);
  }
  if (preco) {
    linhas.push('', `💰 Acesso por apenas ${preco}`);
  }
  linhas.push('', '👉 Conheça o curso:', link);
  return linhas.join('\n');
}

function carregarCursosAtivos() {
  const data = readJson(CURSOS_FILE, { cursos: [] });
  return (data.cursos || [])
    .filter((c) => c && c.ativo !== false && c.id && c.link)
    .sort((a, b) => (a.prioridade || 99) - (b.prioridade || 99));
}

function carregarGruposAtivos() {
  const data = readJson(GRUPOS_FILE, { grupos: [] });
  return (data.grupos || [])
    .filter((g) => g && g.ativo !== false && g.group_id)
    .filter((g) => g.publicavel !== false)
    .sort((a, b) => (a.prioridade || 99) - (b.prioridade || 99));
}

function grupoCompativel(grupo, curso) {
  const nichoGrupo = String(grupo.nicho || 'geral').toLowerCase();
  const nichosCurso = Array.isArray(curso.nichos)
    ? curso.nichos.map((n) => String(n).toLowerCase())
    : [String(curso.nicho || 'geral').toLowerCase()];

  if (nichosCurso.includes(nichoGrupo)) return true;
  // grupo geral recebe curso que lista "geral"
  if (nichoGrupo === 'geral' && nichosCurso.includes('geral')) return true;
  return false;
}

/**
 * Gera seleções curso × grupo.
 * maxPorCurso: quantos grupos por curso nesta execução
 * maxTotal: teto global de seleções
 */
function selecionar({ maxPorCurso = 1, maxTotal = 3 } = {}) {
  console.log('=== SELETOR DE CURSOS × GRUPO ===');

  const cursos = carregarCursosAtivos();
  const grupos = carregarGruposAtivos();

  if (cursos.length === 0) {
    console.warn('⚠️ Nenhum curso ativo em data/cursos.json');
  }
  if (grupos.length === 0) {
    console.warn('⚠️ Nenhum grupo ativo/publicável em config/grupos.json');
  }

  const selecoes = [];

  for (const curso of cursos) {
    if (selecoes.length >= maxTotal) break;

    let usadosNesteCurso = 0;
    const ofertaShape = {
      id: curso.id,
      titulo: curso.nome,
      preco: curso.preco,
      preco_formatado: curso.preco,
      link: curso.link,
      imagem: curso.imagem || '',
      nicho: (curso.nichos && curso.nichos[0]) || 'geral',
    };

    for (const grupo of grupos) {
      if (selecoes.length >= maxTotal) break;
      if (usadosNesteCurso >= maxPorCurso) break;
      if (!grupoCompativel(grupo, curso)) continue;

      const grupoId = grupo.id || grupo.grupo_id;
      if (jaPublicadoRecentemente(grupoId, ofertaShape)) {
        console.log(
          `⏭  ${curso.id} × ${grupo.nome}: já no histórico de cursos (7 dias)`
        );
        continue;
      }

      selecoes.push({
        tipo: 'curso',
        grupo: {
          id: grupoId,
          nome: grupo.nome,
          group_id: grupo.group_id || null,
          nicho: grupo.nicho || 'geral',
        },
        // Mantém o nome "oferta" para o publicador existente
        oferta: ofertaShape,
        curso: {
          id: curso.id,
          nome: curso.nome,
          preco: curso.preco,
          link: curso.link,
          imagem: curso.imagem || '',
          nichos: curso.nichos || [],
        },
        texto: montarTextoCurso(curso),
        status: 'pendente',
        selecionado_em: nowIso(),
      });

      usadosNesteCurso += 1;
      console.log(
        `✅ ${curso.id} → ${grupo.nome} (${grupo.nicho})`
      );
    }
  }

  const payload = {
    gerado_em: nowIso(),
    tipo: 'curso',
    total_selecoes: selecoes.length,
    grupos_ativos: grupos.length,
    cursos_ativos: cursos.length,
    selecoes,
  };

  writeJson(OUT_FILE, payload);
  console.log(`✅ ${selecoes.length} seleção(ões) de curso → ${OUT_FILE}`);
  return payload;
}

if (require.main === module) {
  try {
    selecionar();
    process.exit(0);
  } catch (err) {
    console.error('❌ Seletor de cursos falhou:', err.message);
    process.exit(1);
  }
}

module.exports = { selecionar, montarTextoCurso };
