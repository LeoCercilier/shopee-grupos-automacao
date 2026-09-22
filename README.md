# shopee-grupos-automacao

Sistema **independente** de automação focado na coleta, classificação e preparação de ofertas da Shopee para distribuição em **grupos do Facebook** por nicho.

> **Importante:** este projeto **não** publica automaticamente em grupos do Facebook no momento. A API oficial de Groups da Meta foi removida em abril/2024. O código está preparado para receber um mecanismo de publicação futuro sem precisar refazer a arquitetura.

---

## Objetivo

```
Fonte Shopee (ofertas.html / edge function)
        ↓
     Coletor
        ↓
 Classificação por nicho
        ↓
 Seleção da oferta
        ↓
 Seleção do grupo compatível
        ↓
   Agendamento (GitHub Actions)
        ↓
 [Publicação no grupo — futuro]
        ↓
     Histórico
```

---

## Limitação oficial: publicação em grupos

A Meta **removeu** a Facebook Groups API (incluindo a permissão `publish_to_groups`) em **22 de abril de 2024**, a partir do Graph API v19.0 e de **todas** as versões.

Consequências:

- Não existe mais permissão oficial `publish_to_groups` para apps novos ou existentes.
- Não é possível publicar em grupos (como membro ou admin) via Graph API pública de forma suportada.
- Ferramentas de terceiros que dependiam dessa API pararam de funcionar.
- Meta não oferece alternativa oficial de API para esse cenário.

Fontes:
- [Changelog Graph API v19.0](https://developers.facebook.com/docs/graph-api/changelog/version19.0)
- Anúncios e discussões da comunidade de desenvolvedores Meta (2024–2026)

Por isso este repositório:

1. **Não implementa** automação baseada em senha/sessão do Facebook.
2. **Não inventa** integração não oficial.
3. Mantém coleta, classificação, seleção, histórico e agenda prontos.
4. Deixa o ponto de publicação como extensão futura (quando/ se houver canal oficial ou decisão consciente de outro mecanismo).

---

## Fonte das ofertas

Mesma fonte pública do site:

**https://leocercilier.github.io/shopee-achadinho/ofertas.html**

A página consome a edge function Supabase `shopee-products-v2`. O coletor deste projeto chama a **mesma API pública** (chave publishable), extraindo:

- título
- preço
- link de afiliado
- imagem(ns)
- vendas / avaliação / desconto (quando disponíveis)

Não depende do repositório `shopee-facebook-automacao`.

---

## Estrutura do projeto

```
shopee-grupos-automacao/
├── config/
│   └── grupos.json              # Cadastro de grupos por nicho
├── data/
│   ├── ofertas-brutas.json      # Saída do coletor (gerado)
│   ├── ofertas-classificadas.json
│   ├── selecao-atual.json       # Pares oferta × grupo prontos
│   └── historico-publicacoes.json
├── src/
│   ├── coletor.js               # Coleta via Supabase edge function
│   ├── classificador.js         # Classifica por nicho (regras de palavras-chave)
│   ├── seletor.js               # Escolhe oferta + grupo (respeita histórico)
│   ├── historico.js             # Controle de 7 dias por grupo
│   ├── pipeline.js              # Orquestra tudo
│   └── utils.js
├── .github/workflows/
│   └── pipeline.yml             # Até 8 horários/dia + workflow_dispatch
├── package.json
├── .env.example
└── README.md
```

---

## Como configurar os grupos

Edite `config/grupos.json`:

```json
{
  "id": "meu-grupo-beleza",
  "nome": "Nome amigável",
  "group_id": "123456789012345",
  "nicho": "beleza",
  "ativo": true,
  "prioridade": 1
}
```

- `nicho`: `beleza` | `eletronicos` | `casa` | `moda` | `pets` | `ferramentas` | `saude` | `geral`
- Grupo com `nicho: "geral"` pode receber qualquer oferta.
- Só grupos com `"ativo": true` entram na seleção.
- `group_id` fica reservado para quando houver mecanismo de publicação.

---

## Histórico

Arquivo: `data/historico-publicacoes.json`

- Evita republicar a **mesma oferta no mesmo grupo** por **7 dias**.
- Registro só deve ser gravado **após** publicação real bem-sucedida (quando o módulo de publicação existir).
- Limpeza automática de registros antigos (retenção ~30 dias).

---

## Uso local

```bash
npm install
cp .env.example .env   # opcional — defaults já apontam para a fonte pública

npm run coletar        # só coleta
npm run classificar    # classifica o último ofertas-brutas.json
npm run selecionar     # gera selecao-atual.json
npm run pipeline       # tudo em sequência
npm test               # checagem de sintaxe
```

---

## GitHub Actions

Workflow: `.github/workflows/pipeline.yml`

- Agenda: até 8 execuções por dia (cron em UTC).
- `workflow_dispatch` para disparo manual.
- Gera/atualiza artefatos em `data/` e faz commit se houver mudança.

Secrets opcionais (senão usa defaults públicos da fonte):

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`

---

## Formato de texto preparado

O seletor já monta o texto no formato:

```
🔥 OFERTA DO DIA

{titulo}

💰 {preco}

🛍️ Confira na Shopee:
{link}
```

---

## Próximos passos possíveis

1. Cadastrar grupos reais em `config/grupos.json` e marcar `ativo: true`.
2. Ajustar horários do cron se necessário.
3. Quando houver decisão sobre **como** publicar em grupos (sem violar ToS / sem API oficial):
   - adicionar um módulo `src/publicador.js` isolado;
   - chamar `registrarPublicacao` do histórico apenas após sucesso.
4. Não misturar este projeto com tokens/Secrets da Página do outro repositório.

---

## Licença

MIT
