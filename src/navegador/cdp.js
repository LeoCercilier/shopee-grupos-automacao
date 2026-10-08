const CDP = require('chrome-remote-interface');

const HOST = process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.CDP_PORT || 9222);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function listarTargets() {
  return await CDP.List({
    host: HOST,
    port: PORT
  });
}

async function encontrarFacebookTarget() {
  // Sempre cria uma nova página do Facebook para evitar reutilizar
  // targets antigos que podem ficar presos no Runtime.enable.
  const alvo = await CDP.New({
    host: HOST,
    port: PORT,
    url: 'https://web.facebook.com/'
  });

  if (!alvo || !alvo.webSocketDebuggerUrl) {
    throw new Error(
      'Não foi possível criar um novo target do Facebook via CDP'
    );
  }

  await sleep(2000);

  return alvo;
}

async function conectarFacebook() {
  const target = await encontrarFacebookTarget();

  const client = await CDP({
    target: target.webSocketDebuggerUrl
  });

  const { Runtime, Input, Page } = client;

  await Runtime.enable();
  await Page.enable();

  return {
    client,
    Runtime,
    Input,
    Page,
    target
  };
}

async function avaliar(Runtime, expression) {
  const resultado = await Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true
  });

  if (resultado.exceptionDetails) {
    throw new Error(
      resultado.exceptionDetails.text ||
      'Erro ao executar JavaScript no Facebook'
    );
  }

  return resultado.result?.value;
}

/**
 * Navega para o grupo sem bloquear.
 * Preferência: Page.navigate em fire-and-forget + polling getNavigationHistory.
 * Fallback: location.assign via Runtime.
 * Assinatura: (Runtime, Page, grupoId) — Page pode ser omitido (compat).
 */
async function abrirGrupo(Runtime, Page, grupoId) {
  if (typeof Page === 'string' && (grupoId === undefined || grupoId === null)) {
    grupoId = Page;
    Page = null;
  }

  const esperado = String(grupoId || '').trim();
  if (!esperado) {
    throw new Error('group_id vazio ao abrir grupo');
  }

  const url = `https://www.facebook.com/groups/${esperado}/`;
  const timeoutMs = Math.max(
    5000,
    Number.parseInt(process.env.CDP_NAV_TIMEOUT_MS || '20000', 10) || 20000
  );

  console.log('➡️ Navegando para grupo (não bloqueante):', url);

  if (Page && typeof Page.navigate === 'function') {
    void Page.navigate({ url }).catch((erro) => {
      console.log(
        `⚠️ Page.navigate() retornou erro: ${erro && erro.message ? erro.message : String(erro)}`
      );
    });
  } else if (Runtime) {
    await avaliar(
      Runtime,
      `window.location.assign(${JSON.stringify(url)})`
    );
  } else {
    throw new Error('abrirGrupo: Page/Runtime indisponíveis');
  }

  await sleep(400);

  const inicio = Date.now();
  let ultimo = null;

  while (Date.now() - inicio < timeoutMs) {
    let href = '';
    let titulo = '';

    if (Page && typeof Page.getNavigationHistory === 'function') {
      try {
        const hist = await Page.getNavigationHistory();
        const entries = Array.isArray(hist.entries) ? hist.entries : [];
        const idx =
          typeof hist.currentIndex === 'number'
            ? hist.currentIndex
            : entries.length - 1;
        const entry = entries[idx] || {};
        href = entry.url || '';
        titulo = entry.title || '';
      } catch (err) {
        console.log(
          '⚠️ getNavigationHistory:',
          err && err.message ? err.message : String(err)
        );
      }
    }

    if ((!href || href === 'about:blank') && Runtime) {
      try {
        const raw = await avaliar(
          Runtime,
          `(() => JSON.stringify({
            url: location.href || '',
            titulo: document.title || ''
          }))()`
        );
        const dom = JSON.parse(raw || '{}');
        href = dom.url || href;
        titulo = dom.titulo || titulo;
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
    const groupIdAtual = m ? decodeURIComponent(m[1]) : null;

    ultimo = {
      url: href || '',
      titulo: titulo || '',
      facebook:
        /facebook\.com/i.test(hostname) ||
        /facebook\.com/i.test(String(href || '')),
      grupo:
        /\/groups\//i.test(pathname) ||
        /\/groups\//i.test(String(href || '')),
      groupId: groupIdAtual,
      loginPage:
        /\/login/i.test(pathname) || /\/login/i.test(String(href || '')),
    };

    console.log('=== ESTADO ATUAL VIA PAGE CDP ===');
    console.log(JSON.stringify(ultimo, null, 2));

    if (ultimo.loginPage) {
      throw new Error('Facebook está solicitando login');
    }

    if (
      ultimo.facebook === true &&
      ultimo.grupo === true &&
      String(ultimo.groupId || '') === esperado &&
      ultimo.loginPage === false
    ) {
      console.log('✅ Grupo confirmado:', esperado);
      return ultimo;
    }

    await sleep(500);
  }

  throw new Error(
    'Timeout ao navegar para o grupo ' +
      esperado +
      '. Último estado: ' +
      JSON.stringify(ultimo)
  );
}
