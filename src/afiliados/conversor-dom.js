'use strict';

/**
 * Helpers de DOM / sessão para conversão Shopee no navegador.
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

function pareceAfiliadoOuEncurtado(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return (
      h === 's.shopee.com.br' ||
      h.endsWith('.s.shopee.com.br') ||
      h === 'shope.ee' ||
      /affiliate_id=|an_redir|uls_trackid/i.test(url)
    );
  } catch (_) {
    return false;
  }
}

async function lerResultadosDoDom(page, enviados) {
  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const todasUrls = extrairUrlsDeTexto(body);
  const pares = [];
  const rows = page.locator('table tr, [role="row"], .ant-table-row, li');
  const rowCount = await rows.count().catch(() => 0);
  for (let i = 0; i < Math.min(rowCount, 40); i++) {
    const rowText = await rows.nth(i).innerText().catch(() => '');
    const urls = extrairUrlsDeTexto(rowText);
    if (urls.length >= 2) {
      const orig = urls.find((u) =>
        enviados.some((e) => normalizarUrl(e.link_original) === normalizarUrl(u) || e.link_original === u)
      );
      const afil = urls.find((u) => u !== orig && pareceAfiliadoOuEncurtado(u));
      if (orig && afil) pares.push({ original: orig, afiliado: afil, metodo: 'dom-linha' });
    }
  }
  if (pares.length > 0) return { ok: true, pares, metodo: 'dom-linha', todasUrls };

  const dialog = page.locator('[role="dialog"], .ant-modal, .modal, [class*="Modal"]');
  if (await dialog.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    const dText = await dialog.first().innerText().catch(() => '');
    const dUrls = extrairUrlsDeTexto(dText).filter(pareceAfiliadoOuEncurtado);
    if (dUrls.length === enviados.length) {
      return {
        ok: true,
        pares: enviados.map((e, idx) => ({
          original: e.link_original,
          afiliado: dUrls[idx],
          metodo: 'ordem-modal',
          chave: e.chave,
        })),
        metodo: 'ordem-modal',
        aviso: 'Matching por ordem no modal (último recurso)',
        todasUrls: dUrls,
      };
    }
    if (dUrls.length > 0) {
      return {
        ok: false,
        motivo: 'matching_ambiguo',
        detalhes: `Modal com ${dUrls.length} links afiliados para ${enviados.length} enviados`,
        todasUrls: dUrls,
      };
    }
  }

  const afiliados = todasUrls.filter(pareceAfiliadoOuEncurtado);
  const enviadosSet = new Set(enviados.map((e) => e.link_original));
  const novos = afiliados.filter((u) => !enviadosSet.has(u));

  if (novos.length === enviados.length) {
    return {
      ok: true,
      pares: enviados.map((e, idx) => ({
        original: e.link_original,
        afiliado: novos[idx],
        metodo: 'ordem-body',
        chave: e.chave,
      })),
      metodo: 'ordem-body',
      aviso: 'Matching por ordem no body (último recurso)',
      todasUrls: novos,
    };
  }

  for (const env of enviados) {
    const idx = body.indexOf(env.link_original);
    if (idx >= 0) {
      const slice = body.slice(idx, idx + 500);
      const urls = extrairUrlsDeTexto(slice).filter((u) => u !== env.link_original && pareceAfiliadoOuEncurtado(u));
      if (urls.length === 1) {
        pares.push({ original: env.link_original, afiliado: urls[0], metodo: 'proximidade-texto', chave: env.chave });
      }
    }
  }
  if (pares.length === enviados.length) return { ok: true, pares, metodo: 'proximidade-texto', todasUrls };

  return {
    ok: false,
    motivo: 'matching_ambiguo',
    detalhes: `Não foi possível associar com segurança. Enviados=${enviados.length}, afiliados_vistos=${novos.length}`,
    todasUrls: novos,
    pares_parciais: pares,
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
  pareceAfiliadoOuEncurtado,
};
