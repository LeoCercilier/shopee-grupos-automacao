const CDP = require('chrome-remote-interface');

const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.CDP_PORT || 9222);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function listarTargets() {
  return await CDP.List({ host: HOST, port: PORT });
}

async function encontrarFacebookTarget() {
  const alvo = await CDP.New({
    host: HOST,
    port: PORT,
    url: 'https://web.facebook.com/'
  });
  if (!alvo || !alvo.webSocketDebuggerUrl) {
    throw new Error('Não foi possível criar um novo target do Facebook via CDP');
  }
  await sleep(2000);
  return alvo;
}

async function conectarFacebook() {
  const target = await encontrarFacebookTarget();
  const client = await CDP({ target: target.webSocketDebuggerUrl });
  const { Runtime, Input, Page } = client;
  await Runtime.enable();
  await Page.enable();
  return { client, Runtime, Input, Page, target };
}

async function avaliar(Runtime, expression) {
  const resultado = await Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (resultado.exceptionDetails) {
    throw new Error(
      resultado.exceptionDetails.text || 'Erro ao executar JavaScript no Facebook'
    );
  }
  return resultado.result?.value;
}

/**
 * TEMP: versão mínima de emergência.
 * Substitua pelo cdp.js completo com midiaAnexada / navegação não bloqueante.
 */
async function abrirGrupo(Runtime, Page, grupoId) {
  if (typeof Page === 'string' && (grupoId === undefined || grupoId === null)) {
    grupoId = Page;
    Page = null;
  }
  const esperado = String(grupoId || '').trim();
  const url = `https://www.facebook.com/groups/${esperado}/`;
  console.log('➡️ Navegando para grupo (mínimo):', url);
  if (Page && typeof Page.navigate === 'function') {
    void Page.navigate({ url }).catch(() => {});
  } else {
    await avaliar(Runtime, `window.location.assign(${JSON.stringify(url)})`);
  }
  await sleep(5000);
  const estado = await avaliar(Runtime, `(() => JSON.stringify({
    url: location.href,
    facebook: location.hostname.includes('facebook.com'),
    grupo: location.pathname.includes('/groups/'),
    groupId: (location.pathname.match(/\/groups\/([^\/]+)/)||[])[1] || null,
    loginPage: location.pathname.includes('/login')
  }))()`);
  return JSON.parse(estado);
}

async function localizarCompositor() { return null; }
async function localizarEditor() { return null; }
async function abrirCompositorCDP() { throw new Error('cdp.js incompleto — restaure o arquivo completo'); }
async function preencherTextoCDP() { throw new Error('cdp.js incompleto — restaure o arquivo completo'); }
async function localizarBotaoPublicar() { return null; }
async function anexarImagemCDP() { return { ok: false, anexado: false, motivo: 'cdp.js incompleto' }; }
async function clicarPublicarCDP() { return { ok: false, motivo: 'cdp.js incompleto' }; }
async function confirmarPublicacaoCDP() { return { sucesso: false, motivo: 'cdp.js incompleto' }; }

module.exports = {
  listarTargets,
  encontrarFacebookTarget,
  conectarFacebook,
  avaliar,
  abrirGrupo,
  localizarCompositor,
  localizarEditor,
  abrirCompositorCDP,
  preencherTextoCDP,
  localizarBotaoPublicar,
  anexarImagemCDP,
  clicarPublicarCDP,
  confirmarPublicacaoCDP,
  sleep
};
