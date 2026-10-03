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




async function anexarImagemCDP(conexao, imagem) {
  const fs = require('fs');
  const path = require('path');

  if (!imagem) {
    return {
      ok: true,
      anexado: false,
      motivo: 'Oferta sem imagem'
    };
  }

  const DOM = conexao.client.DOM;
  const Runtime = conexao.Runtime;

  let arquivo = null;
  let diretorioTemp = null;

  try {
    await DOM.enable();

    // --------------------------------------------------------
    // Baixar a imagem para um arquivo local temporário
    // --------------------------------------------------------

    diretorioTemp = path.join(
      process.cwd(),
      '.tmp-facebook-image'
    );

    fs.mkdirSync(diretorioTemp, { recursive: true });

    const extensao = (() => {
      try {
        const url = new URL(String(imagem));
        const ext = path.extname(url.pathname).toLowerCase();

        if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'].includes(ext)) {
          return ext;
        }
      } catch (_) {}

      return '.jpg';
    })();

    arquivo = path.join(
      diretorioTemp,
      `oferta-${Date.now()}${extensao}`
    );

    if (/^data:/i.test(String(imagem))) {
      const match = String(imagem).match(/^data:[^;]+;base64,(.+)$/);

      if (!match) {
        throw new Error('Imagem data: inválida');
      }

      fs.writeFileSync(
        arquivo,
        Buffer.from(match[1], 'base64')
      );
    } else {
      const resposta = await fetch(String(imagem), {
        redirect: 'follow'
      });

      if (!resposta.ok) {
        throw new Error(
          `Falha ao baixar imagem: HTTP ${resposta.status}`
        );
      }

      const buffer = Buffer.from(
        await resposta.arrayBuffer()
      );

      if (!buffer.length) {
        throw new Error('Imagem baixada está vazia');
      }

      fs.writeFileSync(arquivo, buffer);
    }

    const tamanho = fs.statSync(arquivo).size;

    if (!tamanho) {
      throw new Error('Arquivo temporário da imagem está vazio');
    }

    console.log(`🖼️ Imagem baixada: ${tamanho} bytes`);

    // --------------------------------------------------------
    // Encontrar o input de arquivo associado ao compositor
    // --------------------------------------------------------

    // --------------------------------------------------------
    // Encontrar diretamente o input[type=file] do compositor.
    //
    // Não usar índice vindo de Runtime.evaluate para mapear
    // nodeId: Runtime e DOM podem apresentar árvores diferentes.
    // --------------------------------------------------------

    let documento = await DOM.getDocument({
      depth: -1,
      pierce: true
    });

    let dialogos = await DOM.querySelectorAll({
      nodeId: documento.root.nodeId,
      selector: 'div[role="dialog"]'
    });

    let nodeId = null;

    // Primeiro: procurar dentro dos diálogos já existentes.
    for (const dialogNodeId of (dialogos.nodeIds || [])) {
      const inputs = await DOM.querySelectorAll({
        nodeId: dialogNodeId,
        selector: 'input[type="file"]'
      });

      if (inputs.nodeIds && inputs.nodeIds.length) {
        nodeId = inputs.nodeIds[0];
        console.log('📎 Input de imagem encontrado dentro do diálogo');
        break;
      }
    }

    // Segundo: se não encontrou, clicar no botão Foto/vídeo
    // dentro do compositor e procurar novamente.
    if (!nodeId) {
      console.log(
        'ℹ️ Input não encontrado; procurando botão Foto/vídeo...'
      );

      const cliqueFoto = await avaliar(Runtime, `(() => {
        const dialogos = [
          ...document.querySelectorAll('div[role="dialog"]')
        ];

        for (const dialog of dialogos) {
          const candidatos = [
            ...dialog.querySelectorAll(
              '[aria-label*="Foto" i], ' +
              '[aria-label*="Photo" i], ' +
              '[aria-label*="vídeo" i], ' +
              '[aria-label*="video" i]'
            )
          ];

          for (const el of candidatos) {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();

            if (
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              rect.width > 0 &&
              rect.height > 0
            ) {
              el.click();

              return JSON.stringify({
                ok: true,
                tag: el.tagName,
                aria: el.getAttribute('aria-label')
              });
            }
          }
        }

        return JSON.stringify({
          ok: false,
          motivo: 'Botão Foto/vídeo não encontrado'
        });
      })()`);

      console.log(
        '📷 Resultado clique Foto/vídeo:',
        cliqueFoto
      );

      await sleep(1000);

      documento = await DOM.getDocument({
        depth: -1,
        pierce: true
      });

      dialogos = await DOM.querySelectorAll({
        nodeId: documento.root.nodeId,
        selector: 'div[role="dialog"]'
      });

      for (const dialogNodeId of (dialogos.nodeIds || [])) {
        const inputs = await DOM.querySelectorAll({
          nodeId: dialogNodeId,
          selector: 'input[type="file"]'
        });

        if (inputs.nodeIds && inputs.nodeIds.length) {
          nodeId = inputs.nodeIds[0];

          console.log(
            '📎 Input de imagem encontrado após Foto/vídeo'
          );

          break;
        }
      }
    }

    if (!nodeId) {
      throw new Error(
        'Input[type=file] não encontrado dentro do diálogo do compositor'
      );
    }

    // --------------------------------------------------------
    // Entregar arquivo diretamente ao input[type=file]
    // --------------------------------------------------------

    await DOM.setFileInputFiles({
      nodeId,
      files: [arquivo]
    });

    console.log('📤 Arquivo entregue ao input[type=file]');

    // --------------------------------------------------------
    // DIAGNÓSTICO PÓS-UPLOAD
    // --------------------------------------------------------

    await sleep(8000);

    const diagnosticoUpload = await avaliar(Runtime, `(() => {
      try {
        const inputs = Array.from(
          document.querySelectorAll('input[type="file"]')
        ).map((el, index) => ({
          index,
          files: el.files ? el.files.length : 0,
          accept: el.getAttribute('accept') || '',
          aria: el.getAttribute('aria-label') || ''
        }));

        const imgs = Array.from(
          document.querySelectorAll('img')
        ).filter(el => {
          try {
            const r = el.getBoundingClientRect();
            return r.width > 40 && r.height > 40;
          } catch (_) {
            return false;
          }
        }).length;

        const videos = Array.from(
          document.querySelectorAll('video')
        ).filter(el => {
          try {
            const r = el.getBoundingClientRect();
            return r.width > 40 && r.height > 40;
          } catch (_) {
            return false;
          }
        }).length;

        const canvases = Array.from(
          document.querySelectorAll('canvas')
        ).filter(el => {
          try {
            return el.width > 40 && el.height > 40;
          } catch (_) {
            return false;
          }
        }).length;

        const bodyTexto = String(
          document.body && document.body.innerText || ''
        );

        return JSON.stringify({
          ok: true,
          inputs,
          imagensVisiveis: imgs,
          videosVisiveis: videos,
          canvasesVisiveis: canvases,
          indiciosTexto:
            /remover foto|remove photo|editar foto|edit photo|foto adicionada|photo added|adicionar foto|add photo/i
              .test(bodyTexto)
        });
      } catch (erro) {
        return JSON.stringify({
          ok: false,
          erro: String(
            erro && erro.message || erro
          )
        });
      }
    })()`);

    console.log('');
    console.log('=== DIAGNÓSTICO PÓS-UPLOAD ===');
    console.log(diagnosticoUpload);

    // --------------------------------------------------------
    // Confirmar que o Facebook recebeu/processou a imagem
    // --------------------------------------------------------

    let confirmado = false;

    for (let tentativa = 0; tentativa < 20; tentativa++) {
      await sleep(500);

      const estado = await avaliar(Runtime, `(() => {
        const inputs = [
          ...document.querySelectorAll('input[type="file"]')
        ];

        const recebeuArquivo = inputs.some(
          el => el.files && el.files.length > 0
        );

        const imagens = [
          ...document.querySelectorAll('img')
        ].filter(img => {
          const r = img.getBoundingClientRect();

          return (
            r.width > 40 &&
            r.height > 40 &&
            r.bottom > 0 &&
            r.top < window.innerHeight
          );
        });

        const textos = document.body.innerText || '';

        const indicioPreview =
          /remover foto|remove photo|editar foto|edit photo|foto adicionada|photo added/i.test(textos);

        return JSON.stringify({
          recebeuArquivo,
          imagensVisiveis: imagens.length,
          indicioPreview
        });
      })()`);

      let info;

      try {
        info = JSON.parse(estado);
      } catch (_) {
        info = {};
      }

      if (
        info.recebeuArquivo ||
        info.indicioPreview
      ) {
        confirmado = true;
        break;
      }
    }

    if (!confirmado) {
      throw new Error(
        'Facebook não confirmou o recebimento/preview da imagem'
      );
    }

    console.log('✅ Imagem recebida pelo Facebook');

    return {
      ok: true,
      anexado: true,
      arquivo_temporario: true,
      motivo: 'upload confirmado pelo Facebook'
    };

  } catch (erro) {
    return {
      ok: false,
      anexado: false,
      motivo: erro.message || String(erro)
    };

  } finally {
    // --------------------------------------------------------
    // Limpar arquivo temporário
    // --------------------------------------------------------

    try {
      if (arquivo && fs.existsSync(arquivo)) {
        fs.unlinkSync(arquivo);
      }
    } catch (_) {}

    try {
      if (
        diretorioTemp &&
        fs.existsSync(diretorioTemp) &&
        fs.readdirSync(diretorioTemp).length === 0
      ) {
        fs.rmdirSync(diretorioTemp);
      }
    } catch (_) {}
  }
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
  anexarImagemCDP,
  clicarPublicarCDP,
  confirmarPublicacaoCDP,
  sleep
};
