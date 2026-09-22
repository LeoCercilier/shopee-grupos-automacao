'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[utils] Falha ao ler ${filePath}:`, err.message);
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function productKey(produto) {
  if (!produto) return '';
  if (produto.id) return `id:${String(produto.id)}`;
  if (produto.link) {
    try {
      const u = new URL(produto.link);
      const iid =
        u.searchParams.get('itemid') ||
        u.searchParams.get('itemId') ||
        u.searchParams.get('product_id');
      if (iid) return `id:${iid}`;
    } catch (_) {}
    return `link:${String(produto.link).split('?')[0]}`;
  }
  return `nome:${String(produto.titulo || produto.nome || '').toLowerCase().trim()}|${String(produto.preco || '')}`;
}

function formatPrice(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

module.exports = {
  ensureDir,
  readJson,
  writeJson,
  nowIso,
  daysAgo,
  productKey,
  formatPrice,
};
