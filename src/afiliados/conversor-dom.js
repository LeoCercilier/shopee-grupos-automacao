'use strict';

/**
 * Helpers de DOM / sessão para conversão Shopee no navegador.
 * Matching conservador: preferir sem correspondência a associação errada.
 */

const path = require('path');
const { caminhoScreenshot } = require('../navegador/browser');
const { ensureDir } = require('../utils');
const { normalizarUrl } = require('./identidade');

const BLOQUEIOS_SHOPEE = [
  /captcha/i,
  /checkpoint/i,
  /security verification/i,
  /verifica(ç|c)ão de seguran/i,
  /verify your identity/i,
  /unusual activity/i,
  /acesso negado/i,
  /access denied/i,
  /rate limit/i,
  /too many requests/i,
  /temporar(ily|iamente) (blocked|bloqueado)/i,
  /conta suspensa/i,
  /please log in/i,
  /faça login/i,
  /sign in/i,
];

async function capturarEvidencia(page, nome) {
  try {
    ensureDir(path.dirname(caminhoScreenshot(nome)));
    const file = caminhoScreenshot(nome);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    return file;
  } catch (_) {
    return null;
  }
}

async function detectarBloqueioShopee(page) {
  const url = page.url() || '';
  const title = await page.title().catch(() => '');
  let bodyText = '';
  try {
    bodyText = await page.locator('body').innerText({ timeout: 4000 });
  } catch (_) {}
  const blob = `${url}\n${title}\n${bodyText.slice(0, 6000)}`;
  for (const re of BLOQUEIOS_SHOPEE) {
    if (re.test(blob)) {
      return {
        bloqueado: true,
        motivo: `Bloqueio/verificação Shopee detectado (${re}). Interrompendo — não contornamos segurança.`,
      };
    }
  }
  if (/\/buyer\/login|\/seller\/login|accounts\.shopee|login\?/i.test(url)) {
    return {
      bloqueado: true,
      motivo: 'Página de login Shopee detectada. Faça login manual na sessão .browser-session/ e tente de novo.',
    };
  }
  return { bloqueado: false };
}

async function verificarSessaoShopee(page, shopeeUrl) {
  await page.goto(shopeeUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  const bloqueio = await detectarBloqueioShopee(page);
  if (bloqueio.bloqueado) return { ok: false, ...bloqueio };
  const url = page.url() || '';
  if (/login/i.test(url) && !/offer|affiliate|convert|custom/i.test(url)) {
    return {
      ok: false,
      motivo: 'Sessão Shopee não autenticada. Abra o navegador, faça login no Portal de Afiliados e salve a sessão.',
    };
  }
  return { ok: true, url };
}

async function localizarCampoLinks(page) {
  const candidatos = [
    page.getByPlaceholder(/link da shopee|shopee link|link personalizado|cole.*link|paste.*link|product link/i),
    page.locator('textarea').first(),
    page.getByRole('textbox').first(),
    page.locator('textarea[placeholder*="link" i]'),
    page.locator('input[type="text"][placeholder*="link" i]'),
    page.locator('[contenteditable="true"]').first(),
  ];
  for (const loc of candidatos) {
    try {
      const el = loc.first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) return el;
    } catch (_) {}
  }
  return null;
}

async function localizarBotaoConverter(page) {
  const nomes = [/^(converter|convert)$/i, /obter link/i, /get link/i, /gerar link/i, /convert link/i];
  for (const re of nomes) {
    const btn = page.getByRole('button', { name: re });
    if (await btn.first().isVisible({ timeout: 1200 }).catch(() => false)) return btn.first();
  }
  const all = page.locator('button, [role="button"], a.btn, input[type="submit"]');
  const n = await all.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    const t = ((await el.innerText().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || '').trim();
    if (/converter|convert|obter link|get link|gerar/i.test(t)) {
      if (await el.isVisible().catch(() => false)) return el;
    }
  }
  return null;
}

function extrairUrlsDeTexto(texto) {
  const re = /https?:\/\/[^\s"'<>]+/gi;
  const found = texto.match(re) || [];
  return [...new Set(found.map((u) => u.replace(/[),.;]+$/, '')))];
}

function extrairIdsDeUrl(url) {
  const out = { itemId: null, shopId: null };
  if (!url) return out;
  try {
    const u = new URL(url);
    const pth = u.pathname || '';
    let m = pth.match(/\/product\/(\d+)\/(\d+)/i);
    if (m) { out.shopId = m[1]; out.itemId = m[2]; return out; }
    m = pth.match(/-i\.(\d+)\.(\d+)/i);
    if (m) { out.shopId = m[1]; out.itemId = m[2]; return out; }
    const origin = u.searchParams.get('origin_link') || '';
    if (origin) {
      try { return extrairIdsDeUrl(decodeURIComponent(origin)); } catch (_) {}
    }
  } catch (_) {}
  return out;
}

function pareceResultadoAfiliado(url, urlOriginal) {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    const isShopee =
      h === 's.shopee.com.br' || h.endsWith('.s.shopee.com.br') ||
      h === 'shope.ee' || h === 'shopee.com.br' || h.endsWith('.shopee.com.br');
    if (!isShopee) return false;
    if (urlOriginal && normalizarUrl(url) === normalizarUrl(urlOriginal)) return false;
    if (urlOriginal && url.trim() === String(urlOriginal).trim()) return false;
    if (/affiliate_id=|an_redir|uls_trackid|utm_source=an_/i.test(url)) return true;
    if ((h === 's.shopee.com.br' || h === 'shope.ee') && /origin_link=/i.test(url)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

function pareceAfiliadoOuEncurtado(url, urlOriginal) {
  return pareceResultadoAfiliado(url, urlOriginal);
}

function afiliadoApontaParaOriginal(afiliado, env) {
  if (!pareceResultadoAfiliado(afiliado, env.link_original)) return false;
  try {
    const u = new URL(afiliado);
    const origin = u.searchParams.get('origin_link');
    if (!origin) return false;
    const decoded = decodeURIComponent(origin);
    if (normalizarUrl(decoded) === normalizarUrl(env.link_original)) return true;
    const idsO = extrairIdsDeUrl(decoded);
    const idsE = extrairIdsDeUrl(env.link_original);
    if (idsO.itemId && idsE.itemId && idsO.itemId === idsE.itemId) return true;
    if (env.produto_id && idsO.itemId && String(env.produto_id) === String(idsO.itemId)) return true;
  } catch (_) {}
  return false;
}

function originalBateComEnvio(url, enviados) {
  for (const e of enviados) {
    if (e.link_original === url) return e;
    if (normalizarUrl(e.link_original) === normalizarUrl(url)) return e;
    const idsUrl = extrairIdsDeUrl(url);
    const idsEnv = extrairIdsDeUrl(e.link_original);
    if (idsUrl.itemId && idsEnv.itemId && idsUrl.itemId === idsEnv.itemId) return e;
    if (e.produto_id && idsUrl.itemId && String(e.produto_id) === String(idsUrl.itemId)) return e;
  }
  return null;
}

async function lerResultadosDoDom(page, enviados) {
  const pares = [];
  const usadosChave = new Set();
  const usadosAfil = new Set();

  const adicionarPar = (env, afiliado, metodo) => {
    if (!env || !afiliado) return false;
    if (usadosChave.has(env.chave)) return false;
    if (usadosAfil.has(afiliado)) return false;
    if (!pareceResultadoAfiliado(afiliado, env.link_original)) return false;
    pares.push({ original: env.link_original, afiliado, metodo, chave: env.chave });
    usadosChave.add(env.chave);
    usadosAfil.add(afiliado);
    return true;
  };

  const rows = page.locator('table tr, [role="row"], .ant-table-row, li, [class*="result"] > *, [class*="Result"] > *');
  const rowCount = await rows.count().catch(() => 0);
  for (let i = 0; i < Math.min(rowCount, 60); i++) {
    const rowText = await rows.nth(i).innerText().catch(() => '');
    const urls = extrairUrlsDeTexto(rowText);
    if (urls.length < 1) continue;
    let env = null;
    for (const u of urls) { env = originalBateComEnvio(u, enviados); if (env) break; }
    if (!env) {
      for (const e of enviados) {
        if (e.produto_id && rowText.includes(String(e.produto_id))) { env = e; break; }
        const ids = extrairIdsDeUrl(e.link_original);
        if (ids.itemId && rowText.includes(ids.itemId)) { env = e; break; }
      }
    }
    if (!env) continue;
    const candidatos = urls.filter((u) => pareceResultadoAfiliado(u, env.link_original));
    const viaOrigin = candidatos.filter((u) => afiliadoApontaParaOriginal(u, env));
    if (viaOrigin.length === 1) adicionarPar(env, viaOrigin[0], 'origin_link');
    else if (candidatos.length === 1) adicionarPar(env, candidatos[0], 'dom-linha');
  }

  if (pares.length === 0) {
    return {
      ok: false,
      motivo: 'matching_ambiguo',
      detalhes: `sem_correspondencia_segura enviados=${enviados.length}`,
      pares: [],
    };
  }

  return {
    ok: true,
    parcial: pares.length < enviados.length,
    pares,
    metodo: 'conservador',
    detalhes:
      pares.length < enviados.length
        ? `associados=${pares.length}/${enviados.length} (restante sem correspondência segura)`
        : `associados=${pares.length}/${enviados.length}`,
  };
}

module.exports = {
  capturarEvidencia,
  detectarBloqueioShopee,
  verificarSessaoShopee,
  localizarCampoLinks,
  localizarBotaoConverter,
  lerResultadosDoDom,
  extrairUrlsDeTexto,
  extrairIdsDeUrl,
  pareceResultadoAfiliado,
  pareceAfiliadoOuEncurtado,
  originalBateComEnvio,
  afiliadoApontaParaOriginal,
};
