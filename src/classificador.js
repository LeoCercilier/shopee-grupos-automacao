'use strict';

const path = require('path');
const { readJson, writeJson, nowIso } = require('./utils');

const ROOT = path.join(__dirname, '..');
const IN_FILE = path.join(ROOT, 'data', 'ofertas-brutas.json');
const OUT_FILE = path.join(ROOT, 'data', 'ofertas-classificadas.json');

/**
 * Regras simples de classificação por palavras-chave no título.
 * Pode ser expandida sem alterar o resto do pipeline.
 */
const REGRAS_NICHO = [
  {
    nicho: 'beleza',
    keys: [
      'cabelo', 'capilar', 'touca', 'hidrata', 'shampoo', 'condicionador',
      'mascara', 'máscara', 'skincare', 'pele', 'rosto', 'maquiagem', 'batom',
      'base', 'creme', 'serum', 'sérum', 'esfoliante', 'beleza', 'unha',
      'esmalt', 'perfume', 'colonia', 'colônia', 'body splash', 'protetor solar',
    ],
  },
  {
    nicho: 'eletronicos',
    keys: [
      'fone', 'bluetooth', 'carregador', 'cabo', 'usb', 'power bank',
      'powerbank', 'celular', 'smartphone', 'tablet', 'notebook', 'mouse',
      'teclado', 'webcam', 'ssd', 'hd ', 'pen drive', 'pendrive', 'led',
      'lampada', 'lâmpada', 'smartwatch', 'relogio', 'relógio', 'caixa de som',
      'speaker', 'monitor', 'eletronico', 'eletrônico', 'playstation', 'ps4',
      'ps5', 'xbox', 'controle',
    ],
  },
  {
    nicho: 'casa',
    keys: [
      'cozinha', 'panela', 'frigideira', 'utensilio', 'utensílio', 'organizador',
      'cabide', 'prateleira', 'cortina', 'toalha', 'tapete', 'vaso', 'jardim',
      'limpeza', 'vassoura', 'rodo', 'balde', 'garrafa', 'copo', 'talher',
      'faca', 'tesoura', 'suporte', 'casa', 'domestico', 'doméstico',
      'air fryer', 'liquidificador', 'churrasco', 'facas',
    ],
  },
  {
    nicho: 'moda',
    keys: [
      'roupa', 'camiseta', 'camisa', 'calca', 'calça', 'short', 'saia',
      'vestido', 'blusa', 'jaqueta', 'casaco', 'moletom', 'tenis', 'tênis',
      'sapato', 'sandalia', 'sandália', 'chinelo', 'bolsa', 'mochila',
      'carteira', 'oculos', 'óculos', 'bone', 'boné', 'meia', 'cueca',
      'sutia', 'sutiã', 'lingerie', 'moda', 'look',
    ],
  },
  {
    nicho: 'pets',
    keys: [
      'pet', 'cao', 'cão', 'cachorro', 'gato', 'felino', 'racao', 'ração',
      'coleira', 'guia', 'brinquedo pet', 'arranhador', 'comedouro',
      'bebedouro', 'antipulgas', 'petisco',
    ],
  },
  {
    nicho: 'ferramentas',
    keys: [
      'furadeira', 'parafusadeira', 'chave de fenda', 'chave allen', 'alicate',
      'martelo', 'serra', 'nivel', 'nível', 'trena', 'ferramenta',
      'kit ferramenta', 'broca', 'lixa', 'esmerilhadeira',
    ],
  },
  {
    nicho: 'saude',
    keys: [
      'suplemento', 'whey', 'creatina', 'vitamina', 'colageno', 'colágeno',
      'gluteo', 'glúteo', 'emagrecedor', 'termogenico', 'termogênico',
    ],
  },
];

function detectarNicho(titulo) {
  const t = String(titulo || '').toLowerCase();
  for (const regra of REGRAS_NICHO) {
    if (regra.keys.some((k) => t.includes(k))) {
      return regra.nicho;
    }
  }
  return 'geral';
}

function classificarOfertas(ofertas) {
  return ofertas.map((o) => ({
    ...o,
    nicho: detectarNicho(o.titulo),
    classificado_em: nowIso(),
  }));
}

function executar() {
  console.log('=== CLASSIFICADOR DE OFERTAS ===');
  const bruto = readJson(IN_FILE);
  if (!bruto || !Array.isArray(bruto.ofertas) || bruto.ofertas.length === 0) {
    throw new Error(`Arquivo de entrada vazio ou inválido: ${IN_FILE}`);
  }

  const classificadas = classificarOfertas(bruto.ofertas);
  const contagem = {};
  for (const o of classificadas) {
    contagem[o.nicho] = (contagem[o.nicho] || 0) + 1;
  }

  const payload = {
    gerado_em: nowIso(),
    total: classificadas.length,
    contagem_por_nicho: contagem,
    ofertas: classificadas,
  };

  writeJson(OUT_FILE, payload);
  console.log('Contagem por nicho:', contagem);
  console.log(`✅ Classificadas ${classificadas.length} ofertas → ${OUT_FILE}`);
  return payload;
}

if (require.main === module) {
  try {
    executar();
    process.exit(0);
  } catch (err) {
    console.error('❌ Falha no classificador:', err.message);
    process.exit(1);
  }
}

module.exports = { classificarOfertas, detectarNicho, executar };
