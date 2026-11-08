# Passagem de contexto — Lerium

> **Leia este arquivo primeiro ao abrir uma sessão nova.** Ele resume onde o
> projeto está, como o trabalho é conduzido e o que fazer em seguida. Os
> detalhes ficam nos documentos de referência; aqui há os ponteiros.
>
> Atualizado em 08/11/2026, com `main` em `7ff72e4` (merge do PR #28).

## 1. Onde paramos (resumo de 30 segundos)

- **Fases 0 a 4 concluídas.** Versões `0.1.0` (tag em `ab06507`) e `0.2.0`
  (tag em `1ed9d20`) publicadas pelo responsável.
- **Fase 5 com todo o código mesclado** (PRs #24–#28): fila com prioridade,
  prioridade por viewport ao rolar, interrupção de tradução fora da tela,
  prioridade por trecho em capítulos com `<br>` e indicador de progresso na
  página.
- **Falta só o Gate da Fase 5**, que depende de medições do responsável no
  Chrome real (seção 4.1). **Nenhuma branch de código está aberta.**
- **Estado do repositório:** só `main` local; sem worktrees de agentes;
  2068 testes (48 arquivos) e 35 E2E passando; CI verde.
- **Combinado na última sessão:** documentar e **não prosseguir**. A próxima
  sessão começa pela seção 4.

## 2. O produto

Extensão Chrome MV3 que traduz páginas com um modelo local no Ollama
(`translategemma:4b`), interface em PT-BR, sem servidor, sem nuvem, sem
coletar texto. Hoje: clique no ícone → **Traduzir página** → o texto visível
é traduzido primeiro, com indicador na página; **Mostrar original** restaura
o HTML byte a byte.

Documentos de referência (o plano prevalece em conflito):

| Documento | Para quê |
|---|---|
| [PLAN.md](PLAN.md) | Contrato: requisitos RF01–RF07, roadmap por fases, regras de Git |
| [SCOPE.md](SCOPE.md) | Escopo do MVP, licença da referência (não confirmada) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Camadas e fluxo MV3 |
| [DECISIONS.md](DECISIONS.md) | ADR-001 a ADR-019 (004 e 005 ainda propostas) |
| [TEST_PLAN.md](TEST_PLAN.md) | Estratégia, smoke manual, roteiros de medição |
| [PROGRESS.md](PROGRESS.md) | Histórico real de cada branch, com hashes e validações |
| [../CHANGELOG.md](../CHANGELOG.md) | Mudanças por versão (`[Não lançado]` tem a Fase 5) |
| [../AGENTS.md](../AGENTS.md) | Regras para agentes (resumo do plano) |

## 3. Arquitetura em uma página

```text
popup (src/popup) ──page:inject──▶ service worker (src/background)
     │                               │ injeta content.js (activeTab + scripting)
     │                               │ único cliente HTTP do Ollama (ADR-009)
     └──page:command──▶ content script (src/content)
                             │ Port por job "lerium:page-job" (ADR-010)
                             ▼
  coleta (ADR-012) → segmenta (ADR-013) → fila com prioridade (ADR-015/016/018)
  → unidade enviada ao SW → resposta aplicada via node.data (ADR-014)
  → estado do job → popup e indicador na página (ADR-019)
```

- **`src/core`**: lógica pura (parser NDJSON, cliente Ollama, prompt
  versionado, provider, fila `translation-scheduler`, limites de texto).
- **`src/background`**: roteador de mensagens, injeção, job por Port,
  semáforo global FIFO entre abas (`translation-gate`).
- **`src/content`**: coletor, segmentador, aplicador, executor do job
  (`job-runner`), observadores de visibilidade (`visibility-watcher`,
  `segment-zone-tracker`, `zone-rect`), indicador (`progress-overlay`,
  `progress-view`), ligação (`controller`, `index`).
- **`src/popup`, `src/options`, `src/storage`, `src/shared`**: interface,
  configurações (`chrome.storage`), mensagens e textos compartilhados.
- **Manifesto**: `activeTab`, `scripting`, `storage`; host só loopback
  `:11434`; Chrome mínimo 114 (ADR-002). O build (`scripts/verify-dist.mjs`)
  barra permissões fora da lista, sourcemaps, APIs perigosas e shadow root
  aberto.

Números que regem o comportamento:

| Constante | Valor | Onde | Por quê |
|---|---|---|---|
| `MAX_UNITS_IN_FLIGHT` | 1 | `src/shared/page-messages.ts` | 4 simultâneas só ganharam 4,3% no CPU do responsável (ADR-015) |
| `PREEMPT_DEBOUNCE_MS` | 500 | `src/content/job-runner.ts` | Interrompe a unidade fora da tela se o visível espera ≥ 500 ms (ADR-017) |
| `MAX_ZONE_MEASURES_PER_FRAME` | 64 | `src/content/segment-zone-tracker.ts` | Teto de medições por quadro em blocos com `<br>` (ADR-018) |
| `AUTO_HIDE_MS` | 5000 | `src/content/progress-overlay.ts` | Indicador some 5 s depois do sucesso (ADR-019) |
| `MAX_SEGMENT_CHARS` | 6000 | `src/core/text-limits.ts` | Teto por segmento |

Medido no hardware do responsável (i5-13420H, só CPU): 3–8 s por parágrafo;
`firstVisibleMs` 2–4 s e `visibleLatency` 3–5 s no Chrome real.

## 4. Próximos passos, em ordem

### 4.1 Responsável: medições do Gate da Fase 5 (bloqueia o resto)

Roteiro completo em [TEST_PLAN.md](TEST_PLAN.md), seção “Roteiro para o Gate
da Fase 5”. Resumo:

1. **Memória** (Shift+Esc no Chrome): aba e “Extensão: Lerium” antes, no
   pico, ao terminar e 30 s depois de “Mostrar original”; memória do `ollama`
   no Gerenciador de Tarefas do Windows.
2. **Tarefas longas**: colar o snippet do `PerformanceObserver` no console,
   traduzir, rolar 30 s, ler `n` e `m`; repetir só rolando, sem traduzir.
3. **Tempos**: `firstVisibleMs`, `durationMs`, `visibleLatency`, `preempted`
   (seção “Como ler as métricas de prioridade”).
4. **Smoke do indicador**: aparece, conta, some no sucesso, fica no erro,
   “Fechar”; com Dark Reader (modo filtro), tema escuro e, se possível,
   leitor de tela.
5. **Capítulo com `<br>`** num site real: o trecho na tela é traduzido antes.

Critério proposto: nenhuma tarefa longa atribuível ao Lerium acima de 50 ms
durante a rolagem, memória estável depois de terminar, nenhuma pausa
perceptível.

### 4.2 Agente: registrar o Gate e a versão 0.3.0

Com os números do responsável:

1. Branch `docs/phase-5-gate`: resultados no PROGRESS e no TEST_PLAN; Fase 5
   marcada como concluída. Se alguma medição falhar, abrir antes uma branch
   `fix/...` com causa raiz investigada pelo debugger.
2. Branch `chore/release-0.3.0`: versão em `package.json`,
   `package-lock.json` e `public/manifest.json`; mover `[Não lançado]` do
   CHANGELOG para `[0.3.0]`; validar lint, typecheck, test, build e E2E.
3. Tag `v0.3.0` e release: **feitas pelo responsável** depois do merge.

### 4.3 Depois: Fase 6 — Seleção, contexto e controles

Do PLAN.md: tradução de seleção pelo popup, menus de contexto (seleção e
página), alternar tradução/original, parar, retomar, nova tentativa no erro,
estado real e feedback claro, ações com o popup fechado. Branches previstas:
`feat/selection-translation`, `feat/context-menus`,
`feat/translation-toggle`. Gate: todas as entradas usam o mesmo motor;
desativar interrompe alterações tardias; original sempre recuperável.

Antes de codificar: **o architect planeja primeiro**; a ADR-005 (UX da
seleção) ainda está **proposta** e precisa ser decidida. Menus de contexto
exigem a permissão `contextMenus`: mudança de manifesto, a explicar ao
responsável e a refletir na lista do `verify-dist`.

Depois vêm a Fase 7 (SPA, jobs antigos, domínios excluídos, revisão de
segurança) e a Fase 8 (validação real e entrega do MVP).

## 5. Pendências registradas

| Pendência | Origem | Destino |
|---|---|---|
| Medições do Gate da Fase 5 e smoke do indicador | Fase 5 | Seção 4.1 |
| Medir no Chrome real um capítulo com `<br>` | ADR-018 | Seção 4.1 |
| Cache de segmentos repetidos (“não retraduzir o inalterado”, do plano) | Fase 5 | Adiado para as Fases 6/7, aprovado pelo responsável |
| Interrupção com duas abas traduzindo: o semáforo é global, a interrupção só olha a própria aba | ADR-017 | Limitação aceita; rever na Fase 7 |
| Opção para desligar o indicador | ADR-019 | P1 |
| ADR-004 (identidade de job/documento) e ADR-005 (UX da seleção) propostas | Fase 0 | Fases 6 e 7 |
| Licença da extensão de referência não confirmada | SCOPE.md | Só comportamento observável; nunca copiar código |
| Um E2E de cancelamento levou 29,4 s uma vez, perto do limite | Fase 5 | Observar; não se repetiu |

## 6. Como o trabalho é conduzido

### Fluxo por tarefa

1. **Architect planeja** (impacto, riscos, etapas, critérios de aceite).
2. O orquestrador consolida e separa o que é paralelo do que é sequencial.
3. Agentes especializados executam. Trabalho paralelo vai para **worktrees
   isoladas** e entra na branch por `cherry-pick`; nunca dois agentes no
   mesmo checkout.
4. **Reviewer** revisa o diff (security quando há permissões, DOM ou dados);
   achados são aplicados ou registrados com motivo.
5. **Testing** cobre o comportamento; o E2E roda **3 vezes** antes do PR.
6. Falha inesperada → **debugger** com causa raiz e evidência antes de
   corrigir; nunca afrouxar asserção sem causa demonstrada.
7. Docs (ADR, PROGRESS, TEST_PLAN, CHANGELOG) no último commit da branch.
8. Push da branch, PR com o checklist do PLAN §5.3, esperar o CI.
9. **O responsável faz o merge**, cria tags e releases. Depois o agente
   atualiza `main` e limpa branches e worktrees com autorização.

### Regras do responsável (permanentes)

- Commits em Conventional Commits, PT-BR, assunto ≤ 72 caracteres, sem linhas
  de atribuição; `git diff --check` antes de cada commit.
- Sem commit em `main`; uma branch curta por tarefa (`tipo/descricao`).
- Sem merge, tag, release ou deploy pelo agente. Push de branch de trabalho e
  abertura de PR são o fluxo aceito.
- Sem `rm`, `git reset`, `git clean`, `git stash` ou outra ação destrutiva sem
  autorização explícita. Limpeza de worktrees e branches já integradas é
  autorizada caso a caso, depois de conferir com `git cherry` que nada se
  perde.
- Explicar antes de instalar dependências; só dependências gratuitas.
- **Nunca** fechar o Ollama do responsável nem mudar o `OLLAMA_ORIGINS` dele.
- Nunca registrar texto de página em log; nunca inventar hashes ou resultados.
- Navegação web: skill `/browse`; **nunca** as ferramentas
  `mcp__claude-in-chrome__*`.
- O responsável está aprendendo: explicar o raciocínio de cada decisão.

### Ambiente

- Windows 11, Git Bash e PowerShell; Node pela `.nvmrc`.
- Ollama do responsável em `127.0.0.1:11434`. Se ele estiver aberto, o E2E
  local falha (o mock usa a mesma porta): avisar e confiar no CI, **sem**
  fechar o Ollama.
- Testes com o modelo real: `npm run test:manual` com
  `LERIUM_MANUAL_OLLAMA=1`; o experimento de concorrência usa uma instância
  isolada na porta **11998** (instruções em
  `tests/manual/concurrency.manual.test.ts`).

### Comandos

| Comando | O que faz |
|---|---|
| `npm run lint` | ESLint + Prettier |
| `npm run typecheck` | `tsc` nos quatro tsconfig |
| `npm test` | Vitest (unitários em node, integração em jsdom) |
| `npm run build` | Vite (páginas + `content.js` IIFE) + `scripts/verify-dist.mjs` |
| `npm run test:e2e` | Playwright + Chromium com mock do Ollama |
| `npm run test:manual` | Modelo real, opt-in |

## 7. Lições aprendidas (evitam retrabalho)

- **`comando | tail` esconde o código de saída.** Use `set -o pipefail` ou
  rode o comando sozinho e confira `$?`. Já gerou um commit com lint falhando.
- **Scripts inline pela camada de ferramentas podem transformar a sequência
  barra invertida + `n` numa quebra de linha real.** Em Python, use
  `chr(10)`/`chr(92)`; ou heredoc com delimitador entre aspas. Comandos muito
  longos também falham: escreva arquivos grandes em partes.
- **`git checkout <commit> -- <arquivo>` em laço já deixou o HEAD
  destacado**; confira a branch depois de operações assim.
- **`test.fail()` passa com qualquer falha**: confira qual asserção falhou.
- **Resultado na fronteira → mais amostras**, nunca mudar a regra (o
  experimento de concorrência caiu de −15,4% para −4,3% com 5 rodadas).
- **Aba em segundo plano no Playwright tem quadros limitados a ~1/s**:
  testes que dependem de `requestAnimationFrame` precisam de
  `page.bringToFront()` na fixture (ADR-019, PR #28).
- **jsdom não tem Popover API nem layout real**: posição, top layer e CSP só
  se provam no E2E.
- **O limite de uso pode interromper agentes no meio**: ao retomar, conferir
  `git status` e `git log` de cada checkout e worktree antes de relançar.

## 8. Linha do tempo (PRs)

| Fase | PRs | Entrega |
|---|---|---|
| 0 | #1–#4 | Escopo, arquitetura, guia de agentes, licença MIT |
| 1 | #5–#8 | Configuração do Claude Code, fundação TS/Vite/MV3, CI, popup e opções |
| 2 | #9–#12 | Configurações, descoberta do Ollama, versão 0.1.0 |
| 3 | #13–#16 | Parser NDJSON, prompt, chat em streaming, provider |
| 4 | #17–#23 | Coleta, segmentação, aplicação/restauração, protocolo, injeção, tradução pelo popup, versão 0.2.0 |
| 5 | #24–#28 | Fila com prioridade, viewport, interrupção, blocos com `<br>`, indicador |

Detalhes, hashes e validações de cada branch: [PROGRESS.md](PROGRESS.md).
