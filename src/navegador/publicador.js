'use strict';

/**
 * Publicador por navegador (MVP).
 *
 * - Lê data/selecao-atual.json (Shopee) ou data/selecao-cursos.json (cursos)
 * - Processa SOMENTE 1 seleção (primeira elegível ou filtrada)
 * - Usa sessão local (.browser-session)
 * - Por padrão MODO=preparar: preenche o compositor e NÃO clica em Publicar
 * - Com MODO=publicar: tenta clicar e só registra histórico se houver confirmação
 *
 * CONTENT_TYPE=shopee (padrão) | curso — mesmo navegador, históricos separados.
 * Ofertas Shopee exigem link afiliado confirmado em data/links-afiliados.json
 * (EXIGIR_LINK_AFILIADO=true por padrão).
 *
 * NÃO usa senha, NÃO versiona cookies, NÃO contorna CAPTCHA.
 */

const path = require('path');
const { readJson, writeJson, nowIso } = require('../utils');


const {
  conectarFacebook: conectarFacebookCDP,
  avaliar: avaliarCDP,
  abrirGrupo: abrirGrupoCDP,
  abrirCompositorCDP,
  preencherTextoCDP,
  clicarPublicarCDP,
  confirmarPublicacaoCDP,
  sleep: sleepCDP,
} = require('./cdp');

// Android/Termux não suporta o Playwright instalado.
// Nesse ambiente usamos Chromium nativo através do CDP.
const EH_TERMUX =
  Boolean(process.env.PREFIX && process.env.PREFIX.includes('/com.termux/')) ||
  Boolean(process.env.HOME && process.env.HOME.startsWith('/data/data/com.termux/')) ||
  process.env.FORCAR_CDP === 'true';

const USAR_CDP =
  EH_TERMUX ||
  String(process.env.BROWSER_ENGINE || '').toLowerCase() === 'cdp';

const ROOT = path.join(__dirname, '..', '..');

const CONTENT_TYPE = String(process.env.CONTENT_TYPE || 'shopee').toLowerCase();
const IS_CURSO = CONTENT_TYPE === 'curso' || CONTENT_TYPE === 'cursos';

const historicoModulo = IS_CURSO
  ? require('../historico-cursos')
  : require('../historico');
const { jaPublicadoRecentemente, registrarPublicacao } = historicoModulo;

const SELECAO_FILE =
  process.env.SELECAO_FILE ||
  path.join(
    ROOT,
    'data',
    IS_CURSO ? 'selecao-cursos.json' : 'selecao-atual.json'
  );

const RESULTADO_FILE =
  process.env.RESULTADO_FILE ||
  path.join(
    ROOT,
    'data',
    IS_CURSO ? 'resultado-publicacao-cursos.json' : 'resultado-publicacao-browser.json'
  );

const MODO = String(process.env.MODO_PUBLICACAO_BROWSER || 'preparar').toLowerCase();
// preparar | publicar

// Camada de links afiliados (apenas Shopee; cursos não usam)
const { resolverLinkAfiliado, aplicarLinkNoTexto } = require('../afiliados/resolver');
const EXIGIR_AFILIADO =
  String(process.env.EXIGIR_LINK_AFILIADO || 'true').toLowerCase() !== 'false';

function escolherUmaSelecao(selecao) {
  const lista = (selecao && selecao.selecoes) || [];
  const filtroGrupo = process.env.BROWSER_GRUPO_ID || '';
  const filtroInterno = process.env.BROWSER_GRUPO_INTERNO || '';

  for (const item of lista) {
    const g = item.grupo || {};
    const o = item.oferta || {};
    if (!g.group_id) continue;
    if (filtroGrupo && String(g.group_id) !== String(filtroGrupo)) continue;
    if (filtroInterno && String(g.id) !== String(filtroInterno)) continue;
    if (jaPublicadoRecentemente(g.id, o)) {
      console.log(`⏭  Pulando ${g.nome}: já no histórico recente`);
      continue;
    }
    return item;
  }
  return null;
}

async function recuperarCompositor(page, groupId, tentativa) {
  console.log(`🔄 Recuperando compositor (tentativa ${tentativa})...`);

  try {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(700);
  } catch (_) {}

  await page.goto('about:blank', {
    waitUntil: 'domcontentloaded',
    timeout: 15000,
  }).catch(() => {});

  const grupoRes = await abrirGrupo(page, groupId);

  if (!grupoRes.ok) {
    return {
      ok: false,
      motivo: grupoRes.motivo || 'Não foi possível reabrir o grupo',
    };
  }

  const comp = await abrirCompositor(page);

  if (!comp.ok) {
    return {
      ok: false,
      motivo: comp.motivo || 'Não foi possível reabrir o compositor',
    };
  }

  return { ok: true };
}

async function prepararTextoComRecuperacao(page, groupId, texto) {
  const MAX_TENTATIVAS = 2;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    const txt = await preencherTexto(page, texto);

    if (txt.ok) {
      return { ok: true, tentativa };
    }

    console.log(
      `⚠️ Campo de texto não encontrado na tentativa ${tentativa}/${MAX_TENTATIVAS}: ${txt.motivo}`
    );

    if (tentativa < MAX_TENTATIVAS) {
      const recuperacao = await recuperarCompositor(
        page,
        groupId,
        tentativa + 1
      );

      if (!recuperacao.ok) {
        return {
          ok: false,
          motivo: `${txt.motivo}; recuperação falhou: ${recuperacao.motivo}`,
        };
      }
    } else {
      return txt;
    }
  }

  return {
    ok: false,
    motivo: 'Não foi possível preencher o compositor após recuperação',
  };
}

async function publicarSelecoesNavegador({ dryRun = false } = {}) {
  if (dryRun || MODO !== 'publicar') {
    const resultado = await publicarUma({ dryRun });

    return {
      modo: resultado.status === 'publicado'
        ? 'navegador-publicado'
        : 'navegador-preparado',
      publicados: resultado.status === 'publicado' ? 1 : 0,
      erros: resultado.status === 'erro' ? 1 : 0,
      processados: 1,
      resultados: [resultado]
    };
  }

  const rawMax = String(
    process.env.BROWSER_MAX_PUBLICACOES || ''
  ).trim().toLowerCase();

  const maxPublicacoes =
    !rawMax || rawMax === 'todos' || rawMax === 'infinity'
      ? Infinity
      : Math.max(1, Number.parseInt(rawMax, 10) || 1);

  const intervaloMs = Math.max(
    0,
    Number.parseInt(process.env.BROWSER_INTERVALO_MS || '5000', 10) || 5000
  );

  const resultados = [];
  let publicados = 0;
  let erros = 0;
  let parouPor = 'todas_selecoes_processadas';

  console.log('');
  console.log('==============================================');
  console.log('PUBLICADOR NAVEGADOR — MODO LOTE');
  console.log('==============================================');
  console.log(
    'Limite:',
    Number.isFinite(maxPublicacoes) ? maxPublicacoes : 'TODAS AS SELEÇÕES'
  );
  console.log('Intervalo entre publicações:', intervaloMs + 'ms');
  console.log('');

  while (publicados < maxPublicacoes) {
    console.log('');
    console.log(
      '--- Próxima seleção (' +
      (publicados + 1) +
      (Number.isFinite(maxPublicacoes) ? '/' + maxPublicacoes : '') +
      ') ---'
    );

    const resultado = await publicarUma({ dryRun: false });
    resultados.push(resultado);

    if (resultado.status === 'publicado') {
      publicados++;

      console.log(
        '✅ Publicação confirmada:',
        publicados
      );

      if (
        intervaloMs > 0 &&
        publicados < maxPublicacoes
      ) {
        console.log(
          '⏳ Aguardando ' +
          intervaloMs +
          'ms antes da próxima publicação...'
        );

        await new Promise(resolve =>
          setTimeout(resolve, intervaloMs)
        );
      }

      continue;
    }

    if (
      resultado.status === 'nenhuma_elegivel' ||
      resultado.status === 'sem_selecao'
    ) {
      parouPor = 'todas_selecoes_elegiveis_processadas';
      break;
    }

    // Sem link afiliado: enfileira e tenta próxima seleção (não interrompe o lote)
    if (resultado.status === 'sem_link_afiliado') {
      console.log('⏭  Sem afiliado — seguindo para próxima seleção da fila');
      continue;
    }

    if (
      resultado.status === 'bloqueio' ||
      resultado.status === 'incerto' ||
      resultado.status === 'erro'
    ) {
      erros++;
      parouPor = resultado.status;
      console.log(
        '🛑 Lote interrompido:',
        resultado.status
      );
      break;
    }

    erros++;
    parouPor = 'status_desconhecido';
    break;
  }

  console.log('');
  console.log('==============================================');
  console.log('RESUMO DO LOTE');
  console.log('==============================================');
  console.log('Publicados:', publicados);
  console.log('Erros:', erros);
  console.log('Processados:', resultados.length);
  console.log('Motivo da parada:', parouPor);
  console.log('==============================================');

  return {
    modo: 'navegador-publicado',
    publicados,
    erros,
    processados: resultados.length,
    parou_por: parouPor,
    resultados
  };
}


async function publicarUmaCDP({ item, base, texto }) {
  console.log('');
  console.log('========================================');
  console.log(' PUBLICADOR NAVEGADOR — CDP / TERMUX');
  console.log('========================================');
  console.log('Tipo:', IS_CURSO ? 'curso' : 'shopee');
  console.log('Grupo:', item.grupo.nome);
  console.log('Modo:', MODO);

  let conexao;

  try {
    conexao = await conectarFacebookCDP();

    console.log('✅ Chromium/CDP conectado');
    console.log('Target:', conexao.target.id);
    console.log('URL:', conexao.target.url);

    // --------------------------------------------------------
    // Verificação da sessão do Facebook
    // --------------------------------------------------------

    const sessaoRaw = await avaliarCDP(
      conexao.Runtime,
      `(() => {
        const texto = document.body?.innerText || '';

        return JSON.stringify({
          url: location.href,
          titulo: document.title,
          facebook: location.hostname.includes('facebook.com'),
          nome: texto.includes('Leonardo Cercilier'),
          loginPage:
            location.pathname.includes('/login') ||
            texto.includes('Entrar no Facebook')
        });
      })()`
    );

    const sessao = JSON.parse(sessaoRaw);

    console.log('');
    console.log('=== SESSÃO ===');
    console.log(JSON.stringify(sessao, null, 2));

    if (
      !sessao.facebook ||
      sessao.loginPage
    ) {
      throw new Error(
        'Sessão autenticada do Facebook não encontrada no Chromium/CDP'
      );
    }

    console.log('✅ Sessão do Facebook confirmada');

    // --------------------------------------------------------
    // Abrir grupo
    // --------------------------------------------------------

    const grupoRes = await Promise.race([
      abrirGrupoCDP(
        conexao.Runtime,
        item.grupo.group_id
      ),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Timeout ao abrir grupo via CDP após 15 segundos')),
          15000
        )
      )
    ]);

    console.log('');
    console.log('=== GRUPO ===');
    console.log(JSON.stringify(grupoRes, null, 2));

    console.log('✅ Grupo carregado');

    // --------------------------------------------------------
    // Abrir compositor
    // --------------------------------------------------------

    await abrirCompositorCDP(
      conexao.Runtime,
      conexao.Input
    );

    console.log('✅ Compositor aberto');
    console.log('✅ Editor Lexical localizado');

    // --------------------------------------------------------
    // Inserir texto
    // --------------------------------------------------------

    const verificacao = await preencherTextoCDP(
      conexao.Runtime,
      conexao.Input,
      texto
    );

    console.log('');
    console.log('=== TEXTO INSERIDO ===');
    console.log(JSON.stringify(verificacao, null, 2));

    const textoFinal = verificacao.texto || '';

    // --------------------------------------------------------
    // Validar conteúdo
    // --------------------------------------------------------

    const validacao = {
      editor_encontrado: Boolean(verificacao.encontrado),
      oferta:
        IS_CURSO
          ? true
          : textoFinal.includes('🔥 OFERTA DO DIA'),
      titulo:
        Boolean(item.oferta?.titulo) &&
        textoFinal.includes(item.oferta.titulo),
      preco:
        Boolean(item.oferta?.preco) &&
        textoFinal.includes(String(item.oferta.preco)),
      link:
        Boolean(item.oferta?.link) &&
        textoFinal.includes(item.oferta.link),
      texto_ativo: Boolean(verificacao.ativo),
    };

    console.log('');
    console.log('=== VALIDAÇÃO ===');
    console.log(JSON.stringify(validacao, null, 2));

    if (
      !validacao.editor_encontrado ||
      !validacao.oferta ||
      !validacao.titulo ||
      !validacao.link ||
      !validacao.texto_ativo
    ) {
      throw new Error(
        'O texto foi inserido, mas a validação do conteúdo falhou'
      );
    }

    // --------------------------------------------------------
    // MODO PREPARAR
    // --------------------------------------------------------

    if (MODO !== 'publicar') {
      const r = {
        ...base,
        status: 'preparado_manual',
        motor: 'cdp',
        imagem_anexada: false,
        screenshot: null,
        validacao,
        historico: false,
        mensagem:
          'Texto preparado pelo Chromium/CDP. Publicação NÃO executada e histórico NÃO atualizado.'
      };

      writeJson(RESULTADO_FILE, r);

      console.log('');
      console.log('========================================');
      console.log('✅ CDP FUNCIONANDO');
      console.log('✅ FACEBOOK AUTENTICADO');
      console.log('✅ GRUPO ABERTO');
      console.log('✅ COMPOSITOR ABERTO');
      console.log('✅ TEXTO INSERIDO');
      console.log('✅ CONTEÚDO VALIDADO');
      console.log('⛔ PUBLICAÇÃO NÃO EXECUTADA');
      console.log('⛔ HISTÓRICO NÃO ALTERADO');
      console.log('========================================');

      console.log('⏳ Navegador ficará aberto por 60 segundos...');
      await sleepCDP(60000);

      return r;
    }

    // --------------------------------------------------------
    // PUBLICAÇÃO REAL — 1×1
    // --------------------------------------------------------

    console.log('');
    console.log('========================================');
    console.log('=== PUBLICAÇÃO REAL — 1×1 ===');
    console.log('========================================');

    const clique = await clicarPublicarCDP(
      conexao.Runtime,
      conexao.Input
    );

    if (!clique.ok) {
      const r = {
        ...base,
        status: 'erro',
        motor: 'cdp',
        erro: clique.motivo,
        validacao,
        historico: false
      };

      writeJson(RESULTADO_FILE, r);

      console.error('❌', clique.motivo);

      return r;
    }

    console.log('✅ Clique de publicação executado');

    const confirmacao = await confirmarPublicacaoCDP(
      conexao.Runtime,
      item.oferta?.titulo || ''
    );

    console.log('');
    console.log('=== CONFIRMAÇÃO ===');
    console.log(JSON.stringify(confirmacao, null, 2));

    if (!confirmacao.sucesso) {
      const r = {
        ...base,
        status: 'incerto',
        motor: 'cdp',
        erro: confirmacao.motivo,
        validacao,
        confirmacao,
        historico: false
      };

      writeJson(RESULTADO_FILE, r);

      console.error(
        '⚠️ Publicação não pôde ser confirmada.'
      );
      console.error(
        '⛔ Histórico NÃO alterado.'
      );

      return r;
    }

    // --------------------------------------------------------
    // PUBLICAÇÃO CONFIRMADA
    // --------------------------------------------------------

    const r = {
      ...base,
      status: 'publicado',
      motor: 'cdp',
      imagem_anexada: false,
      screenshot: null,
      validacao,
      confirmacao,
      historico: false,
      mensagem:
        'Publicação confirmada pelo Facebook.'
    };

    try {
      registrarPublicacao(
        item.grupo.id,
        item.oferta
      );

      r.historico = true;

      console.log('✅ Histórico registrado');
    } catch (historicoErr) {
      console.error(
        '⚠️ Publicação confirmada, mas houve erro ao registrar histórico:',
        historicoErr.message
      );

      r.historico_erro = historicoErr.message;
    }

    writeJson(RESULTADO_FILE, r);

    console.log('');
    console.log('========================================');
    console.log('✅ PUBLICAÇÃO CONFIRMADA');
    console.log(
      r.historico
        ? '✅ HISTÓRICO REGISTRADO'
        : '⚠️ HISTÓRICO NÃO REGISTRADO'
    );
    console.log('========================================');

    return r;

  } finally {

    if (conexao?.client) {
      try {
        await conexao.client.close();
      } catch (_) {}
    }

  }
}

async function publicarUma({ dryRun = false } = {}) {
  console.log('========================================');
  console.log(' PUBLICADOR NAVEGADOR — MVP (1×1)');
  console.log('========================================');
  console.log('Tipo de conteúdo:', IS_CURSO ? 'curso' : 'shopee');
  console.log('Seleção:', SELECAO_FILE);
  console.log('Modo:', MODO);
  console.log('Dry-run navegador:', dryRun);

  const selecao = readJson(SELECAO_FILE);
  if (!selecao || !Array.isArray(selecao.selecoes) || selecao.selecoes.length === 0) {
    const vazio = {
      gerado_em: nowIso(),
      status: 'sem_selecao',
      mensagem: `${path.basename(SELECAO_FILE)} vazio — rode a seleção correspondente antes`,
    };
    writeJson(RESULTADO_FILE, vazio);
    console.log(vazio.mensagem);
    return vazio;
  }

  const item = escolherUmaSelecao(selecao);
  if (!item) {
    const r = {
      gerado_em: nowIso(),
      status: 'nenhuma_elegivel',
      mensagem: 'Nenhuma seleção elegível (histórico/filtro/group_id)',
    };
    writeJson(RESULTADO_FILE, r);
    console.log(r.mensagem);
    return r;
  }

  const grupo = item.grupo;
  let oferta = item.oferta;
  let texto = item.texto || '';

  // Gate: ofertas Shopee só publicam com link afiliado confirmado no cache
  if (!IS_CURSO && EXIGIR_AFILIADO) {
    const afiliado = resolverLinkAfiliado(oferta);
    if (!afiliado.ok) {
      const r = {
        gerado_em: nowIso(),
        tipo: 'shopee',
        modo: MODO,
        status: 'sem_link_afiliado',
        grupo_id_interno: grupo && grupo.id,
        grupo_nome: grupo && grupo.nome,
        group_id: grupo && grupo.group_id,
        oferta_id: oferta && oferta.id,
        titulo: oferta && oferta.titulo,
        link_original: oferta && oferta.link,
        motivo: afiliado.motivo,
        mensagem:
          'Publicação bloqueada: não há link afiliado confirmado no cache. ' +
          'Enfileirado em data/fila-links-afiliados.json. ' +
          'Importe o CSV do Portal (npm run afiliados:importar-csv).',
      };
      writeJson(RESULTADO_FILE, r);
      console.log('🚫', r.mensagem);
      console.log('   Motivo:', r.motivo, '|', (oferta && oferta.titulo || '').slice(0, 60));
      return r;
    }
    const linkAntigo = oferta.link;
    oferta = { ...oferta, link: afiliado.link_afiliado };
    texto = aplicarLinkNoTexto(texto, linkAntigo, afiliado.link_afiliado);
    console.log('✅ Link afiliado confirmado no cache');
  }

  const base = {
    gerado_em: nowIso(),
    tipo: IS_CURSO ? 'curso' : 'shopee',
    modo: MODO,
    grupo_id_interno: grupo.id,
    grupo_nome: grupo.nome,
    group_id: grupo.group_id,
    oferta_id: oferta.id,
    titulo: oferta.titulo,
    link: oferta.link,
    imagem: oferta.imagem || null,
  };

  if (dryRun) {
    const r = {
      ...base,
      status: 'dry-run',
      preview_texto: texto.slice(0, 200),
      mensagem: 'Dry-run: navegador não foi aberto',
    };
    writeJson(RESULTADO_FILE, r);
    console.log('🔍 DRY-RUN', grupo.nome, oferta.titulo?.slice(0, 50));
    return r;
  }

  // ========================================================
  // TERMUX / ANDROID -> CDP
  // Linux/GitHub -> Playwright
  // ========================================================

  if (USAR_CDP) {
    return await publicarUmaCDP({
      item,
      base,
      texto,
    });
  }

  // Playwright somente é carregado aqui, depois do desvio CDP.
  const {
    criarContexto,
    novaPagina,
  } = require('./browser');

  const {
    verificarSessaoLogada,
    abrirGrupo,
    abrirCompositor,
    preencherTexto,
    anexarImagem,
    clicarPublicar,
    detectarSucesso,
    capturarEvidencia,
    detectarBloqueio,
  } = require('./facebook');

  let context;
  try {
    context = await criarContexto();
    const page = await novaPagina(context);

    const sessao = await verificarSessaoLogada(page);
    if (!sessao.ok) {
      const shot = await capturarEvidencia(page, 'sem-sessao');
      const r = { ...base, status: 'erro_sessao', erro: sessao.motivo, screenshot: shot };
      writeJson(RESULTADO_FILE, r);
      console.log('❌', r.erro);
      await context.close();
      return r;
    }

    const grupoRes = await abrirGrupo(page, grupo.group_id);
    if (!grupoRes.ok) {
      const shot = await capturarEvidencia(page, 'grupo');
      const r = { ...base, status: 'erro_grupo', erro: grupoRes.motivo, screenshot: shot };
      writeJson(RESULTADO_FILE, r);
      console.log('❌', r.erro);
      await context.close();
      return r;
    }

    let comp = await abrirCompositor(page);

    if (!comp.ok) {
      console.log('⚠️ Compositor não abriu de primeira. Tentando recuperação...');

      const recuperacao = await recuperarCompositor(
        page,
        grupo.group_id,
        1
      );

      if (!recuperacao.ok) {
        const shot = await capturarEvidencia(page, 'compositor');
        const r = {
          ...base,
          status: 'erro_compositor',
          erro: `${comp.motivo}; recuperação falhou: ${recuperacao.motivo}`,
          screenshot: shot
        };
        writeJson(RESULTADO_FILE, r);
        console.log('❌', r.erro);
        await context.close();
        return r;
      }

      comp = { ok: true };
      console.log('✅ Compositor recuperado.');
    }

    const txt = await prepararTextoComRecuperacao(
      page,
      grupo.group_id,
      texto
    );

    if (!txt.ok) {
      const shot = await capturarEvidencia(page, 'texto');
      const r = {
        ...base,
        status: 'erro_texto',
        erro: txt.motivo,
        screenshot: shot
      };
      writeJson(RESULTADO_FILE, r);
      console.log('❌', r.erro);
      await context.close();
      return r;
    }

    if (txt.tentativa > 1) {
      console.log(`✅ Campo de texto recuperado na tentativa ${txt.tentativa}.`);
    }

    const img = await anexarImagem(page, oferta.imagem);
    if (img.motivo) console.log('  Imagem:', img.motivo);

    const bloqueioMid = await detectarBloqueio(page);
    if (bloqueioMid.bloqueado) {
      const shot = await capturarEvidencia(page, 'bloqueio');
      const r = {
        ...base,
        status: 'bloqueio',
        erro: bloqueioMid.motivo,
        screenshot: shot,
      };
      writeJson(RESULTADO_FILE, r);
      console.log('⛔', r.erro);
      await context.close();
      return r;
    }

    if (MODO !== 'publicar') {
      const shot = await capturarEvidencia(page, 'preparado');
      const r = {
        ...base,
        status: 'preparado_manual',
        imagem_anexada: Boolean(img.anexado),
        screenshot: shot,
        mensagem:
          'Texto (e imagem se possível) preenchidos. Confirme MANUALMENTE no navegador. Histórico NÃO atualizado.',
      };
      writeJson(RESULTADO_FILE, r);
      console.log('✅ Compositor preenchido — confirme manualmente se desejar.');
      console.log('Screenshot:', shot);
      console.log('Janela permanece aberta 60s para revisão...');
      await page.waitForTimeout(60000);
      await context.close();
      return r;
    }

    const pub = await clicarPublicar(page);
    if (!pub.ok) {
      const shot = await capturarEvidencia(page, 'botao-publicar');
      const r = { ...base, status: 'erro_publicar', erro: pub.motivo, screenshot: shot };
      writeJson(RESULTADO_FILE, r);
      console.log('❌', r.erro);
      await context.close();
      return r;
    }

    const conf = await detectarSucesso(page, texto);
    const shot = await capturarEvidencia(page, conf.sucesso ? 'sucesso' : 'incerto');

    if (conf.sucesso) {
      registrarPublicacao(grupo.id, oferta, {
        canal: 'navegador',
        tipo: IS_CURSO ? 'curso' : 'shopee',
        group_id: grupo.group_id,
        modo: MODO,
        evidencia: conf.motivo,
        screenshot: shot,
      });
      const r = {
        ...base,
        status: 'publicado',
        confirmacao: conf.motivo,
        screenshot: shot,
        historico: true,
      };
      writeJson(RESULTADO_FILE, r);
      console.log('✅ PUBLICADO e registrado no histórico');
      await context.close();
      return r;
    }

    const r = {
      ...base,
      status: 'incerto',
      erro: conf.motivo,
      screenshot: shot,
      historico: false,
      mensagem: 'Clique em Publicar ocorreu, mas sucesso não confirmado — histórico NÃO atualizado',
    };
    writeJson(RESULTADO_FILE, r);
    console.log('⚠️', r.mensagem);
    await context.close();
    return r;
  } catch (err) {
    const r = {
      ...base,
      status: 'erro',
      erro: err.message,
      historico: false,
    };
    writeJson(RESULTADO_FILE, r);
    console.error('❌', err.message);
    if (context) await context.close().catch(() => {});
    return r;
  }
}

if (require.main === module) {
  const dry =
    String(process.env.BROWSER_DRY_RUN || 'false').toLowerCase() === 'true';
  publicarUma({ dryRun: dry })
    .then((r) => {
      console.log('Resultado:', r.status);
      process.exit(r.status === 'erro' || r.status === 'erro_sessao' ? 1 : 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = {
  publicarUma,
  escolherUmaSelecao,
  publicarSelecoesNavegador
};
