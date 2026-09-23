'use strict';

/**
 * Gerencia o navegador Playwright com perfil persistente.
 * A sessão fica em .browser-session/ (NÃO versionar).
 */

const path = require('path');
const { ensureDir } = require('../utils');

const ROOT = path.join(__dirname, '..', '..');
const SESSION_DIR = path.join(ROOT, '.browser-session');
const SCREENSHOTS_DIR = path.join(ROOT, 'data', 'screenshots');

async function criarContexto(opcoes = {}) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (_) {
    throw new Error(
      'Playwright não instalado. Rode: npm install && npx playwright install chromium'
    );
  }

  ensureDir(SESSION_DIR);
  ensureDir(SCREENSHOTS_DIR);

  const headless =
    opcoes.headless != null
      ? Boolean(opcoes.headless)
      : String(process.env.BROWSER_HEADLESS || 'false').toLowerCase() === 'true';

  const context = await playwright.chromium.launchPersistentContext(SESSION_DIR, {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    args: ['--disable-notifications'],
    // Aceita downloads se necessário
    acceptDownloads: true,
  });

  return context;
}

async function novaPagina(context) {
  const pages = context.pages();
  if (pages.length > 0) return pages[0];
  return context.newPage();
}

function caminhoScreenshot(nome) {
  const safe = String(nome || 'shot').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return path.join(SCREENSHOTS_DIR, `${Date.now()}-${safe}.png`);
}

module.exports = {
  SESSION_DIR,
  SCREENSHOTS_DIR,
  criarContexto,
  novaPagina,
  caminhoScreenshot,
};
