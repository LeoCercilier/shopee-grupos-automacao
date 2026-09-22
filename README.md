# shopee-grupos-automacao

Sistema **independente** de automação: coleta, classificação e seleção de ofertas Shopee para grupos do Facebook por nicho, com publicação **opcional** via **Page Access Token** em grupos que aceitam postagem de Página.

---

## Objetivo

```
Fonte Shopee (ofertas.html / edge function)
        ↓
     Coletor
        ↓
 Classificação por nicho
        ↓
 Seleção da oferta × grupo
        ↓
   Agendamento (GitHub Actions)
        ↓
 Publicador (dry-run por padrão)
        ↓
 Histórico (somente após sucesso real)
```

---

## Publicação em grupos (opção C — Página)

A permissão `publish_to_groups` (usuário membro) foi **removida** pela Meta em abril/2024.

Ainda é possível, em **alguns** grupos, publicar **como Página** se:

1. O grupo permitir posts de Páginas / a Página estiver autorizada no grupo;
2. Você usar um **Page Access Token** com `pages_manage_posts` e `pages_read_engagement`;
3. O endpoint usado for `POST /{group-id}/photos` (com imagem) ou `POST /{group-id}/feed`.

Este projeto implementa isso em `src/publicador.js`.

### Controle de segurança

| Variável | Valor | Efeito |
|----------|--------|--------|
| `PUBLICAR` | `false` (padrão) | Dry-run: só registra o que *faria* |
| `PUBLICAR` | `true` | Tenta publicar de verdade |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | (Secret) | Token da Página (nunca senha) |

No GitHub Actions, o disparo manual tem o input `publicar` (padrão `false`). O cron **não** publica de verdade até você configurar o Secret e alterar o fluxo se desejar.

### Secrets neste repositório (independente)

- `FACEBOOK_PAGE_ACCESS_TOKEN` — Page token da **sua** Página
- Opcional: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`

**Não copie** tokens do projeto `shopee-facebook-automacao` automaticamente; configure Secrets **deste** repo.

### Limitações

- Só funciona em grupos que **aceitam post de Página**.
- Grupos só-para-membros (perfil) **não** serão atendidos por este caminho.
- Se a API recusar, o item fica com `status: erro` em `data/resultado-publicacao.json` e **não** entra no histórico.

---

## Fonte das ofertas

**https://leocercilier.github.io/shopee-achadinho/ofertas.html**

Edge function `shopee-products-v2` (mesma da página pública).

---

## Estrutura

```
config/grupos.json
data/
  ofertas-brutas.json
  ofertas-classificadas.json
  selecao-atual.json
  historico-publicacoes.json
  resultado-publicacao.json
src/
  coletor.js
  classificador.js
  seletor.js
  publicador.js      ← Page token → grupo
  historico.js
  pipeline.js
  utils.js
.github/workflows/pipeline.yml
```

---

## Configurar grupos

Em `config/grupos.json`:

```json
{
  "id": "grupo-casa-1",
  "nome": "Grupo Casa",
  "group_id": "811021770682797",
  "nicho": "casa",
  "ativo": true,
  "prioridade": 1
}
```

Procure grupos que **aceitem postagem por Página**, adicione a Página ao grupo (ou ative a permissão) e mantenha o `group_id` correto.

---

## Histórico

- Cooldown de **7 dias** por oferta × grupo.
- `registrarPublicacao` só após sucesso real do publicador.

---

## Uso local

```bash
npm install
cp .env.example .env

npm run pipeline          # coleta + classifica + seleciona + dry-run do publicador
PUBLICAR=false npm run publicar
# PUBLICAR=true FACEBOOK_PAGE_ACCESS_TOKEN=... npm run publicar   # real
```

---

## GitHub Actions

- Até 8 execuções/dia (cron UTC).
- `workflow_dispatch` com input **publicar** (`false` por padrão).
- Com `publicar=false`: gera seleção e dry-run.
- Com `publicar=true` **e** Secret `FACEBOOK_PAGE_ACCESS_TOKEN`: tenta postar nos grupos selecionados.

---

## Formato do texto

```
🔥 OFERTA DO DIA

{titulo}

💰 {preco}

🛍️ Confira na Shopee:
{link}
```

---

## Licença

MIT
