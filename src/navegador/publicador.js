'use strict';

/**
 * Publicador por navegador (MVP).
 *
 * - Lê data/selecao-atual.json
 * - Processa SOMENTE 1 seleção (primeira elegível ou filtrada)
 * - Usa sessão local (.browser-session)
 * - Por padrão MODO=preparar: preenche o compositor e NÃO clica em Publicar
 * - Com MODO=publicar: tenta clicar e só registra histórico se houver confirmação
 *
 * NÃO usa senha, NÃO versiona cookies, NÃO contorna CAPTCHA.
 */

const path = require('path');
const { readJson, writeJson, nowIso } = require('../utils');
const { jaPublicadoRecentemente, registrarPublicacao } = require('../historico');
const { criarContexto, novaPagina } = require('./browser');
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

const ROOT = path.join(__dirname, '..', '..');
const SELECAO_FILE = path.join(ROOT, 'data', 'selecao-atual.json');
const RESULTADO_FILE = path.join(ROOT, 'data', 'resultado-publicacao-browser.json');

const MODO = String(process.env.MODO_PUBLICACAO_BROWSER || 'preparar').toLowerCase();
// preparar | publicar

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

async function publicarUma({ dryRun = false } = {}) {
  console.log('========================================');
  console.log(' PUBLICADOR NAVEGADOR — MVP (1×1)');
  console.log('========================================');
  console.log('Modo:', MODO);
  console.log('Dry-run navegador:', dryRun);

  const selecao = readJson(SELECAO_FILE);
  if (!selecao || !Array.isArray(selecao.selecoes) || selecao.selecoes.length === 0) {
    const vazio = {
      gerado_em: nowIso(),
      status: 'sem_selecao',
      mensagem: 'data/selecao-atual.json vazio — rode o pipeline antes',
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
  const oferta = item.oferta;
  const texto = item.texto || '';

  const base = {
    gerado_em: nowIso(),
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

    const comp = await abrirCompositor(page);
    if (!comp.ok) {
      const shot = await capturarEvidencia(page, 'compositor');
      const r = { ...base, status: 'erro_compositor', erro: comp.motivo, screenshot: shot };
      writeJson(RESULTADO_FILE, r);
      console.log('❌', r.erro);
      await context.close();
      return r;
    }

    const txt = await preencherTexto(page, texto);
    if (!txt.ok) {
      const shot = await capturarEvidencia(page, 'texto');
      const r = { ...base, status: 'erro_texto', erro: txt.motivo, screenshot: shot };
      writeJson(RESULTADO_FILE, r);
      console.log('❌', r.erro);
      await context.close();
      return r;
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

    // MODO=publicar
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

module.exports = { publicarUma, escolherUmaSelecao };
