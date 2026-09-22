'use strict';

/**
 * Coletor de ofertas da fonte pública usada em:
 * https://leocercilier.github.io/shopee-achadinho/ofertas.html
 *
 * A página consome a edge function Supabase `shopee-products-v2`.
 * Este módulo reutiliza a mesma API pública (chave publishable).
 */

const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { writeJson, nowIso, productKey } = require('./utils');

const ROOT = path.join(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'data', 'ofertas-brutas.json');

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://ajjbtuhnvdehcxqykfkf.supabase.co';
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_UD6ktmFQ0yW9fVIHRH7EVQ_gGsn5Al4';
const LIMIT = Number(process.env.COLETOR_LIMIT || 40);

function normalizarProduto(p) {
  if (!p || typeof p !== 'object') return null;

  const id =
    p.item_id ||
    p.itemId ||
    p.product_id ||
    p.productId ||
    p.itemid ||
    p.id ||
    '';

  const imagens = [];
  const add = (u) => {
    if (u && typeof u === 'string' && u.trim() && !imagens.includes(u.trim())) {
      imagens.push(u.trim());
    }
  };
  add(p.imagem_url);
  add(p.imageUrl);
  add(p.image);
  add(p.thumbnail);
  if (Array.isArray(p.images)) {
    p.images.forEach((x) => {
      if (typeof x === 'string') add(x);
      else if (x && x.url) add(x.url);
    });
  }
  if (Array.isArray(p.imageUrlList)) p.imageUrlList.forEach(add);
  if (Array.isArray(p.imagens)) {
    p.imagens.forEach((x) => {
      if (typeof x === 'string') add(x);
      else if (x && x.url) add(x.url);
    });
  }

  const titulo = p.nome || p.productName || p.title || 'Produto';
  const preco =
    p.preco != null
      ? p.preco
      : p.priceMin != null
        ? p.priceMin
        : p.preco_min != null
          ? p.preco_min
          : null;
  const link =
    p.offer_link ||
    p.offerLink ||
    p.produto_link ||
    p.productLink ||
    p.link ||
    '';

  if (!titulo || !link) return null;

  return {
    id: id ? String(id) : '',
    titulo: String(titulo).trim(),
    preco: preco,
    preco_formatado:
      preco != null && Number.isFinite(Number(preco))
        ? Number(preco).toLocaleString('pt-BR', {
            style: 'currency',
            currency: 'BRL',
          })
        : null,
    link: String(link).trim(),
    imagem: imagens[0] || '',
    imagens: imagens.slice(0, 3),
    vendas: p.vendas != null ? p.vendas : p.sales != null ? p.sales : null,
    avaliacao:
      p.avaliacao != null
        ? p.avaliacao
        : p.ratingStar != null
          ? p.ratingStar
          : null,
    desconto_percentual:
      p.desconto_percentual != null
        ? p.desconto_percentual
        : p.priceDiscountRate != null
          ? p.priceDiscountRate
          : null,
    coletado_em: nowIso(),
    fonte: 'shopee-products-v2',
  };
}

function extrairLista(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.products)) return data.products;
  if (data && Array.isArray(data.produtos)) return data.produtos;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

async function garantirSessaoAnonima(supabase) {
  const atual = await supabase.auth.getSession();
  if (atual?.data?.session?.access_token) {
    return atual.data.session.access_token;
  }
  const anon = await supabase.auth.signInAnonymously();
  if (anon.error) {
    throw new Error(
      'Falha no login anônimo do Supabase: ' + (anon.error.message || anon.error)
    );
  }
  const token = anon.data?.session?.access_token;
  if (!token) throw new Error('Sessão anônima sem access_token');
  return token;
}

async function coletarOfertas({ limit = LIMIT, keyword = '' } = {}) {
  console.log('=== COLETOR DE OFERTAS SHOPEE ===');
  console.log('Fonte: edge function shopee-products-v2 (mesma de ofertas.html)');
  console.log(`Limite: ${limit}`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

  const accessToken = await garantirSessaoAnonima(supabase);

  const paginaSize = Math.min(20, limit);
  const maxPages = Math.ceil(limit / paginaSize);
  const todos = [];
  const vistos = new Set();

  for (let page = 1; page <= maxPages && todos.length < limit; page++) {
    console.log(`Buscando página ${page}...`);

    const { data, error } = await supabase.functions.invoke('shopee-products-v2', {
      body: {
        page,
        limit: paginaSize,
        keyword: keyword || '',
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (error) {
      let msg = error.message || String(error);
      try {
        if (error.context && typeof error.context.json === 'function') {
          const corpo = await error.context.json();
          msg = corpo.message || corpo.error || msg;
        }
      } catch (_) {}
      throw new Error(`Erro na edge function: ${msg}`);
    }

    const lista = extrairLista(data)
      .map(normalizarProduto)
      .filter(Boolean);

    for (const p of lista) {
      const k = productKey(p);
      if (vistos.has(k)) continue;
      vistos.add(k);
      todos.push(p);
      if (todos.length >= limit) break;
    }

    const hasNext =
      !!(data && (data.hasNextPage || (data.pageInfo && data.pageInfo.hasNextPage)));
    if (!hasNext || lista.length === 0) break;
  }

  const payload = {
    gerado_em: nowIso(),
    total: todos.length,
    fonte: 'https://leocercilier.github.io/shopee-achadinho/ofertas.html',
    api: 'shopee-products-v2',
    ofertas: todos,
  };

  writeJson(OUT_FILE, payload);
  console.log(`✅ Coletadas ${todos.length} ofertas → ${OUT_FILE}`);
  return payload;
}

if (require.main === module) {
  coletarOfertas()
    .then((r) => {
      console.log(`Total final: ${r.total}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Falha no coletor:', err.message);
      process.exit(1);
    });
}

module.exports = { coletarOfertas, normalizarProduto };
