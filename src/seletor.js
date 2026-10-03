'use strict';

const path = require('path');

const { readJson, writeJson, nowIso } = require('./utils');
const { jaPublicadoRecentemente } = require('./historico');

const ROOT = path.join(__dirname, '..');
const CLASS_FILE = path.join(ROOT, 'data', 'ofertas-classificadas.json');
const GROUPS_FILE = path.join(ROOT, 'config', 'grupos.json');
const OUT_FILE = path.join(ROOT, 'data', 'selecao-atual.json');
const RODIZIO_FILE = path.join(ROOT, 'data', 'rodizio-grupos.json');

function carregarGruposAtivos() {
  const data = readJson(GROUPS_FILE, { grupos: [] });

  if (!Array.isArray(data.grupos)) {
    return [];
  }

  return data.grupos
    .filter((grupo) => grupo.ativo !== false)
    .sort((a, b) => {
      const pa = Number(a.prioridade || 999);
      const pb = Number(b.prioridade || 999);
      return pa - pb;
    });
}

function gerarSubtitulo(oferta) {
  const titulo = String(oferta.titulo || '').trim();
  const t = titulo.toLowerCase();

  const subtituloExistente = [
    oferta.subtitulo,
    oferta.descricao_curta,
    oferta.descricao_curta_produto,
  ]
    .map((valor) => String(valor || '').trim())
    .find((valor) => valor.length >= 8);

  if (subtituloExistente) {
    return subtituloExistente.startsWith('✨')
      ? subtituloExistente
      : `✨ ${subtituloExistente}`;
  }

  const regras = [
    { palavras: ['siàge', 'siage'], texto: '✨ Reconstrução profunda para os cuidados com os cabelos' },
    {
      palavras: ['parafusadeira', 'furadeira'],
      texto: '🔧 Parafusadeira e furadeira sem fio para seus projetos',
    },
    {
      palavras: ['câmera', 'camera'],
      texto: '📷 Câmera para monitoramento e vigilância',
    },
    {
      palavras: ['detecção de movimento', 'deteccao de movimento'],
      texto: '📷 Vigilância com detecção de movimento',
    },
    {
      palavras: ['body splash'],
      texto: '✨ Body splash para sua rotina de beleza',
    },
    {
      palavras: ['shampoo'],
      texto: '🧴 Cuidado para os cabelos no dia a dia',
    },
    {
      palavras: ['condicionador'],
      texto: '🧴 Cuidado e tratamento para os cabelos',
    },
    {
      palavras: ['cabelo', 'cabelos'],
      texto: '💇 Produto para cuidados com os cabelos',
    },
    {
      palavras: ['skincare', 'pele'],
      texto: '✨ Cuidados para a sua rotina de beleza',
    },
    {
      palavras: ['maquiagem', 'batom', 'blush', 'máscara de cílios', 'mascara de cilios'],
      texto: '💄 Um item para complementar sua rotina de beleza',
    },
    {
      palavras: ['coturno', 'bota', 'tênis', 'tenis', 'sandália', 'sandalia'],
      texto: '👟 Estilo e praticidade para o seu dia a dia',
    },
    {
      palavras: ['pulseira', 'colar', 'brinco', 'anel'],
      texto: '✨ Acessório para complementar seu visual',
    },
    {
      palavras: ['melatonina'],
      texto: '🌙 Suplemento em cápsulas para sua rotina noturna',
    },
    {
      palavras: ['vitamina', 'biotina'],
      texto: '💚 Suplemento para sua rotina de cuidados',
    },
    {
      palavras: ['ração', 'racao'],
      texto: '🐾 Alimentação para a rotina do seu pet',
    },
    {
      palavras: ['coleira', 'guia para cachorro', 'guia para cão'],
      texto: '🐾 Acessório para o passeio do seu pet',
    },
    {
      palavras: ['brinquedo pet', 'brinquedo para cachorro', 'brinquedo para gato'],
      texto: '🐾 Diversão para o seu pet',
    },
    {
      palavras: ['organizador', 'organização', 'organizacao'],
      texto: '🏠 Mais organização e praticidade para sua rotina',
    },
    {
      palavras: ['cozinha', 'panela', 'frigideira', 'churrasco'],
      texto: '🍳 Praticidade para preparar suas refeições',
    },
    {
      palavras: ['celular', 'smartphone'],
      texto: '📱 Tecnologia para o seu dia a dia',
    },
    {
      palavras: ['notebook', 'computador'],
      texto: '💻 Tecnologia para trabalho, estudo e rotina',
    },
    {
      palavras: ['fone', 'headset', 'fones'],
      texto: '🎧 Áudio e praticidade para o seu dia a dia',
    },
  ];

  for (const regra of regras) {
    if (regra.palavras.some((palavra) => t.includes(palavra))) {
      return regra.texto;
    }
  }

  const partes = titulo
    .split(/[:|]/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (partes.length > 1 && partes[1].length >= 10) {
    return `✨ ${partes[1]}`;
  }

  if (oferta.nicho === 'ferramentas') {
    return '🔧 Praticidade para seus projetos e tarefas';
  }

  if (oferta.nicho === 'beleza') {
    return '✨ Cuidados e beleza para o seu dia a dia';
  }

  if (oferta.nicho === 'casa') {
    return '🏠 Praticidade para sua casa e rotina';
  }

  if (oferta.nicho === 'eletronicos') {
    return '📱 Tecnologia e praticidade no dia a dia';
  }

  if (oferta.nicho === 'moda') {
    return '👗 Estilo para diferentes ocasiões';
  }

  if (oferta.nicho === 'saude') {
    return '💚 Uma opção para sua rotina de cuidados';
  }

  if (oferta.nicho === 'pets') {
    return '🐾 Para a rotina do seu pet';
  }

  return '✨ Mais praticidade para sua rotina';
}

function montarTextoPublicacao(oferta) {
  return [
    '🔥',
    '',
    oferta.titulo || '',
    '',
    gerarSubtitulo(oferta),
    '',
    `💰 ${oferta.preco_formatado || oferta.preco || ''}`,
    '',
    '🛍️ Confira na Shopee:',
    oferta.link || '',
    '',
    '#pub',
  ].join('\n');
}

function selecionar({ maxPorGrupo = 1, maxTotal = Infinity } = {}) {
  console.log('=== SELETOR OFERTA × GRUPO ===');

  const classificadas = readJson(CLASS_FILE);

  if (!classificadas || !Array.isArray(classificadas.ofertas)) {
    throw new Error(`Arquivo classificado inválido: ${CLASS_FILE}`);
  }

  const grupos = carregarGruposAtivos();

  const gruposPorNicho = {};

  for (const grupo of grupos) {
    const nicho = grupo.nicho || 'geral';

    if (!gruposPorNicho[nicho]) {
      gruposPorNicho[nicho] = [];
    }

    gruposPorNicho[nicho].push(grupo);
  }

  const usadosPorGrupo = {};

  for (const grupo of grupos) {
    usadosPorGrupo[grupo.id] = 0;
  }

  const estadoRodizio = readJson(RODIZIO_FILE, { rodizio: {} });
  const rodizio = {};

  for (const nicho of Object.keys(gruposPorNicho)) {
    const valorSalvo = Number(estadoRodizio.rodizio?.[nicho] ?? 0);
    rodizio[nicho] = Number.isInteger(valorSalvo) && valorSalvo >= 0 ? valorSalvo : 0;
  }

  const selecoes = [];

  function tentarSelecionar(oferta, maxGruposPorOferta = 5) {
    if (selecoes.length >= maxTotal) {
      return false;
    }

    const nichoOferta = oferta.nicho || 'geral';
    let elegiveis = gruposPorNicho[nichoOferta] || [];

    if (nichoOferta === 'geral') {
      elegiveis = gruposPorNicho.geral || [];
    }


    if (elegiveis.length === 0) {
      return false;
    }

    const nichoGrupos = elegiveis[0].nicho || 'geral';
    const inicioRodizio = rodizio[nichoGrupos] || 0;

    let selecionadosNestaOferta = 0;
    let ultimoIndice = inicioRodizio;

    for (
      let i = 0;
      i < elegiveis.length && selecionadosNestaOferta < maxGruposPorOferta;
      i++
    ) {
      if (selecoes.length >= maxTotal) {
        break;
      }

      const indice = (inicioRodizio + i) % elegiveis.length;
      const grupo = elegiveis[indice];

      if (!grupo.id) {
        continue;
      }

      if (usadosPorGrupo[grupo.id] >= maxPorGrupo) {
        continue;
      }

      if (jaPublicadoRecentemente(grupo.id, oferta)) {
        continue;
      }

      selecoes.push({
        grupo: {
          id: grupo.id,
          nome: grupo.nome,
          group_id: grupo.group_id || null,
          nicho: grupo.nicho,
        },
        oferta: {
          id: oferta.id,
          titulo: oferta.titulo,
          preco: oferta.preco,
          preco_formatado: oferta.preco_formatado,
          link: oferta.link,
          imagem: oferta.imagem,
          nicho: oferta.nicho,
          subtitulo: oferta.subtitulo || null,
          descricao_curta: oferta.descricao_curta || null,
          descricao_curta_produto: oferta.descricao_curta_produto || null,
        },
        texto: montarTextoPublicacao(oferta),
        status: 'pendente',
        selecionado_em: nowIso(),
      });

      usadosPorGrupo[grupo.id] += 1;
      selecionadosNestaOferta += 1;
      ultimoIndice = indice;
    }

    if (selecionadosNestaOferta > 0) {
      rodizio[nichoGrupos] =
        (ultimoIndice + 1) % elegiveis.length;

      return true;
    }

    return false;
  }

  /*
   * REGRA ATUAL:
   * Para cada nicho, selecionar UMA oferta.
   * A mesma oferta pode ser enviada para até 5 grupos
   * compatíveis do mesmo nicho.
   *
   * Se a primeira oferta estiver impedida pelo histórico,
   * tenta a próxima oferta do mesmo nicho.
   * Depois passa para o próximo nicho.
   */

  const nichos = [...new Set(
    classificadas.ofertas.map((oferta) => oferta.nicho || 'geral')
  )];

  for (const nicho of nichos) {
    if (selecoes.length >= maxTotal) {
      break;
    }

    const ofertasDoNicho = classificadas.ofertas.filter(
      (oferta) => (oferta.nicho || 'geral') === nicho
    );

    let selecionouNesteNicho = false;

    for (const oferta of ofertasDoNicho) {
      if (selecoes.length >= maxTotal) {
        break;
      }

      const conseguiu = tentarSelecionar(oferta);

      if (conseguiu) {
        selecionouNesteNicho = true;
        break;
      }
    }

    if (!selecionouNesteNicho) {
      console.log(`⚠️ Nenhuma oferta elegível encontrada para o nicho: ${nicho}`);
    }
  }

  writeJson(RODIZIO_FILE, { rodizio });
  const payload = {
    gerado_em: nowIso(),
    total_selecoes: selecoes.length,
    grupos_ativos: grupos.length,
    selecoes,
    aviso:
      'Publicação automática em grupos NÃO está implementada. Groups API oficial da Meta foi removida em abril/2024.',
  };

  writeJson(OUT_FILE, payload);

  console.log(
    `✅ ${selecoes.length} seleção(ões) geradas → ${OUT_FILE}`
  );

  return payload;
}

if (require.main === module) {
  selecionar();
}

module.exports = {
  selecionar,
  carregarGruposAtivos,
  montarTextoPublicacao,
};
