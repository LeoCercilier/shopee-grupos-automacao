'use strict';

/**
 * Gerencia o navegador Playwright com perfil persistente.
 *
 * Compatível com:
 * - Linux
 * - COGO / ambiente Linux no Android
 * - computador Linux
 *
 * A sessão fica em .browser-session/ e nunca deve ser versionada.
 */

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('../utils');

const ROOT = path.join(__dirname, '..', '..');
const SESSION_DIR = path.join(ROOT, '.browser-session');
const SCREENSHOTS_DIR = path.join(ROOT, 'data', 'screenshots');

function encontrarChromium() {
  // Caminho informado explicitamente pelo usuário/ambiente.
  if (process.env.BROWSER_EXECUTABLE_PATH) {
    const informado = process.env.BROWSER_EXECUTABLE_PATH;

    if (fs.existsSync(informado)) {
      return informado;
    }

    throw new Error(
      `BROWSER_EXECUTABLE_PATH foi definido, mas o arquivo não existe: ${informado}`
    );
  }

  // Caminhos comuns em ambientes Linux/COGO.
  const candidatos = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ];

  for (const caminho of candidatos) {
    if (fs.existsSync(caminho)) {
      return caminho;
    }
  }

  return null;
}

function obterArgumentosNavegador() {
  const args = [
    '--disable-notifications',
    '--disable-dev-shm-usage',
  ];

  /*
   * Em alguns ambientes Linux dentro do Android,
   * o sandbox do Chromium não funciona corretamente.
   *
   * Só ativamos essas opções quando explicitamente solicitado.
   */
  const semSandbox =
    String(process.env.BROWSER_NO_SANDBOX || 'false').toLowerCase() === 'true';

  if (semSandbox) {
    args.push(
      '--no-sandbox',
      '--disable-setuid-sandbox'
    );
  }

  return args;
}

async function criarContexto(opcoes = {}) {
  let playwright;

  try {
    playwright = require('playwright');
  } catch (_) {
    throw new Error(
      'Playwright não instalado. Execute: npm install'
    );
  }

  ensureDir(SESSION_DIR);
  ensureDir(SCREENSHOTS_DIR);

  const headless =
    opcoes.headless != null
      ? Boolean(opcoes.headless)
      : String(
          process.env.BROWSER_HEADLESS || 'false'
        ).toLowerCase() === 'true';

  const executablePath =
    opcoes.executablePath || encontrarChromium();

  const opcoesChromium = {
    headless,
    viewport: {
      width: 1280,
      height: 900,
    },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    args: obterArgumentosNavegador(),
    acceptDownloads: true,
  };

  /*
   * Se existir Chromium instalado pelo sistema,
   * usamos esse navegador.
   *
   * Isso é importante no COGO porque o Chromium
   * do Playwright pode não ser executável no
   * ambiente Android/Linux utilizado pelo aplicativo.
   */
  if (executablePath) {
    opcoesChromium.executablePath = executablePath;

    console.log('🌐 Chromium encontrado:');
    console.log(`   ${executablePath}`);
  } else {
    console.log('⚠️ Nenhum Chromium do sistema encontrado.');
    console.log('');
    console.log(
      'Instale um Chromium compatível ou defina:'
    );
    console.log(
      'BROWSER_EXECUTABLE_PATH=/caminho/para/chromium'
    );
    console.log('');
  }

  if (
    String(process.env.BROWSER_NO_SANDBOX || 'false').toLowerCase() ===
    'true'
  ) {
    console.log('⚠️ Chromium executando sem sandbox.');
  }

  const context =
    await playwright.chromium.launchPersistentContext(
      SESSION_DIR,
      opcoesChromium
    );

  return context;
}

async function novaPagina(context) {
  const pages = context.pages();

  if (pages.length > 0) {
    return pages[0];
  }

  return context.newPage();
}

function caminhoScreenshot(nome) {
  const safe = String(nome || 'shot')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);

  return path.join(
    SCREENSHOTS_DIR,
    `${Date.now()}-${safe}.png`
  );
}

module.exports = {
  SESSION_DIR,
  SCREENSHOTS_DIR,
  criarContexto,
  novaPagina,
  caminhoScreenshot,
  encontrarChromium,
};
