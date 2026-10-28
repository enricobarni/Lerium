# Progresso — Lerium

> Registro do que foi **realmente executado**. Hashes, testes e commits listados aqui existem de fato.
> Contrato de execução: [PLAN.md](PLAN.md). Escopo: [SCOPE.md](SCOPE.md).

## Estado atual

- **Fase:** 1 — Fundação e ferramentas
- **Tarefa:** `chore/project-bootstrap` concluída localmente; próximas: `ci/quality-gates` e `feat/popup-shell`
- **Versão:** `0.0.1` (pré-release; `0.1.0` reservada para a conexão com o Ollama, PLAN.md §5.4)
- **Fase 0:** concluída — PRs #1 a #4 mesclados com merge commit (hashes preservados)

## Fase 1 — `chore/project-bootstrap`

| Commit | Mensagem |
|---|---|
| `0618fe3` | `chore(git): adiciona gitignore e gitattributes` |
| `339463f` | `build(deps): inicializa package.json e typescript strict` |
| `efca6de` | `chore(lint): configura eslint e prettier` |
| `ca9dea8` | `feat(manifest): adiciona manifesto mv3 e ícones originais` |
| `4808494` | `build(extension): configura vite com entrada de popup` |
| `a377292` | `test(manifest): valida contrato mínimo do manifesto` |
| `6c9809e` | `build(typescript): separa tipos do navegador e do node` |
| `4530554` | `test(manifest): restringe chaves do manifesto a lista aprovada` |
| (este commit) | `docs(progress): registra bootstrap da fase 1` |

**Validações executadas:** `npm ci` (0 vulnerabilidades); `npm run lint`, `typecheck`, `test` (9/9) e `build` com código 0; `dist/` contém `manifest.json`, `icons/` e `popup/index.html`; `git status --short --ignored` mostra só `dist/` e `node_modules/` ignorados; `git check-ignore -v` confirma as regras; lockfile, manifesto, PNGs e testes versionados; todos os arquivos com EOL `lf` no índice. Provas negativas: `process` em `src/` falha no typecheck; chave `background` no manifesto falha no teste.

**Decisões:**
- Build com Vite configurado manualmente (sem `@crxjs/vite-plugin`): menos dependências; build de content script será reavaliada em ADR própria na Fase 3/4.
- Manifesto com `permissions: []`, sem service worker nem content script (ADR-002 segue em aberto).
- TypeScript `~6.0`: o `typescript-eslint` atual não suporta 7.x.
- `tsconfig.json` (src, tipos `chrome`) separado de `tsconfig.node.json` (tests e configs, tipos `node`).
- Prettier aplicado só a código (`ts, js, mjs, json, html, css`), sem reformatar a documentação.
- Ícones originais gerados por `scripts/generate-icons.mjs`, sem dependências.

**Pendências da branch:** teste manual de *Load unpacked* no Chrome (a ser feito pelo responsável). Nos commits `339463f`–`ca9dea8` o typecheck falha com TS18003 (ainda sem arquivos `.ts`), documentado no corpo de `339463f`.

## Fase 0 — Commits

| Branch | Commit | Mensagem |
|---|---|---|
| `main` | `5482896` | `docs(plan): adiciona plano de desenvolvimento inicial` (exceção aprovada pelo responsável) |
| `docs/product-scope` | `f60cc42` | `docs(plan): move plano para docs/PLAN.md` |
| `docs/product-scope` | `0333825` | `docs(scope): define requisitos e limites do MVP` |
| `docs/product-scope` | `9e755f8` | `docs(scope): registra referência e limites de licença` |
| `docs/product-scope` | `c9843ce` | `docs(scope): alinha prazos e completa resumos de RF04 e RF05` |
| `docs/architecture` | `fc45153` | `docs(architecture): define limites de responsabilidade` |
| `docs/architecture` | `242e9fe` | `docs(architecture): registra adr-001 mv3, typescript e ollama` |
| `docs/architecture` | `236fac0` | `docs(test): define plano de testes e fixture própria` |
| `docs/architecture` | `293ea6a` | `docs(test): inclui comentário html na fixture de novel` |
| `docs/agent-rules` | `1746af7` | `docs(agents): resume regras de execução para agentes` |
| `docs/agent-rules` | `96c2a65` | `docs(progress): registra estado da fase 0` |
| `docs/agent-rules` | `2d242ab` | `docs(agents): esclarece o que é versionado no build` |
| `docs/agent-rules` | (este commit) | `docs(progress): registra correções da revisão` |

Ordem de merge: `docs/product-scope` → `docs/architecture` → `docs/agent-rules` (os links relativos para `PLAN.md` e `SCOPE.md` só resolvem após o primeiro merge).

## Fase 0 — Tarefas

- [x] Repositório confirmado como independente da referência (histórico próprio, sem código copiado).
- [x] Licença da referência verificada via API do GitHub: README declara MIT, mas não há `LICENSE` e o metadado é `null`. Decisão: implementar só comportamento. Status: **não confirmada** (ver SCOPE.md).
- [x] `docs/ARCHITECTURE.md` com limites de responsabilidade.
- [x] `docs/DECISIONS.md` com ADR-001 (aceita) e ADR-002 a ADR-005 (propostas).
- [x] `docs/TEST_PLAN.md` com cenário de novel e fixture HTML própria (a ser criada na Fase 4).
- [x] `docs/PROGRESS.md` e `AGENTS.md`.
- [x] Licença do Lerium definida: MIT (`LICENSE`, [ADR-006](DECISIONS.md)), branch `docs/license`.

## Validações executadas

- `git diff --cached --check` antes de cada commit: sem erros.
- Assuntos de commit no formato Conventional Commits, com até 72 caracteres.
- Nenhum `package.json`, `tsconfig`, `manifest.json`, `src/` ou código criado (fora do escopo da Fase 0).
- `npm run lint`, `typecheck`, `test` e `build` **não existem ainda**; serão criados na Fase 1.
- Links relativos conferidos no estado combinado das três branches: nenhum quebrado; sem CRLF.
- Revisão do reviewer: **aprovado com ressalvas**; ressalvas importantes (texto de versionamento no AGENTS.md e prazo da licença) e menores (prazos, RF04/RF05, comentário na fixture) corrigidas em commits próprios.

## Observações

- A seção 12 do plano cita `PLANEJAMENTO_EXTENSAO_TRADUCAO_LOCAL.md`; o arquivo real foi versionado como `planejamento_tradutor_ia.md` e movido para `docs/PLAN.md`. O plano não foi editado.
- O nome do produto é **Lerium**, substituindo o codinome `local-novel-translator`.
- `.gitignore` adiado para a Fase 1, onde está previsto (PLAN.md §5.5); a Fase 0 só adiciona Markdown.

## Pendências

- [x] `"license": "MIT"` declarado no `package.json` (`339463f`).
- CORS (`OLLAMA_ORIGINS`) fica registrado apenas em SCOPE.md; vira ADR quando for testado na Fase 2.
- Demais decisões em aberto: ver SCOPE.md e DECISIONS.md (ADR-002 a ADR-005).

## Próxima tarefa

Fase 1 — `ci/quality-gates`: workflow do GitHub Actions (lint, typecheck, test, build) e template de PR.
