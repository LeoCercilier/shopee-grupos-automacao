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
    throw new Error('Nao foi possivel criar um novo target do Facebook via CDP');
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

async function abrirGrupo(Runtime, Page, grupoId) {
  if (typeof Page === 'string' && (grupoId === undefined || grupoId === null)) {
    grupoId = Page;
    Page = null;
  }
  const esperado = String(grupoId || '').trim();
  const url = `https://www.facebook.com/groups/${esperado}/`;
  console.log('Navegando para grupo (nao bloqueante):', url);
  if (Page && typeof Page.navigate === 'function') {
    void Page.navigate({ url }).catch((erro) => {
      console.log('Page.navigate erro:', erro && erro.message ? erro.message : String(erro));
    });
  } else if (Runtime) {
    await avaliar(Runtime, `window.location.assign(${JSON.stringify(url)})`);
  }
  await sleep(400);
  const timeoutMs = Number(process.env.CDP_NAV_TIMEOUT_MS || 20000);
  const inicio = Date.now();
  let ultimo = null;
  while (Date.now() - inicio < timeoutMs) {
    let href = '';
    if (Page && typeof Page.getNavigationHistory === 'function') {
      try {
        const hist = await Page.getNavigationHistory();
        const entries = Array.isArray(hist.entries) ? hist.entries : [];
        const idx = typeof hist.currentIndex === 'number' ? hist.currentIndex : entries.length - 1;
        href = (entries[idx] || {}).url || '';
      } catch (_) {}
    }
    if (!href || href === 'about:blank') {
      try {
        const raw = await avaliar(Runtime, `(() => JSON.stringify({ url: location.href || '' }))()`);
        href = JSON.parse(raw || '{}').url || href;
      } catch (_) {}
    }
    let pathname = '';
    let hostname = '';
    try {
      const u = new URL(String(href || ''));
      pathname = u.pathname || '';
      hostname = u.hostname || '';
    } catch (_) {
      pathname = String(href || '');
    }
    const m = pathname.match(/\/groups\/([^\/\?&#]+)/i);
    ultimo = {
      url: href || '',
      facebook: /facebook\.com/i.test(hostname) || /facebook\.com/i.test(String(href || '')),
      grupo: /\/groups\//i.test(pathname),
      groupId: m ? decodeURIComponent(m[1]) : null,
      loginPage: /\/login/i.test(pathname)
    };
    console.log('ESTADO VIA PAGE CDP', JSON.stringify(ultimo));
    if (ultimo.loginPage) throw new Error('Facebook esta solicitando login');
    if (ultimo.facebook && ultimo.grupo && String(ultimo.groupId || '') === esperado) {
      console.log('Grupo confirmado:', esperado);
      return ultimo;
    }
    await sleep(500);
  }
  throw new Error('Timeout ao navegar para o grupo ' + esperado + ' ' + JSON.stringify(ultimo));
}

async function localizarCompositor(Runtime) {
  const resultado = await avaliar(Runtime, `(() => {
    const normalizar = texto => String(texto || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const seletores = ['[role="button"]', '[aria-label]', '[data-testid]', '[contenteditable="true"]'];
    const candidatos = [...new Set(seletores.flatMap(s => [...document.querySelectorAll(s)]))];
    const textos = ['escreva algo', 'write something', 'criar publicacao', 'create post', 'o que voce esta pensando', "what's on your mind"];
    const el = candidatos.find(e => {
      const r = e.getBoundingClientRect();
      if (r.width <= 100 || r.height <= 20 || r.width >= 1200 || r.bottom <= 0 || r.top >= window.innerHeight) return false;
      const texto = normalizar(e.innerText || e.getAttribute('aria-label') || e.getAttribute('data-testid') || '');
      return textos.some(t => texto.includes(t));
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
  })()`);
  return resultado ? JSON.parse(resultado) : null;
}

async function clicarFisicamente(Input, caixa) {
  const x = caixa.x + caixa.width / 2;
  const y = caixa.y + caixa.height / 2;
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function localizarEditor(Runtime) {
  const resultado = await avaliar(Runtime, `(() => {
    const editors = [...document.querySelectorAll('[contenteditable="true"][data-lexical-editor="true"]')];
    if (!editors.length) return null;
    let editor = editors.find(el => {
      const r = el.getBoundingClientRect();
      return r.width > 50 && r.height > 10 && r.bottom > 0 && r.top < window.innerHeight;
    });
    if (!editor) editor = editors[editors.length - 1];
    editor.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    const r = editor.getBoundingClientRect();
    return JSON.stringify({ total: editors.length, x: r.x, y: r.y, width: r.width, height: r.height, texto: editor.innerText || '' });
  })()`);
  return resultado ? JSON.parse(resultado) : null;
}

async function abrirCompositorCDP(Runtime, Input) {
  const compositor = await localizarCompositor(Runtime);
  if (!compositor) throw new Error('Compositor nao encontrado');
  await clicarFisicamente(Input, compositor);
  await sleep(1000);
  const editor = await localizarEditor(Runtime);
  if (!editor) throw new Error('Editor Lexical nao encontrado');
  await clicarFisicamente(Input, editor);
  await sleep(200);
  return editor;
}

async function preencherTextoCDP(Runtime, Input, texto) {
  throw new Error('Use a versao completa de cdp.js (preencherTextoCDP)');
}

async function anexarImagemCDP(conexao, imagem) {
  throw new Error('Use a versao completa de cdp.js (anexarImagemCDP com midiaAnexada)');
}

async function localizarBotaoPublicar(Runtime) { return null; }
async function clicarPublicarCDP() { return { ok: false, motivo: 'cdp incompleto' }; }
async function confirmarPublicacaoCDP() { return { sucesso: false, motivo: 'cdp incompleto' }; }

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
