'use strict';

/**
 * Interações com a interface web do Facebook (grupos).
 * Não contorna CAPTCHA nem checkpoints — apenas detecta e interrompe.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { caminhoScreenshot } = require('./browser');
const { ensureDir } = require('../utils');

const BLOQUEIOS = [
  /checkpoint/i,
  /captcha/i,
  /security check/i,
  /verifica(ç|c)ão/i,
  /confirm (your|your identity)/i,
  /digite o c[oó]digo/i,
  /two-factor/i,
  /autentica(ç|c)ão de dois fatores/i,
  /suspicious/i,
  /temporar(ily|iamente) blocked/i,
  /conta bloqueada/i,
];

async function detectarBloqueio(page) {
  const url = page.url() || '';
  const title = await page.title().catch(() => '');
  let bodyText = '';
  try {
    bodyText = await page.locator('body').innerText({ timeout: 3000 });
  } catch (_) {}
  const blob = `${url}\n${title}\n${bodyText.slice(0, 4000)}`;

  for (const re of BLOQUEIOS) {
    if (re.test(blob)) {
      return {
        bloqueado: true,
        motivo: `Verificação/bloqueio detectado (${re}). Interrompendo — não contornamos segurança do Facebook.`,
      };
    }
  }

  if (/facebook\.com\/checkpoint/i.test(url) || /facebook\.com\/login/i.test(url)) {
    return {
      bloqueado: true,
      motivo: 'Página de login ou checkpoint. Faça login manual com npm run browser:login',
    };
  }

  return { bloqueado: false };
}

async function verificarSessaoLogada(page) {
  await page.goto('https://www.facebook.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(2000);

  const bloqueio = await detectarBloqueio(page);
  if (bloqueio.bloqueado) return { ok: false, ...bloqueio };

  const url = page.url();
  if (/facebook\.com\/login/i.test(url)) {
    return { ok: false, motivo: 'Não autenticado. Rode npm run browser:login' };
  }

  // Indicadores comuns de sessão ativa
  const logado = await page
    .locator('[aria-label="Conta"], [aria-label="Your profile"], [aria-label="Seu perfil"], div[role="navigation"]')
    .first()
    .isVisible()
    .catch(() => false);

  if (!logado && /facebook\.com\/login/i.test(url)) {
    return { ok: false, motivo: 'Sessão não detectada' };
  }

  return { ok: true };
}

function urlDoGrupo(groupId) {
  const id = String(groupId || '').trim();
  if (!id) throw new Error('group_id vazio');
  return `https://www.facebook.com/groups/${id}`;
}

async function abrirGrupo(page, groupId) {
  const url = urlDoGrupo(groupId);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  const bloqueio = await detectarBloqueio(page);
  if (bloqueio.bloqueado) return { ok: false, ...bloqueio, url };

  if (/facebook\.com\/login/i.test(page.url())) {
    return { ok: false, motivo: 'Redirecionado para login', url: page.url() };
  }

  return { ok: true, url: page.url() };
}

/**
 * Tenta abrir o compositor de publicação do grupo.
 * Seletores são frágil; várias estratégias em cascata.
 */
async function abrirCompositor(page) {
  const candidatos = [
    // Facebook em português — botão pode aparecer como "Postar"
    page.getByRole('button', { name: /^postar$/i }),
    page.getByText(/^postar$/i),

    // Outras variações da interface
    page.getByRole('button', { name: /escreva algo/i }),
    page.getByRole('button', { name: /write something/i }),
    page.getByRole('button', { name: /crie uma publicação/i }),
    page.getByRole('button', { name: /create a post/i }),

    page.getByText(/escreva algo/i),
    page.getByText(/write something/i),
    page.getByText(/crie uma publicação/i),
    page.getByText(/create a post/i),

    page.locator('[aria-label*="Postar" i]'),
    page.locator('[aria-label*="Escreva algo" i]'),
    page.locator('[aria-label*="Write something" i]'),

    page.locator('div[role="button"]').filter({
      hasText: /postar|escreva algo|write something|crie uma publicação|create a post/i
    }).first(),
  ];

  for (const loc of candidatos) {
    try {
      if (await loc.first().isVisible({ timeout: 1500 })) {
        console.log('Botão/compositor encontrado:', await loc.first().innerText().catch(() => 'sem texto'));
        await loc.first().click({ timeout: 5000 });
        await page.waitForTimeout(1500);
        return { ok: true };
      }
    } catch (_) {}
  }

  return {
    ok: false,
    motivo:
      'Não foi possível abrir o compositor. Botão "Postar"/compositor não encontrado.',
  };
}

async function preencherTexto(page, texto) {
  const message = String(texto || '');
  if (!message.trim()) {
    return { ok: false, motivo: 'Texto da publicação vazio' };
  }

  // Dá tempo para o compositor do Facebook terminar de renderizar.
  await page.waitForTimeout(1500);

  const seletores = [
    'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
    'div[role="dialog"] [contenteditable="true"][role="textbox"]',
    'div[role="dialog"] div[contenteditable="true"]',
    'div[role="dialog"] [contenteditable="true"]',
  ];

  for (const seletor of seletores) {
    try {
      const elementos = page.locator(seletor);
      const total = await elementos.count();

      for (let i = 0; i < total; i++) {
        const ed = elementos.nth(i);

        if (!(await ed.isVisible({ timeout: 1500 }))) continue;

        await ed.click({ timeout: 3000 });

        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.type(message, { delay: 10 });

        await page.waitForTimeout(500);

        console.log(`✅ Campo de texto encontrado: ${seletor}`);

        return { ok: true };
      }
    } catch (_) {}
  }

  return {
    ok: false,
    motivo: 'Campo de texto do compositor não encontrado',
  };
}

function baixarArquivo(url, destino) {
  return new Promise((resolve, reject) => {
    const mod = String(url).startsWith('https') ? https : http;
    const file = fs.createWriteStream(destino);
    mod
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(destino, () => {});
          return baixarArquivo(res.headers.location, destino).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          return reject(new Error(`HTTP ${res.statusCode} ao baixar imagem`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(destino)));
      })
      .on('error', (err) => {
        try {
          fs.unlinkSync(destino);
        } catch (_) {}
        reject(err);
      });
  });
}

async function anexarImagem(page, imageUrl) {
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
    return { ok: true, anexado: false, motivo: 'sem imagem' };
  }

  const tmpDir = path.join(__dirname, '..', '..', 'data', 'tmp');
  ensureDir(tmpDir);
  const dest = path.join(tmpDir, `img-${Date.now()}.jpg`);

  try {
    await baixarArquivo(imageUrl, dest);
  } catch (err) {
    return { ok: false, anexado: false, motivo: `Falha ao baixar imagem: ${err.message}` };
  }

  // Botão de foto/vídeo dentro do diálogo
  const botoesFoto = [
    page.locator('div[role="dialog"] [aria-label*="Foto" i]').first(),
    page.locator('div[role="dialog"] [aria-label*="Photo" i]').first(),
    page.locator('div[role="dialog"] input[type="file"]').first(),
  ];

  try {
    const fileInput = page.locator('div[role="dialog"] input[type="file"]').first();
    if (await fileInput.count()) {
      await fileInput.setInputFiles(dest);
      await page.waitForTimeout(2500);
      return { ok: true, anexado: true, arquivo: dest };
    }

    for (const btn of botoesFoto) {
      try {
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(800);
          const input2 = page.locator('input[type="file"]').first();
          if (await input2.count()) {
            await input2.setInputFiles(dest);
            await page.waitForTimeout(2500);
            return { ok: true, anexado: true, arquivo: dest };
          }
        }
      } catch (_) {}
    }
  } catch (err) {
    return { ok: false, anexado: false, motivo: err.message, arquivo: dest };
  }

  return {
    ok: true,
    anexado: false,
    motivo: 'Input de arquivo não encontrado; texto pode ser publicado sem imagem',
    arquivo: dest,
  };
}

async function clicarPublicar(page) {
  const dialog = page.locator("div[role=\"dialog\"]").filter({
    has: page.locator("[contenteditable=\"true\"][role=\"textbox\"]")
  }).first();

  const botoes = [
    dialog.getByRole("button", { name: /^postar$/i }).first(),
    dialog.getByRole("button", { name: /^publicar$/i }).first(),
    dialog.locator("[aria-label=\"Postar\"]").first(),
    dialog.locator("[aria-label=\"Publicar\"]").first(),
    dialog.locator("[role=\"button\"]").filter({ hasText: /^postar$/i }).first(),
    dialog.locator("[role=\"button\"]").filter({ hasText: /^publicar$/i }).first()
  ];

  const limite = Date.now() + 10000;

  while (Date.now() < limite) {
    for (const btn of botoes) {
      try {
        if (!(await btn.isVisible({ timeout: 500 }))) continue;

        const ariaDisabled = await btn.getAttribute("aria-disabled");
        const disabled = await btn.getAttribute("disabled");

        if (ariaDisabled === "true" || disabled !== null) continue;

        const textoBotao = await btn.innerText().catch(() => "");

        if (!/^(postar|publicar)$/i.test(textoBotao.trim())) continue;

        console.log("Botão de publicação encontrado dentro do diálogo:", textoBotao.trim());

        await btn.click({ timeout: 5000 });
        await page.waitForTimeout(3000);

        return { ok: true };
      } catch (_) {}
    }

    await page.waitForTimeout(500);
  }

  return {
    ok: false,
    motivo: "Botão Postar/Publicar não encontrado dentro do diálogo da publicação ou permaneceu desabilitado após 10 segundos"
  };
}

async function detectarSucesso(page, trechoTexto) {
  // Dá tempo para o Facebook processar o envio e exibir
  // a confirmação/estado de análise da publicação.
  await page.waitForTimeout(3000);

  const bloqueio = await detectarBloqueio(page);
  if (bloqueio.bloqueado) {
    return {
      sucesso: false,
      motivo: bloqueio.motivo
    };
  }

  // Captura o texto visível da página.
  const body = await page.locator('body').innerText().catch(() => '');

  /*
   * IMPORTANTE:
   * O Facebook pode aceitar a publicação e informar que ela está
   * sendo processada/revisada. Isso já significa que o envio foi
   * aceito, mesmo que o post ainda não apareça imediatamente no feed.
   */
  const sinaisPositivos = [
    /thanks for your post/i,
    /thanks for your post.*being/i,
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

  for (const re of sinaisPositivos) {
    if (re.test(body)) {
      return {
        sucesso: true,
        motivo: `Confirmação do Facebook: ${re}`
      };
    }
  }

  // Se o diálogo ainda estiver aberto, verificamos novamente
  // se existe alguma mensagem positiva dentro dele.
  const dialogos = page.locator('div[role="dialog"]');
  const quantidadeDialogos = await dialogos.count().catch(() => 0);

  for (let i = 0; i < Math.min(quantidadeDialogos, 5); i++) {
    const dialogoTexto = await dialogos.nth(i).innerText().catch(() => '');

    for (const re of sinaisPositivos) {
      if (re.test(dialogoTexto)) {
        return {
          sucesso: true,
          motivo: `Confirmação dentro do diálogo: ${re}`
        };
      }
    }
  }

  // 2. Procura o texto da oferta no feed do grupo.
  const trecho = String(trechoTexto || '').slice(0, 50).trim();

  if (trecho.length >= 12) {
    const elementos = page.getByText(trecho, { exact: false });
    const quantidade = await elementos.count().catch(() => 0);

    for (let i = 0; i < Math.min(quantidade, 5); i++) {
      const visivel = await elementos.nth(i).isVisible().catch(() => false);

      if (visivel) {
        return {
          sucesso: true,
          motivo: 'Texto da publicação encontrado no feed'
        };
      }
    }
  }

  /*
   * 3. Última confirmação estrutural.
   *
   * Se o diálogo de publicação fechou e o botão Postar/Publicar
   * desapareceu, o Facebook aceitou o envio.
   *
   * Não tratamos o simples clique como sucesso antes desta etapa.
   */
  const dialogo = page.locator('div[role="dialog"]').first();
  const dialogoVisivel = await dialogo.isVisible().catch(() => false);

  const botoesPublicar = [
    page.getByRole('button', { name: /^postar$/i }).first(),
    page.getByRole('button', { name: /^publicar$/i }).first(),
    page.getByRole('button', { name: /^post$/i }).first()
  ];

  let botaoVisivel = false;

  for (const botao of botoesPublicar) {
    if (await botao.isVisible().catch(() => false)) {
      botaoVisivel = true;
      break;
    }
  }

  if (!dialogoVisivel && !botaoVisivel) {
    return {
      sucesso: true,
      motivo: 'Diálogo fechado e botão de publicação não está mais visível'
    };
  }

  return {
    sucesso: false,
    motivo:
      'Não foi possível confirmar sucesso de forma confiável. Não registrando no histórico.'
  };
}

async function capturarEvidencia(page, nome) {
  const file = caminhoScreenshot(nome);
  try {
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch (_) {
    return null;
  }
}

module.exports = {
  detectarBloqueio,
  verificarSessaoLogada,
  urlDoGrupo,
  abrirGrupo,
  abrirCompositor,
  preencherTexto,
  anexarImagem,
  clicarPublicar,
  detectarSucesso,
  capturarEvidencia,
};
