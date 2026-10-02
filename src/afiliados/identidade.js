'use strict';

/**
 * Identidade estável de produtos Shopee para matching cache/CSV.
 */

function normalizarUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url.trim());
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach((p) =>
      u.searchParams.delete(p)
    );
    return `${u.origin}${u.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch (_) {
    return String(url).split('?')[0].replace(/\/$/, '').toLowerCase();
  }
}

function extrairIdsDeUrl(url) {
  if (!url) return { itemId: null, shopId: null };
  try {
    const u = new URL(url);
    const itemParam =
      u.searchParams.get('itemid') ||
      u.searchParams.get('itemId') ||
      u.searchParams.get('product_id');
    const shopParam = u.searchParams.get('shopid') || u.searchParams.get('shopId');
    const m = u.pathname.match(/\/(?:product|prod)\/(\d+)\/(\d+)/i);
    if (m) return { shopId: m[1], itemId: m[2] };
    const m2 = u.pathname.match(/-i\.(\d+)\.(\d+)/);
    if (m2) return { shopId: m2[1], itemId: m2[2] };
    return {
      itemId: itemParam || null,
      shopId: shopParam || null,
    };
  } catch (_) {
    return { itemId: null, shopId: null };
  }
}

function chaveProduto(oferta) {
  if (!oferta) return '';
  if (oferta.id) return `id:${String(oferta.id)}`;
  const ids = extrairIdsDeUrl(oferta.link);
  if (ids.itemId) {
    return ids.shopId ? `item:${ids.shopId}.${ids.itemId}` : `item:${ids.itemId}`;
  }
  const norm = normalizarUrl(oferta.link);
  if (norm) return `link:${norm}`;
  return '';
}

/** Heurística apenas — NÃO confirma afiliado do usuário. */
function pareceLinkEncurtadoShopee(url) {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 's.shopee.com.br' || h.endsWith('.s.shopee.com.br');
  } catch (_) {
    return false;
  }
}

module.exports = {
  normalizarUrl,
  extrairIdsDeUrl,
  chaveProduto,
  pareceLinkEncurtadoShopee,
};
