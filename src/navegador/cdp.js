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

async function abrirGrupo(Runtime, grupoId) {
  const url = `https://www.facebook.com/groups/${grupoId}/`;

  await avaliar(
    Runtime,
    `location.href = ${JSON.stringify(url)}`
  );

  await sleep(5000);

  const estado = await avaliar(Runtime, `(() => {
    const href = location.href;
    const pathname = location.pathname;
    const hostname = location.hostname;

    return JSON.stringify({
      url: href,
      titulo: document.title,
      facebook: hostname.includes('facebook.com'),
      grupo: pathname.includes('/groups/'),
      loginPage: pathname.includes('/login')
    });
  })()`);

  const dados = JSON.parse(estado);

  if (dados.loginPage) {
    throw new Error('Facebook está solicitando login');
  }

  if (!dados.facebook || !dados.grupo) {
    throw new Error(
      'Grupo do Facebook não foi carregado corretamente'
    );
  }

  return dados;
}

async function localizarCompositor(Runtime) {
  const resultado = await avaliar(Runtime, `(() => {
    const normalizar = texto =>
      String(texto || '')
        .replace(/\\s+/g, ' ')
        .trim()
        .toLowerCase();

    const seletores = [
      '[role="button"]',
      '[aria-label]',
      '[data-testid]',
      '[contenteditable="true"]'
    ];

    const candidatos = [
      ...new Set(
        seletores.flatMap(seletor =>
          [...document.querySelectorAll(seletor)]
        )
      )
    ];

    const textos = [
      'escreva algo',
      'write something',
      'criar publicação',
      'create post',
      'o que você está pensando',
      "what's on your mind"
    ];

    const el = candidatos.find(e => {
      const r = e.getBoundingClientRect();

      if (
        r.width <= 100 ||
        r.height <= 20 ||
        r.width >= 1200 ||
        r.bottom <= 0 ||
        r.top >= window.innerHeight
      ) {
        return false;
      }

      const texto = normalizar(
        e.innerText ||
        e.getAttribute('aria-label') ||
        e.getAttribute('data-testid') ||
        ''
      );

      return textos.some(t => texto.includes(t));
    });

    if (!el) return null;

    const r = el.getBoundingClientRect();

    return JSON.stringify({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height
    });
  })()`);

  return resultado ? JSON.parse(resultado) : null;
}

async function clicarFisicamente(Input, caixa) {
  const x = caixa.x + caixa.width / 2;
  const y = caixa.y + caixa.height / 2;

  await Input.dispatchMouseEvent({
    type: 'mouseMoved',
    x,
    y
  });

  await Input.dispatchMouseEvent({
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  });

  await Input.dispatchMouseEvent({
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  });
}

async function localizarEditor(Runtime) {
  const resultado = await avaliar(Runtime, `(() => {
    const editors = [
      ...document.querySelectorAll(
        '[contenteditable="true"][data-lexical-editor="true"]'
      )
    ];

    if (!editors.length) return null;

    let editor = editors.find(el => {
      const r = el.getBoundingClientRect();

      return (
        r.width > 50 &&
        r.height > 10 &&
        r.bottom > 0 &&
        r.top < window.innerHeight
      );
    });

    if (!editor) {
      editor = editors[editors.length - 1];
    }

    editor.scrollIntoView({
      behavior: 'instant',
      block: 'center',
      inline: 'center'
    });

    const r = editor.getBoundingClientRect();

    return JSON.stringify({
      total: editors.length,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      texto: editor.innerText || ''
    });
  })()`);

  return resultado ? JSON.parse(resultado) : null;
}

async function abrirCompositorCDP(Runtime, Input) {
  const compositor = await localizarCompositor(Runtime);

  if (!compositor) {
    throw new Error(
      'Compositor "Escreva algo..." não encontrado'
    );
  }

  await clicarFisicamente(Input, compositor);

  await sleep(1000);

  const editor = await localizarEditor(Runtime);

  if (!editor) {
    throw new Error(
      'Editor Lexical do Facebook não encontrado'
    );
  }

  await clicarFisicamente(Input, editor);

  await sleep(200);

  const foco = await avaliar(Runtime, `(() => {
    const editors = [
      ...document.querySelectorAll(
        '[contenteditable="true"][data-lexical-editor="true"]'
      )
    ];

    const el = editors.find(e => {
      const r = e.getBoundingClientRect();

      return (
        r.width > 50 &&
        r.height > 10 &&
        r.bottom > 0 &&
        r.top < window.innerHeight
      );
    }) || editors[editors.length - 1];

    if (!el) return false;

    el.focus();

    return document.activeElement === el;
  })()`);

  if (!foco) {
    throw new Error(
      'Editor Lexical não recebeu foco'
    );
  }

  return editor;
}


async function localizarBotaoPublicar(Runtime) {
  const resultado = await avaliar(Runtime, `(() => {
    const elementos = [...document.querySelectorAll(
      'button, [role="button"]'
    )];

    const candidatos = elementos.filter(el => {
      const r = el.getBoundingClientRect();

      if (
        r.width <= 0 ||
        r.height <= 0 ||
        r.bottom <= 0 ||
        r.top >= window.innerHeight
      ) {
        return false;
      }

      const texto = (
        el.innerText ||
        el.getAttribute('aria-label') ||
        ''
      ).trim();

      if (!/^(postar|publicar)$/i.test(texto)) {
        return false;
      }

      const ariaDisabled = el.getAttribute('aria-disabled');
      const disabled = el.hasAttribute('disabled');

      if (ariaDisabled === 'true' || disabled) {
        return false;
      }

      return true;
    });

    if (!candidatos.length) return null;

    const el = candidatos[candidatos.length - 1];
    const r = el.getBoundingClientRect();

    return JSON.stringify({
      texto: (
        el.innerText ||
        el.getAttribute('aria-label') ||
        ''
      ).trim(),
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height
    });
  })()`);

  return resultado ? JSON.parse(resultado) : null;
}

async function clicarPublicarCDP(Runtime, Input) {
  const limite = Date.now() + 10000;

  while (Date.now() < limite) {
    const botao = await localizarBotaoPublicar(Runtime);

    if (botao) {
      console.log(
        '🟢 Botão de publicação encontrado:',
        botao.texto
      );

      await clicarFisicamente(Input, botao);
      await sleep(3000);

      return {
        ok: true,
        botao: botao.texto
      };
    }

    await sleep(500);
  }

  return {
    ok: false,
    motivo:
      'Botão Postar/Publicar não encontrado ou permaneceu desabilitado por 10 segundos'
  };
}

async function confirmarPublicacaoCDP(Runtime, titulo) {
  await sleep(3000);

  const resultado = await avaliar(Runtime, `(() => {
    const dialogos = [
      ...document.querySelectorAll('[role="dialog"]')
    ];

    const textos = dialogos.map(el =>
      (el.innerText || '').trim()
    );

    const positivos = [
      /thanks for your post/i,
      /your post is being/i,
      /your post is pending/i,
      /your post was submitted/i,
      /your post has been submitted/i,
      /post submitted/i,
      /post shared/i,
      /your post (is|was) shared/i,
      /obrigado pela sua publica(ç|c)ão/i,
      /sua publica(ç|c)ão.*está sendo/i,
      /sua publica(ç|c)ão.*enviada/i,
      /sua publica(ç|c)ão foi enviada/i,
      /sua publica(ç|c)ão foi compartilhada/i,
      /publica(ç|c)ão compartilhada/i,
      /publicado com sucesso/i
    ];

    for (const texto of textos) {
      for (const re of positivos) {
        if (re.test(texto)) {
          return JSON.stringify({
            sucesso: true,
            motivo: 'Confirmação encontrada no diálogo'
          });
        }
      }
    }

    const tituloTexto = String(${JSON.stringify(titulo || '')}).slice(0, 60);

    if (tituloTexto.length >= 12) {
      const encontrados = [...document.querySelectorAll('*')]
        .filter(el => {
          const r = el.getBoundingClientRect();

          return (
            r.width > 0 &&
            r.height > 0 &&
            r.bottom > 0 &&
            r.top < window.innerHeight &&
            (el.innerText || '').includes(tituloTexto)
          );
        });

      if (encontrados.length) {
        return JSON.stringify({
          sucesso: true,
          motivo: 'Título da publicação encontrado na página'
        });
      }
    }

    const dialogoVisivel = dialogos.some(el => {
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.top < window.innerHeight
      );
    });

    const botoes = [
      ...document.querySelectorAll(
        'button, [role="button"]'
      )
    ];

    const botaoPublicarVisivel = botoes.some(el => {
      const texto = (
        el.innerText ||
        el.getAttribute('aria-label') ||
        ''
      ).trim();

      const r = el.getBoundingClientRect();

      return (
        /^(postar|publicar)$/i.test(texto) &&
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.top < window.innerHeight
      );
    });

    if (!dialogoVisivel && !botaoPublicarVisivel) {
      return JSON.stringify({
        sucesso: true,
        motivo:
          'Diálogo fechado e botão de publicação não está mais visível'
      });
    }

    return JSON.stringify({
      sucesso: false,
      motivo:
        'Facebook não forneceu confirmação confiável da publicação'
    });
  })()`);

  return resultado ? JSON.parse(resultado) : {
    sucesso: false,
    motivo: 'Não foi possível verificar a confirmação'
  };
}

async function preencherTextoCDP(Runtime, Input, texto) {
  const foco = await avaliar(Runtime, `(() => {
    const editors = [
      ...document.querySelectorAll(
        '[contenteditable="true"][data-lexical-editor="true"]'
      )
    ];

    const el = editors.find(e => {
      const r = e.getBoundingClientRect();

      return (
        r.width > 50 &&
        r.height > 10 &&
        r.bottom > 0 &&
        r.top < window.innerHeight
      );
    }) || editors[editors.length - 1];

    if (!el) return false;

    el.focus();

    return document.activeElement === el;
  })()`);

  if (!foco) {
    throw new Error(
      'Não foi possível focar o editor Lexical'
    );
  }

  await Input.insertText({
    text: String(texto)
  });

  await sleep(1000);

  const verificacao = await avaliar(Runtime, `(() => {
    const editors = [
      ...document.querySelectorAll(
        '[contenteditable="true"][data-lexical-editor="true"]'
      )
    ];

    const el = editors.find(e => {
      const r = e.getBoundingClientRect();

      return (
        r.width > 50 &&
        r.height > 10 &&
        r.bottom > 0 &&
        r.top < window.innerHeight
      );
    }) || editors[editors.length - 1];

    const atual = el?.innerText || '';

    return JSON.stringify({
      encontrado: !!el,
      texto: atual,
      comprimento: atual.length,
      ativo: document.activeElement === el
    });
  })()`);

  return JSON.parse(verificacao);
}

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
  clicarPublicarCDP,
  confirmarPublicacaoCDP,
  sleep
};
