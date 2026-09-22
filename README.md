# shopee-grupos-automacao

Sistema **independente**: coleta, classificação e seleção de ofertas Shopee para grupos do Facebook por nicho.

Publicação via Graph API (**opção C**) fica preparada, com `PUBLICAR=false` por padrão.

---

## Fluxo

```
Fonte Shopee → Coletor → Classificação → Seleção oferta×grupo
       → Publicador (dry-run por padrão) → Histórico (só após sucesso real)
```

---

## Limitação crítica da Graph API

| Cenário | API oficial? |
|---------|----------------|
| Publicar **na Página** (`POST /{page-id}/feed`) | Sim (Pages API) |
| Publicar **em Grupo** como usuário (`publish_to_groups`) | **Não** — removida em abril/2024 |
| Publicar **em Grupo** como Página | **Não documentado / não suportado** na Graph API pública atual |

O módulo `src/publicador.js` **não inventa** endpoint. Em dry-run ou com `PUBLICAR=true`, registra:

> **API oficial não disponível para este grupo/cenário.**

Histórico **não** é atualizado sem sucesso real (hoje: zero sucessos possíveis via API oficial Página→Grupo).

---

## Configuração grupo → Página

- `config/grupos.json` — grupos + `pagina_id`
- `config/paginas.json` — Páginas + `page_id` + nome da env do token (`token_env`)

Tokens **somente** em Secrets / env, nunca no git.

### Secrets sugeridos (neste repositório)

- `FACEBOOK_PAGE_ACCESS_TOKEN`
- `FACEBOOK_PAGE_ID` (opcional; também pode ir em `config/paginas.json`)

`PUBLICAR=false` (padrão)

---

## Uso

```bash
npm install
npm run pipeline          # coleta + classificação + seleção + dry-run
PUBLICAR=false npm run publicar
npm test
```

Ativar publicação real no futuro (só faria sentido se a Meta restabelecer endpoint oficial):

1. Configurar Secrets
2. Preencher `page_id` em `config/paginas.json`
3. Actions → Run workflow com `publicar=true` **ou** `PUBLICAR=true`

Hoje, mesmo com `PUBLICAR=true`, o publicador **recusa** Página→Grupo e explica a limitação.

---

## Estrutura

```
config/grupos.json
config/paginas.json
src/coletor.js | classificador.js | seletor.js | publicador.js | historico.js | pipeline.js
.github/workflows/pipeline.yml
```

---

## Licença

MIT
