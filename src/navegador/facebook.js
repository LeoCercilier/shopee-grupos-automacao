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
    page.getByRole('button', { name: /escreva algo/i }),
    page.getByRole('button', { name: /write something/i }),
    page.getByText(/escreva algo/i),
    page.getByText(/write something/i),
    page.locator('[aria-label*="Escreva algo" i]'),
    page.locator('[aria-label*="Write something" i]'),
    page.locator('div[role="button"]' ).filter({ hasText: /escreva algo|write something|crie uma publicação|create a public/i }).first(),
  ];

  for (const loc of candidatos) {
    try {
      if (await loc.first().isVisible({ timeout: 1500 })) {
        await loc.first().click({ timeout: 5000 });
        await page.waitForTimeout(1500);
        return { ok: true };
      }
    } catch (_) {}
  }

  return {
    ok: false,
    motivo:
      'Não foi possível abrir o compositor. Verifique se você é membro do grupo e se a UI mudou.',
  };
}

async function preencherTexto(page, texto) {
  const message = String(texto || '');
  if (!message.trim()) {
    return { ok: false, motivo: 'Texto da publicação vazio' };
  }

  const editores = [
    page.locator('div[role="dialog"] div[contenteditable="true"]').first(),
    page.locator('div[contenteditable="true"][role="textbox"]').first(),
    page.locator('div[aria-label*="Crie uma publicação" i]').first(),
    page.locator('div[aria-label*="Create a public" i]').first(),
    page.locator('div[aria-label*="No que você está pensando" i]').first(),
  ];

  for (const ed of editores) {
    try {
      if (await ed.isVisible({ timeout: 2000 })) {
        await ed.click({ timeout: 3000 });
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.type(message, { delay: 15 });
        await page.waitForTimeout(500);
        return { ok: true };
      }
    } catch (_) {}
  }

  return { ok: false, motivo: 'Campo de texto do compositor não encontrado' };
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
  const botoes = [
    page.locator('div[role="dialog"] [aria-label="Publicar"]').first(),
    page.locator('div[role="dialog"] [aria-label="Post"]').first(),
    page.getByRole('button', { name: /^publicar$/i }).first(),
    page.getByRole('button', { name: /^post$/i }).first(),
    page.locator('div[role="dialog"] div[aria-label="Publicar"][role="button"]').first(),
  ];

  for (const btn of botoes) {
    try {
      if (await btn.isVisible({ timeout: 2000 })) {
        const disabled = await btn.getAttribute('aria-disabled');
        if (disabled === 'true') continue;
        await btn.click({ timeout: 5000 });
        await page.waitForTimeout(3000);
        return { ok: true };
      }
    } catch (_) {}
  }

  return { ok: false, motivo: 'Botão Publicar não encontrado ou desabilitado' };
}

/**
 * Heurística de sucesso — nunca assume sucesso só pelo clique.
 */
async function detectarSucesso(page, trechoTexto) {
  await page.waitForTimeout(2000);
  const bloqueio = await detectarBloqueio(page);
  if (bloqueio.bloqueado) {
    return { sucesso: false, motivo: bloqueio.motivo };
  }

  const body = await page.locator('body').innerText().catch(() => '');
  const sinaisPositivos = [
    /publica(ç|c)ão (foi )?compartilhada/i,
    /your post (is|was)/i,
    /post shared/i,
    /publicado/i,
  ];
  for (const re of sinaisPositivos) {
    if (re.test(body)) {
      return { sucesso: true, motivo: `Sinal de UI: ${re}` };
    }
  }

  // Diálogo fechou e trecho do texto aparece no feed
  const trecho = String(trechoTexto || '').slice(0, 40).trim();
  if (trecho.length >= 12) {
    const visivel = await page.getByText(trecho).first().isVisible().catch(() => false);
    if (visivel) {
      return { sucesso: true, motivo: 'Trecho do texto visível no feed do grupo' };
    }
  }

  return {
    sucesso: false,
    motivo:
      'Não foi possível confirmar sucesso de forma confiável. Não registrando no histórico.',
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
