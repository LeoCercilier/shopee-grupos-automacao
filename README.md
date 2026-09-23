# shopee-grupos-automacao

Sistema **independente**: coleta, classificação e seleção de ofertas Shopee para grupos do Facebook por nicho.

Inclui MVP de **agente de navegador** (Playwright) para provar publicação em **1 grupo** via interface web.

---

## Fluxo

```
Fonte Shopee → Coletor → Classificação → Seleção oferta×grupo
       → (Graph API Página→Grupo: indisponível)
       → Agente de navegador (MVP local) → Histórico (só após sucesso real)
```

---

## Limitação da Graph API

| Cenário | API oficial? |
|---------|----------------|
| Publicar **na Página** | Sim |
| Publicar **em Grupo** (`publish_to_groups`) | **Não** (removida abr/2024) |
| Publicar **em Grupo** como Página | Não documentado |

`src/publicador.js` continua registrando essa limitação. A publicação em grupos no MVP usa **navegador local**, não a API.

---

## MVP — agente de navegador (1 oferta × 1 grupo)

### Instalação

```bash
npm install
npx playwright install chromium
```

### 1) Login manual (uma vez)

```bash
npm run browser:login
```

- Abre o Chromium com perfil em `.browser-session/` (gitignored).
- Faça login no Facebook **manualmente** (2FA se pedir).
- Volte ao terminal e pressione **ENTER**.
- **Não** coloque senha no código nem no GitHub.

### 2) Gerar seleção (se ainda não tiver)

```bash
npm run pipeline
# ou: npm run coletar && npm run classificar && npm run selecionar
```

Usa `data/selecao-atual.json` (já produzido pelo seletor).

### 3) Teste controlado (padrão: só preparar)

```bash
npm run browser:preparar
```

- Abre **1** seleção elegível.
- Entra no grupo (`group_id`).
- Abre o compositor, preenche o texto, tenta anexar imagem.
- **Não** clica em Publicar.
- Salva screenshot em `data/screenshots/`.
- **Não** grava histórico.

### 4) Publicar de verdade (opcional)

```bash
MODO_PUBLICACAO_BROWSER=publicar npm run browser:publicar
```

- Clica em Publicar.
- Só chama `registrarPublicacao` se houver **confirmação** na UI.
- Se ficar incerto, **não** marca como publicado.

### Filtros opcionais

```bash
BROWSER_GRUPO_ID=987613641743046 npm run browser:preparar
BROWSER_GRUPO_INTERNO=grupo-geral-1 npm run browser:preparar
BROWSER_DRY_RUN=true npm run browser:teste
```

### Segurança

- Sessão só em `.browser-session/` (ignorado pelo git).
- Sem senha no repositório.
- CAPTCHA/checkpoint → **para** e registra o motivo.
- Não usa API privada/depreciada de grupos.

---

## Estrutura relevante

| Papel | Arquivo |
|-------|---------|
| Grupos | `config/grupos.json` |
| Coletor | `src/coletor.js` |
| Classificador | `src/classificador.js` |
| Seletor / “fila” atual | `src/seletor.js` → `data/selecao-atual.json` |
| Histórico | `src/historico.js` → `data/historico-publicacoes.json` |
| Graph API (limitado) | `src/publicador.js` |
| Pipeline CI | `src/pipeline.js` + `.github/workflows/pipeline.yml` |
| **Navegador MVP** | `src/navegador/*` |

O workflow do GitHub Actions **não** executa o navegador (login interativo / sessão local).

---

## Licença

MIT
