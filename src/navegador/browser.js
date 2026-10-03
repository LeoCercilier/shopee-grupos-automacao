'use strict';

/**
 * Gerencia o navegador Playwright com perfil persistente.
 *
 * Compatível com:
 * - Linux
 * - COGO / ambiente Linux no Android
 * - computador Linux
 * - GitHub Actions (sessão via BROWSER_STORAGE_STATE_B64)
 *
 * A sessão local fica em .browser-session/ e nunca deve ser versionada.
 * Em CI, use o Secret BROWSER_STORAGE_STATE_B64 (storageState Playwright em base64).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
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
    process.env.PREFIX + '/lib/chromium/chromium-launcher.sh',
  ];

  for (const caminho of candidatos) {
    if (caminho && fs.existsSync(caminho)) {
      return caminho;
    }
  }

  return null;
}

/**
 * Decodifica BROWSER_STORAGE_STATE_B64 (storageState Playwright em JSON base64).
 * Não grava cookies/tokens em disco versionado — apenas retorna o objeto em memória.
 * Retorna null se a variável não estiver definida.
 */
function obterStorageStateDeEnv() {
  const b64 = String(process.env.BROWSER_STORAGE_STATE_B64 || '').trim();
  if (!b64) return null;

  let json;
  try {
    json = Buffer.from(b64, 'base64').toString('utf8');
  } catch (err) {
    throw new Error(
      'BROWSER_STORAGE_STATE_B64 inválido (base64): ' + (err.message || String(err))
    );
  }

  let state;
  try {
    state = JSON.parse(json);
  } catch (err) {
    throw new Error(
      'BROWSER_STORAGE_STATE_B64 não é JSON válido de storageState: ' +
        (err.message || String(err))
    );
  }

  if (!state || typeof state !== 'object') {
    throw new Error('BROWSER_STORAGE_STATE_B64: storageState deve ser um objeto JSON.');
  }

  return state;
}

function obterArgumentosNavegador() {
  const args = [
    '--disable-notifications',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--ozone-platform=x11',
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
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }

  return args;
}

/**
 * Diretório do perfil persistente.
 * Com storageState de CI, usa diretório temporário para não misturar com .browser-session local.
 */
function obterUserDataDir(storageState) {
  if (storageState) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sga-browser-'));
    return dir;
  }
  ensureDir(SESSION_DIR);
  return SESSION_DIR;
}

async function criarContexto(opcoes = {}) {
  let playwright;

  try {
    playwright = require('playwright');
  } catch (_) {
    throw new Error(
      'Erro real ao carregar Playwright: ' + (_.message || String(_))
    );
  }

  ensureDir(SCREENSHOTS_DIR);

  const storageState =
    opcoes.storageState != null
      ? opcoes.storageState
      : obterStorageStateDeEnv();

  const headless =
    opcoes.headless != null
      ? Boolean(opcoes.headless)
      : String(process.env.BROWSER_HEADLESS || 'false').toLowerCase() ===
        'true';

  const executablePath = opcoes.executablePath || encontrarChromium();

  const userDataDir = obterUserDataDir(storageState);

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

  if (storageState) {
    console.log('🔐 storageState carregado de BROWSER_STORAGE_STATE_B64 (em memória).');
  }

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
    console.log('Instale um Chromium compatível ou defina:');
    console.log('BROWSER_EXECUTABLE_PATH=/caminho/para/chromium');
    console.log('');
  }

  if (
    String(process.env.BROWSER_NO_SANDBOX || 'false').toLowerCase() === 'true'
  ) {
    console.log('⚠️ Chromium executando sem sandbox.');
  }

  const context = await playwright.chromium.launchPersistentContext(
    userDataDir,
    opcoesChromium
  );

  if (storageState) {
    const cookies = Array.isArray(storageState.cookies)
      ? storageState.cookies
      : [];

    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }

    const origins = Array.isArray(storageState.origins)
      ? storageState.origins
      : [];

    if (origins.length > 0) {
      await context.addInitScript((states) => {
        try {
          const origemAtual = window.location.origin;
          const origem = states.find(
            (item) => item && item.origin === origemAtual
          );

          if (!origem || !Array.isArray(origem.localStorage)) {
            return;
          }

          for (const entrada of origem.localStorage) {
            if (!entrada || typeof entrada.name !== 'string') {
              continue;
            }

            window.localStorage.setItem(
              entrada.name,
              String(entrada.value == null ? '' : entrada.value)
            );
          }
        } catch (_) {
          // Não interromper a navegação se o storage ainda não estiver disponível.
        }
      }, origins);
    }

    console.log(
      '🔐 Sessão autenticada aplicada:',
      `${cookies.length} cookies e ${origins.length} origens de localStorage.`
    );
  }

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

  return path.join(SCREENSHOTS_DIR, `${Date.now()}-${safe}.png`);
}

module.exports = {
  SESSION_DIR,
  SCREENSHOTS_DIR,
  criarContexto,
  novaPagina,
  caminhoScreenshot,
  encontrarChromium,
  obterStorageStateDeEnv,
};
