'use strict';

/**
 * Conversor local Shopee via Chrome DevTools Protocol.
 *
 * Usa o Chromium já autenticado no Termux/X11.
 *
 * Segurança:
 * - máximo de 5 links por lote;
 * - dry-run por padrão;
 * - dry-run não preenche, não clica e não grava;
 * - sem fallback por ordem arbitrária dos resultados;
 * - somente aceita resultados estruturais no textarea de saída;
 * - matching estrutural: quantidade de entradas deve coincidir;
 * - resultado inválido/ambíguo não grava cache;
 * - não tenta contornar verificação, CAPTCHA ou bloqueio da Shopee.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const { listarPendentes, marcarConvertido } = require('./fila');
const { registrarConvertido } = require('./cache');

const ROOT = path.join(__dirname, '..', '..');
const RESULTADO = path.join(
  ROOT,
  'data',
  'resultado-conversao-cdp.json'
);

const PORT = Number(process.env.CDP_PORT || 9222);
const MAX_LOTE = 5;
const DRY_RUN =
  String(process.env.SHOPEE_CONVERSAO_DRY_RUN || 'true')
    .trim()
    .toLowerCase() === 'true';

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';

      res.setEncoding('utf8');

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(
            new Error(`Resposta CDP inválida: ${err.message}`)
          );
        }
      });
    });

    req.setTimeout(3000, () => {
      req.destroy(new Error('Timeout consultando CDP'));
    });

    req.on('error', reject);
  });
}

async function obterPaginaCustomLink() {
  const paginas = await httpGetJson(
    `http://127.0.0.1:${PORT}/json/list`
  );

  const candidatas = paginas.filter(
    (p) =>
      p &&
      p.type === 'page' &&
      /^https:\/\/affiliate\.shopee\.com\.br\/offer\/custom_link/i.test(
        String(p.url || '')
      ) &&
      p.webSocketDebuggerUrl
  );

  if (candidatas.length === 0) {
    throw new Error(
      'Nenhuma aba Shopee Custom Link encontrada no CDP. Abra https://affiliate.shopee.com.br/offer/custom_link no Chromium local.'
    );
  }

  return candidatas[0];
}

function cdp(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout CDP: ${method}`));
    }, 15000);

    const handler = (raw) => {
      let msg;

      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }

      if (msg.id !== id) return;

      clearTimeout(timer);
      ws.off('message', handler);

      if (msg.error) {
        reject(
          new Error(
            `${method}: ${msg.error.message || 'erro CDP'}`
          )
        );
        return;
      }

      resolve(msg.result || {});
    };

    ws.on('message', handler);
    ws.send(
      JSON.stringify({
        id,
        method,
        params,
      })
    );
  });
}

let nextId = 1;

async function avaliar(ws, expression, returnByValue = true) {
  const id = nextId++;

  const result = await cdp(
    ws,
    id,
    'Runtime.evaluate',
    {
      expression,
      returnByValue,
      awaitPromise: true,
    }
  );

  if (result.exceptionDetails) {
    const ex = result.exceptionDetails.exception || {};

    throw new Error(
      [
        result.exceptionDetails.text,
        ex.name,
        ex.message,
        ex.description,
        result.exceptionDetails.stackTrace?.callFrames
          ?.map((f) => `${f.functionName || '<anon>'} @ ${f.url || ''}:${f.lineNumber + 1}:${f.columnNumber + 1}`)
          .join('\\n')
      ]
        .filter(Boolean)
        .join(' | ')
    );
  }

  return result.result ? result.result.value : undefined;
}

function validarLink(link) {
  try {
    const u = new URL(String(link || '').trim());

    if (!/^https?:$/.test(u.protocol)) return false;

    const host = u.hostname.toLowerCase();

    return (
      host === 's.shopee.com.br' ||
      host === 'shopee.com.br' ||
      host.endsWith('.shopee.com.br')
    );
  } catch (_) {
    return false;
  }
}

function extrairLinhas(texto) {
  return String(texto || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function escreverResultado(resultado) {
  fs.writeFileSync(
    RESULTADO,
    JSON.stringify(resultado, null, 2) + '\n',
    'utf8'
  );
}

async function diagnosticar(ws) {
  return avaliar(
    ws,
    `(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 &&
          s.visibility !== 'hidden' && s.display !== 'none';
      };

      const extrairUrls = (texto) => {
        const encontrados = String(texto || '')
          .split(/\s+/)
          .map((x) => x.trim().replace(/^[([{"']+|[),.;}"']+$/g, ''))
          .filter(Boolean);

        return encontrados.filter((x) => {
          try {
            const u = new URL(x);
            return u.protocol === 'http:' || u.protocol === 'https:';
          } catch (_) {
            return false;
          }
        });
      };

      const elementos = [...document.querySelectorAll("*")].filter(vis);
      const links = [];
      const valores = [];
      const textos = [];

      for (const el of elementos) {
        if (el.tagName === 'A' && el.href) links.push(el.href);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          if (el.value) valores.push(el.value);
        }
        const texto = (el.innerText || el.textContent || '').trim();
        if (texto) textos.push(texto);
      }

      const urls = [
        ...links,
        ...valores.flatMap(extrairUrls),
        ...textos.flatMap(extrairUrls)
      ];

      /*
       * Diagnóstico estrutural dos links gerados.
       *
       * Não cria associação entre original e afiliado.
       * Apenas preserva o contexto DOM em que cada link aparece:
       * - elemento A;
       * - ancestrais próximos;
       * - texto do bloco;
       * - outros links/inputs/textareas contidos no bloco;
       * - atributos data-*.
       */
      const resultado_blocos = [...document.querySelectorAll('a')]
        .filter(vis)
        .filter((a) => {
          try {
            const host = new URL(a.href).hostname.toLowerCase();
            return host === 's.shopee.com.br' ||
              host === 'shopee.com.br' ||
              host.endsWith('.shopee.com.br');
          } catch (_) {
            return false;
          }
        })
        .map((a) => {
          const ancestrais = [];
          let node = a;

          for (let nivel = 0; nivel < 5 && node; nivel += 1) {
            const texto = (node.innerText || node.textContent || '').trim();
            const urlsDoBloco = [];

            for (const el of node.querySelectorAll('a')) {
              if (el.href) urlsDoBloco.push(el.href);
            }

            for (const el of node.querySelectorAll('input, textarea')) {
              const valor = String(el.value || '').trim();
              if (!valor) continue;

              try {
                const u = new URL(valor);
                if (u.protocol === 'http:' || u.protocol === 'https:') {
                  urlsDoBloco.push(u.toString());
                }
              } catch (_) {
                // Valor não é URL isolada.
              }
            }

            const data = {};
            for (const attr of [...(node.attributes || [])]) {
              if (String(attr.name).startsWith('data-')) {
                data[attr.name] = attr.value;
              }
            }

            ancestrais.push({
              nivel,
              tag: node.tagName || '',
              id: node.id || '',
              className: typeof node.className === 'string' ? node.className : '',
              texto: texto.slice(0, 1200),
              urls: [...new Set(urlsDoBloco)],
              data,
            });

            node = node.parentElement;
          }

          return {
            href: a.href || '',
            texto: (a.innerText || a.textContent || '').trim(),
            ancestrais,
          };
        });

      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        textareas: [...document.querySelectorAll("textarea")].filter(vis).map((e) => ({
          placeholder: e.placeholder || '',
          valueLength: (e.value || '').length,
          value: e.value || ''
        })),
        inputs: [...document.querySelectorAll("input")].filter(vis).map((e) => ({
          type: e.type || '',
          placeholder: e.placeholder || '',
          value: e.value || ''
        })),
        anchors: [...new Set(links)],
        urls: [...new Set(urls)],
        resultado_blocos,
        buttons: [...document.querySelectorAll("button")].filter(vis).map((e) => ({
          type: e.type || '',
          text: (e.innerText || e.textContent || '').trim()
        }))
      };
    })()`
  );
}
async function executarLote(ws, itens) {
  const enviados = itens.map((i) => i.link_original);

  console.log(`URLs enviadas: ${enviados.length}`);

  const antes = await diagnosticar(ws);

  if (!/^https:\/\/affiliate\.shopee\.com\.br\/offer\/custom_link/i.test(
    antes.url
  )) {
    return {
      ok: false,
      motivo: 'pagina_custom_link_nao_encontrada',
      url: antes.url,
    };
  }

  if (antes.textareas.length === 0) {
    return {
      ok: false,
      motivo: 'campo_links_nao_encontrado',
      url: antes.url,
    };
  }

  const campo = antes.textareas.find((x) =>
    /converter múltiplos links|shopee\.com\.br/i.test(
      x.placeholder
    )
  );

  if (!campo) {
    return {
      ok: false,
      motivo: 'campo_links_nao_encontrado',
      url: antes.url,
    };
  }

  if (DRY_RUN) {
    return {
      ok: true,
      dry_run: true,
      enviados,
      motivo: 'dry_run_sem_clique',
      diagnostico: antes.resultado_blocos || [],
    };
  }

  const preenchido = await avaliar(
    ws,
    `(() => {
      const campo = [...document.querySelectorAll('textarea')]
        .find((e) => {
          const r = e.getBoundingClientRect();
          const s = getComputedStyle(e);
          return r.width > 0 &&
            r.height > 0 &&
            s.visibility !== 'hidden' &&
            s.display !== 'none' &&
            /converter múltiplos links|shopee\\.com\\.br/i.test(
              e.placeholder || ''
            );
        });

      if (!campo) return false;

      const valor = ${JSON.stringify(enviados.join('\\n'))};

      const setter =
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value'
        )?.set;

      if (setter) {
        setter.call(campo, valor);
      } else {
        campo.value = valor;
      }

      campo.dispatchEvent(
        new Event('input', { bubbles: true })
      );

      campo.dispatchEvent(
        new Event('change', { bubbles: true })
      );

      return campo.value === valor;
    })()`
  );

  if (!preenchido) {
    return {
      ok: false,
      motivo: 'falha_preenchimento_campo',
    };
  }

  const clicado = await avaliar(
    ws,
    `(() => {
      const botoes = [...document.querySelectorAll('button')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          const s = getComputedStyle(e);
          return r.width > 0 &&
            r.height > 0 &&
            s.visibility !== 'hidden' &&
            s.display !== 'none';
        });

      const botao = botoes.find((e) =>
        /obter link/i.test(
          (e.innerText || e.textContent || '').trim()
        )
      );

      if (!botao) return false;

      botao.click();
      return true;
    })()`
  );

  if (!clicado) {
    return {
      ok: false,
      motivo: 'botao_obter_link_nao_encontrado',
    };
  }

  await new Promise((r) => setTimeout(r, 4000));

  const depois = await diagnosticar(ws);

  /*
   * IMPORTANTE:
   * Nunca associar resultados pela posição.
   *
   * O resultado precisa carregar evidência estrutural que permita
   * identificar qual link original foi convertido. A principal evidência
   * esperada no Custom Link é origin_link. Também aceitamos a identificação
   * do produto quando ela estiver explicitamente presente nessa evidência.
   */

  function normalizarUrlLocal(url) {
    try {
      return new URL(String(url || '').trim()).toString().replace(/\/$/, '').toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function extrairOriginLink(url) {
    try {
      const u = new URL(String(url || '').trim());

      for (const nome of ['origin_link', 'originLink', 'origin']) {
        const valor = u.searchParams.get(nome);
        if (valor) {
          try {
            return decodeURIComponent(valor);
          } catch (_) {
            return valor;
          }
        }
      }

      return '';
    } catch (_) {
      return '';
    }
  }

  function extrairIds(url) {
    const texto = String(url || '');

    const ids = new Set();

    const produto = texto.match(/\/product\/([0-9]+)\/([0-9]+)/i);
    if (produto) {
      ids.add(produto[1]);
      ids.add(produto[2]);
    }

    const item = texto.match(/-i\.([0-9]+)\.([0-9]+)/i);
    if (item) {
      ids.add(item[1]);
      ids.add(item[2]);
    }

    const origin = extrairOriginLink(texto);
    if (origin && origin !== texto) {
      for (const id of extrairIds(origin)) {
        ids.add(id);
      }
    }

    return [...ids];
  }

  function correspondeEstruturalmente(afiliado, item) {
    const original = String(item.link_original || '').trim();
    const originalNorm = normalizarUrlLocal(original);

    const origin = extrairOriginLink(afiliado);
    const originNorm = normalizarUrlLocal(origin);

    if (originNorm && originalNorm && originNorm === originalNorm) {
      return true;
    }

    if (!origin) {
      return false;
    }

    const idsOriginais = new Set(extrairIds(original));

    if (item.produto_id) {
      idsOriginais.add(String(item.produto_id));
    }

    if (idsOriginais.size === 0) {
      return false;
    }

    const idsOrigin = extrairIds(origin);

    return idsOrigin.some((id) => idsOriginais.has(String(id)));
  }


  const candidatos = [];

  /*
   * A Shopee pode renderizar os links personalizados fora do textarea.
   * Capturamos textarea, input, anchor e URLs presentes no texto do DOM.
   * A associação continua sendo feita exclusivamente pelo matcher
   * estrutural; nunca pela posição dos resultados.
   */
  const fontesResultado = [
    ...(depois.urls || []),
    ...(depois.anchors || []),
    ...(depois.inputs || []).map((x) => x.value || ''),
    ...(depois.textareas || []).map((x) => x.value || '')
  ];

  for (const fonte of fontesResultado) {
    const linhas = extrairLinhas(fonte);

    for (const linha of linhas) {
      if (validarLink(linha)) candidatos.push(linha);
    }
  }

  const enviadosNorm = new Set(
    enviados.map(normalizarUrlLocal)
  );

  const unicos = [...new Set(candidatos)].filter(
    (link) => !enviadosNorm.has(normalizarUrlLocal(link))
  );

  if (unicos.length === 0) {
    return {
      ok: false,
      motivo: 'resultado_links_nao_encontrado',
    };
  }

  /*
   * Para lote de 1 link, a evidência de associação será:
   *
   * 1. saída é uma URL válida;
   * 2. saída é diferente da entrada;
   * 3. conseguimos resolver o destino da entrada;
   * 4. conseguimos resolver o destino da saída;
   * 5. ambos os destinos identificam a mesma oferta.
   *
   * Não tentamos interpretar o código interno do short link.
   */
  async function resolverDestino(url) {
    try {
      const resultado = await fetch(url, {
        redirect: 'follow',
      });

      const finalUrl = resultado.url || '';

      if (!finalUrl || !validarLink(finalUrl)) {
        return '';
      }

      return finalUrl;
    } catch (_) {
      return '';
    }
  }

  function extrairOfertaDestino(url) {
    const texto = String(url || '');

    /*
     * Formatos conhecidos da Shopee:
     * /product/<shopId>/<itemId>
     * ...-i.<shopId>.<itemId>
     */
    const produto = texto.match(
      /\/product\/([0-9]+)\/([0-9]+)/i
    );

    if (produto) {
      return {
        shop_id: produto[1],
        item_id: produto[2],
      };
    }

    /*
     * Formato observado nos destinos reais dos links Shopee:
     * /opaanlp/<shopId>/<itemId>
     */
    const opaanlp = texto.match(
      /\/opaanlp\/([0-9]+)\/([0-9]+)/i
    );

    if (opaanlp) {
      return {
        shop_id: opaanlp[1],
        item_id: opaanlp[2],
      };
    }

    const item = texto.match(
      /-i\.([0-9]+)\.([0-9]+)/i
    );

    if (item) {
      return {
        shop_id: item[1],
        item_id: item[2],
      };
    }

    return null;
  }

  function mesmaOferta(destinoOrigem, destinoSaida) {
    const origem = extrairOfertaDestino(destinoOrigem);
    const saida = extrairOfertaDestino(destinoSaida);

    if (!origem || !saida) {
      return false;
    }

    return (
      origem.shop_id === saida.shop_id &&
      origem.item_id === saida.item_id
    );
  }

  /*
   * Fluxo especial para exatamente 1 link.
   *
   * Não existe associação por posição: existe apenas uma entrada e,
   * depois de remover a própria entrada, deve existir exatamente uma
   * saída candidata.
   */
  if (itens.length === 1) {
    const item = itens[0];

    if (unicos.length !== 1) {
      return {
        ok: false,
        motivo: 'matching_ambiguo',
        chave: item.chave,
        candidatos: unicos.length,
      };
    }

    const afiliado = unicos[0];

    if (
      normalizarUrlLocal(item.link_original) ===
      normalizarUrlLocal(afiliado)
    ) {
      return {
        ok: false,
        motivo: 'link_nao_convertido',
        chave: item.chave,
      };
    }

    console.log('Validando destino da oferta original...');
    const destinoOrigem = await resolverDestino(
      item.link_original
    );

    if (!destinoOrigem) {
      return {
        ok: false,
        motivo: 'destino_origem_nao_resolvido',
        chave: item.chave,
      };
    }

    console.log('Validando destino do link convertido...');
    const destinoSaida = await resolverDestino(afiliado);

    if (!destinoSaida) {
      return {
        ok: false,
        motivo: 'destino_saida_nao_resolvido',
        chave: item.chave,
        link_afiliado: afiliado,
      };
    }

    console.log(`Destino origem: ${destinoOrigem}`);
    console.log(`Destino saída:  ${destinoSaida}`);

    if (!mesmaOferta(destinoOrigem, destinoSaida)) {
      return {
        ok: false,
        motivo: 'destino_oferta_diferente',
        chave: item.chave,
        destino_origem: destinoOrigem,
        destino_saida: destinoSaida,
      };
    }

    console.log('✓ Destino confirmado: mesma oferta.');

    const conversao = {
      item,
      link_afiliado: afiliado,
    };

    const oferta = {
      id: conversao.item.produto_id,
      titulo: conversao.item.titulo,
      link: conversao.item.link_original,
    };

    registrarConvertido(
      oferta,
      conversao.link_afiliado,
      {
        origem: 'cdp-local',
        destino_origem: destinoOrigem,
        destino_saida: destinoSaida,
      }
    );

    marcarConvertido(
      conversao.item.chave,
      conversao.link_afiliado
    );

    return {
      ok: true,
      dry_run: false,
      conversoes: [{
        chave: item.chave,
        original: item.link_original,
        afiliado,
        destino_origem: destinoOrigem,
        destino_saida: destinoSaida,
      }],
    };
  }

  /*
   * Lotes de 2–5 links continuam usando somente evidência estrutural.
   * Nunca associar resultados pela posição.
   */
  const conversoes = [];
  const usados = new Set();

  for (const item of itens) {
    const matches = unicos.filter((link) =>
      correspondeEstruturalmente(link, item)
    );

    if (matches.length !== 1) {
      return {
        ok: false,
        motivo: 'matching_ambiguo',
        chave: item.chave,
        candidatos: matches.length,
      };
    }

    const afiliado = matches[0];

    if (usados.has(afiliado)) {
      return {
        ok: false,
        motivo: 'matching_ambiguo',
        chave: item.chave,
        candidatos: 2,
      };
    }

    usados.add(afiliado);

    if (
      normalizarUrlLocal(item.link_original) ===
      normalizarUrlLocal(afiliado)
    ) {
      return {
        ok: false,
        motivo: 'link_nao_convertido',
        chave: item.chave,
      };
    }

    conversoes.push({
      item,
      link_afiliado: afiliado,
    });
  }

  if (conversoes.length !== itens.length) {
    return {
      ok: false,
      motivo: 'matching_ambiguo',
      candidatos: conversoes.length,
    };
  }

  for (const conversao of conversoes) {
    const oferta = {
      id: conversao.item.produto_id,
      titulo: conversao.item.titulo,
      link: conversao.item.link_original,
    };

    registrarConvertido(
      oferta,
      conversao.link_afiliado,
      {
        origem: 'cdp-local',
      }
    );

    marcarConvertido(
      conversao.item.chave,
      conversao.link_afiliado
    );
  }

  return {
    ok: true,
    dry_run: false,
    conversoes: conversoes.map((x) => ({
      chave: x.item.chave,
      original: x.item.link_original,
      afiliado: x.link_afiliado,
    })),
  };
}

async function main() {
  console.log('=== CONVERSOR SHOPEE LOCAL — CDP ===');
  console.log(`CDP: 127.0.0.1:${PORT}`);
  console.log(`Dry-run: ${DRY_RUN}`);
  console.log(`Lote máximo: ${MAX_LOTE}`);

  const pendentes = listarPendentes();

  if (pendentes.length === 0) {
    console.log('Nenhum link pendente.');
    return;
  }

  const lote = pendentes.slice(0, MAX_LOTE);

  console.log(`Pendentes: ${pendentes.length}`);
  console.log(`Processando lote: ${lote.length}`);

  const pagina = await obterPaginaCustomLink();

  console.log('Aba encontrada:');
  console.log(`  ${pagina.url}`);

  const ws = new WebSocket(pagina.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  try {
    const r = await executarLote(ws, lote);

    const resultado = {
      gerado_em: new Date().toISOString(),
      status: r.ok
        ? DRY_RUN
          ? 'dry_run'
          : 'convertido'
        : 'erro',
      dry_run: DRY_RUN,
      pendentes: pendentes.length,
      lote: lote.length,
      resultado: r,
    };

    if (DRY_RUN) {
      console.log('');
      console.log(
        'DRY-RUN: nenhuma gravação de fila/cache e nenhum clique executado.'
      );
    }

    escreverResultado(resultado);

    console.log('');
    console.log(JSON.stringify(resultado, null, 2));
    console.log('');
    console.log(`Resultado salvo em: ${RESULTADO}`);
  } finally {
    ws.close();
  }
}

main().catch((err) => {
  console.error('❌ Conversor CDP:', err.message);
  process.exit(1);
});
