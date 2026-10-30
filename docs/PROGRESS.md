# Progresso — Lerium

> Registro do que foi **realmente executado**. Hashes, testes e commits listados aqui existem de fato.
> Contrato de execução: [PLAN.md](PLAN.md). Escopo: [SCOPE.md](SCOPE.md).

## Estado atual

- **Fase:** 3 — Motor de tradução e streaming (gate cumprido; aguardando merge do PR de `test/translation-service`)
- **Tarefa:** `test/translation-service` (provider de tradução, nova tentativa conservadora, fixtures literárias e validação com o modelo real)
- **Versão:** `0.1.0` (esqueleto + conexão com o Ollama, PLAN.md §5.4; ver [CHANGELOG.md](../CHANGELOG.md)). Tag `v0.1.0` autorizada pelo responsável, em `ab06507` (validado: lint, typecheck, 398 testes, build, 8 E2E); criação manual pendente.
- **Fase 2:** concluída — PRs #9 e #10 mesclados; aceite manual do responsável no Chrome estável (conexão, modelos listados, Ollama fechado)
- **Fase 0:** concluída (PRs #1–#4)
- **Fase 1:** concluída — PRs #5–#8 mesclados; aceite manual do popup e das opções pelo responsável (teclado, abertura da aba de opções, tema escuro)

## Fase 3 — `test/translation-service`

| Commit | Mensagem |
|---|---|
| `c3d3d8b` | `feat(core): adiciona invalid_input e consumer_error ao contrato` |
| `80183d4` | `feat(core): implementa provider de tradução sobre o ollama` |
| `ee5de28` | `feat(core): adiciona nova tentativa conservadora ao provider` |
| `1584f86` | `test(core): adiciona fixtures literárias próprias` |
| `8c8f35e` | `test(core): garante cliente único do ollama em src` |
| `250e2dd` | `test(core): adiciona teste manual opt-in com modelo real` |
| `49f384a` | `fix(core): distingue falha interna de entrada inválida no provider` |
| `488ca48` | `test(core): endurece critérios das fixtures literárias` |
| `d9add34` | `test(core): amplia varredura de cliente único em src` |
| `3ec237c` | `docs: documenta motor de tradução e plano de testes da fase 3` |
| `c00ebc3` | `docs(decisions): registra validação real da adr-011` |
| (este commit) | `docs(progress): registra gate da fase 3` |

**O que foi feito:**

- `src/core/ollama-translation-provider.ts`: `createOllamaTranslationProvider` sobre `buildChatRequest` + `chatStream`, com mapeamento exaustivo de erros (`switch` + `never`), `retryable`, `durationMs` e `outputTokens`. Tabela em [ARCHITECTURE.md](ARCHITECTURE.md#motor-de-tradução-fase-3).
- Nova tentativa automática: no máximo uma, após 500 ms canceláveis, só para `network`, stream interrompido e HTTP 429/5xx, e só se nenhum trecho foi entregue. `timeout` sem nova tentativa interna.
- Contrato ganhou `invalid_input`, `consumer_error` e `internal_error` (falha inesperada do Lerium não culpa o texto).
- 6 fixtures literárias autorais em `tests/fixtures/literary/` e teste manual opt-in (`npm run test:manual`, fora do CI).
- Teste de cliente único: só o provider usa `chatStream`, `fetch` só em `background/index.ts` e nenhuma outra API de rede em `src/`.

**Revisão:** reviewer aprovou com ressalvas; aplicadas: catch-all com código próprio, cancelamento logo após falha, piso de tamanho 0,85 no parágrafo longo, canário normalizado, um teste por execução no manual, varredura de rede ampliada e nomes das fixtures sem associação a obras conhecidas.

**Validações executadas:**

- `npm run lint`, `typecheck`, `test` (751/751, 18 arquivos; eram 563) e `build` com código 0.
- `npm run test:manual` sem a variável: 6 testes *skipped*.
- Modelo real (instância Ollama 0.40.12 isolada na porta 11998, `translategemma:4b`, i5-13420H, `LERIUM_MANUAL_RUNS=3`): **18/18 aprovados**, 201,5 s no total. Avaliação qualitativa e limites (concordância de gênero, pronome oblíquo) na [ADR-011](DECISIONS.md).
- 1ª rodada: `technical-term` falhou porque a fixture exigia preservar "Ascension Array"; o modelo traduziu de forma consistente ("Matriz de Ascensão"), e a fixture passou a exigir consistência.

**Gate da Fase 3 (PLAN.md):**

- [x] `translate(text, options)` produz texto válido: 18/18 execuções reais.
- [x] Nenhum conteúdo perdido por chunk arbitrário: parser (todos os cortes + 200 aleatórios) e provider (64 fatiamentos aleatórios, inclusive no meio de UTF-8).
- [x] Todos os fluxos usam o mesmo cliente: teste de varredura de `src/`.

**Pendências:** ADR-011 só passa a Aceita após confirmar o formato no model card oficial (exige navegação web autorizada); A/B com prompt literário (PLAN.md §9) fica como versão futura; ADR-010 (protocolo SW↔página) na Fase 4; `incomplete_stream` aparece como `network` ("inacessível") na interface, aceitável no MVP.

## Fase 3 — `feat/ollama-chat`

| Commit | Mensagem |
|---|---|
| `50aa5ab` | `feat(core): define contrato do translation provider` |
| `3001d3f` | `refactor(core): generaliza prazo do cliente ollama` |
| `5aa2414` | `feat(core): adiciona chat em streaming ao cliente` |
| `ca4a35c` | `docs(progress): registra chat em streaming do cliente` |
| `078c00c` | `refactor(core): extrai escopo de prazos para módulo próprio` |
| `5e68e6a` | `fix(core): prioriza cancelamento sobre chunk já lido no chat` |
| `6067cc6` | `fix(core): valida prazos e métricas do chat em streaming` |
| `8bc183b` | `fix(core): recusa chunk que não é Uint8Array no chat` |
| `5eb1560` | `test(core): reforça cenários do chat em streaming` |
| (este commit) | `docs(progress): registra correções da revisão do chat` |

**O que foi feito:**
- `src/core/translation-provider.ts`: só tipos (`TranslationProvider`, `TranslationInput`, `TranslateOptions`, `TranslationResult`, `TranslationErrorKind`). O provider nasce com snapshot de endpoint/modelo, nunca lança e, em `ok: false`, o consumidor descarta o que recebeu por `onToken` (sem parcial em erro, RF06).
- `withTimeout` substituído por `createDeadlineScope` interno: fases nomeadas, primeiro motivo vence (`timeout`/`cancelled`/`consumer_error`), sinal externo com listener removido no `dispose`. `listModels`/`showModel` usam uma fase `total` com a mesma semântica; `tests/unit/ollama-client.test.ts` passou sem edição.
- `chatStream(endpoint, request, options)`: `POST /api/chat` com `BASE_INIT`, tokens via `onToken`, parser NDJSON incremental, prazos `first_token` 120 s / `idle` 30 s / `total` 300 s (parciais mesclados com o padrão). Erros só por código: `model_missing` (404), `forbidden`, `http_error`, `network`, `timeout` (+ fase), `cancelled`, `ollama_error` (mensagem descartada), `invalid_response`, `truncated` (`done_reason: length`), `empty_response`, `incomplete_stream`, `consumer_error`. Leitor sempre cancelado e timers sempre limpos ao fim.

**Validações executadas:** `npm run lint`, `typecheck`, `test` e `build` com código 0. Testes: 447 antes da branch → 504 (`tests/unit/ollama-chat-stream.test.ts` novo, com fake timers e `ReadableStream` controlado, e `vi.getTimerCount() === 0` verificado após cada teste; 4 testes de timers em `showModel`). Mutações manuais (remover rearme de `idle`, `reader.cancel`, desarme de `first_token`, encerramento em `done`, `dispose`, "primeiro motivo vence") são todas detectadas pelos testes.

**Decisões em pontos ambíguos:**
- Corpo enviado com `model` já validado (`validateModel`, com trim); idêntico ao `ChatRequest` do `buildChatRequest`.
- Falha de `reader.read()` no meio do corpo (conexão caída) sem motivo do escopo vira `network`.
- `fetch` também entra em `Promise.race` com o abort do escopo, para não depender de um `fetch` que respeite o sinal; exceção síncrona do `fetch` vira `network`.
- Em resposta HTTP de erro o corpo não é lido, só cancelado (libera a conexão).
- Se `onToken` abortar o sinal externo, o resultado é `cancelled`, mesmo que a linha seja `done`.

**Correções da revisão (reviewer + auditoria de testes com 30 mutações manuais):**
- Corrida reproduzida: abort e chunk no mesmo tick devolviam `ok: true` ou chamavam `onToken` após o cancelamento. Agora o motivo do escopo é verificado após cada `await`, antes de cada linha e antes de `onToken`; o abort cancela o leitor por listener, sem `Promise.race` por chunk (elimina também o acúmulo de reações na promise de abort).
- `fetch` que ignora o sinal: o prazo vence mesmo assim, e a `Response` tardia tem o corpo cancelado.
- Pedido que não é objeto ou não serializável → `invalid_request` (o contrato é "nunca rejeita").
- Prazos aceitos só como inteiros entre 1 e 2 147 483 647 ms; fora disso, o padrão da fase. Métricas só como inteiros seguros ≥ 0.
- `ChatStreamErrorKind` sem `not_found` (404 é sempre `model_missing`); `done_reason: length` tem precedência sobre texto vazio.
- Chunk que não é `Uint8Array` → `invalid_response` imediato (antes era ignorado e só o prazo encerrava).
- `createDeadlineScope` extraído para `src/core/deadline-scope.ts`, com testes diretos; `arm`/`fail` após `dispose` não criam timer.
- Testes para os 8 mutantes sobreviventes relevantes (prazos `totalMs`/`firstTokenMs` personalizados, cancelamento do corpo em 403/404/500, modelo normalizado no corpo, `done` não booleano etc.).

**Validações finais:** `npm run lint`, `typecheck`, `test` (563/563, 15 arquivos) e `build` com código 0; `tests/unit/ollama-client.test.ts` sem edição; sem `console`/`chrome` em `src/core`.

**Validação com o modelo real** (instância Ollama 0.40.12 isolada na porta 11998, `translategemma:4b`, i5-13420H, script Node fora do repositório com o cliente empacotado):
- Frio: 1º token em 7,8 s, total 10,7 s (carga 6,1 s), `doneReason: stop`.
- Quente: 1º token em 0,16 s, total 3,0 s, 45 tokens gerados.
- `num_predict: 5` → `truncated`.
- Abort após tokens → `cancelled` em ~0,3 s, com `stop: cancel task` no log do servidor (a geração é interrompida no Ollama).

**Pendências:** `TranslationProvider` concreto sobre `chatStream`, com mapeamento explícito de `incomplete_stream`, `consumer_error` e `invalid_request` para `TranslationErrorKind` e `retryable`; retry conservador; fixtures literárias (branch `test/translation-service`).

## Fase 3 — `feat/literary-prompt` (PR #14, mesclado)

| Commit | Mensagem |
|---|---|
| `6662ba6` | `feat(core): adiciona promptbuilder versionado` |
| `16362b3` | `docs(decisions): propõe adr-011 para o prompt de tradução` |
| `eeb3812` | `docs(decisions): ajusta formatação da adr-011` |

`PROMPT_VERSION = v1-translategemma-baseline`: mensagem `user` única (o template do `translategemma:4b` não tem papel `system`), temperatura 0,2 e `num_predict` proporcional ao texto. ADR-011 em "Proposta" até a validação com fixtures literárias. Validações: lint, typecheck, test (424) e build.

## Fase 3 — `fix/ndjson-parser` (PR #13, mesclado)

| Commit | Mensagem |
|---|---|
| `a542008` | `feat(core): adiciona parser ndjson incremental` |

Parser NDJSON incremental com `TextDecoder` em modo stream, CRLF, linha final sem `\n` e limite de tamanho de linha; testes com todos os pontos de corte e 200 divisões aleatórias com semente fixa. Validações: lint, typecheck, test (421) e build.

## Fase 2 — `chore/ignore-agent-worktrees` (PR #12, mesclado)

| Commit | Mensagem |
|---|---|
| `80e4aeb` | `chore(git): ignora worktrees temporárias de agentes` |

## Fase 2 — `chore/release-0.1.0`

| Commit | Mensagem |
|---|---|
| `65bf52b` | `chore(release): versiona 0.1.0` |
| `6cda38d` | `docs(changelog): registra a versão 0.1.0` |
| (este commit) | `docs(progress): encerra a fase 2 na versão 0.1.0` |

**Validações:** lint, typecheck, test (398/398) e build com código 0; `package.json`, lockfile e manifesto em `0.1.0` (teste de manifesto exige igualdade).

## Fase 2 — `feat/ollama-discovery`

| Commit | Mensagem |
|---|---|
| `eb94bd5` | `docs(decisions): registra adr-007 sobre origem da extensão no ollama` |
| `35df205` | `feat(manifest): fixa id da extensão com chave pública` |
| `ae1b8c3` | `feat(core): adiciona cliente de modelos do ollama com timeout` |
| `175219c` | `feat(options): adiciona mensagens de diagnóstico da conexão` |
| `0287460` | `feat(options): testa conexão e lista modelos instalados` |
| `6d06cc3` | `feat(options): orienta liberação da origem no ollama` |
| `b60e8c7` | `docs(readme): documenta liberação da origem no ollama` |
| `fff968b` | `fix(core): distingue origem recusada de ollama inacessível` |
| `467e353` | `docs(decisions): registra riscos residuais e diagnóstico na adr-007` |
| `3f28e4e` | `fix(options): libera teste de conexão ao editar o endereço` |
| `6b868a7` | `docs(progress): registra descoberta do ollama da fase 2` |

### Correção da conexão no Chrome real (relatada pelo responsável)

| Commit | Mensagem |
|---|---|
| `ceae315` | `docs(decisions): propõe adr-009 para service worker e loopback` |
| `8c945c1` | `fix(core): remove sondagem no-cors do cliente do ollama` |
| `170aff2` | `feat(core): verifica autorização e modelo via api/show` |
| `ed14484` | `feat(shared): define contrato da mensagem de teste de conexão` |
| `bde47a3` | `feat(background): adiciona service worker e roteador de mensagens` |
| `2ec8c8b` | `feat(manifest): registra service worker e acesso ao ollama local` |
| `2fac304` | `fix(options): consulta o ollama pelo service worker` |
| `8001d4a` | `feat(options): revela liberação da origem só em recusa` |
| `3bd8cbe` | `feat(options): pede permissão para porta personalizada` |
| `a133ec3` | `fix(shared): gera padrão de permissão sempre com porta explícita` |
| `cedd3cb` | `test(e2e): adiciona playwright com extensão carregada no chromium` |
| `5cc2ddc` | `test(e2e): cobre cenários do teste de conexão nas opções` |
| `914482d` | `ci: executa testes e2e no chromium` |
| `48657e6` | `docs: aceita adr-009 e atualiza arquitetura e readme` |
| `5df2e65` | `docs(progress): registra correção da conexão com o ollama` |
| (este commit) | `docs(progress): remove commit duplicado na tabela` |

**Sintomas no Chrome:** `No 'Access-Control-Allow-Origin' header`; `Request mode is "no-cors" but the redirect mode is not "follow"`; falha em `/api/tags`; foco não ia para "Liberar o Lerium no Ollama".

**Causas raiz (com evidência):**
1. A sondagem `mode: 'no-cors'` usava `redirect: 'error'`, combinação proibida pelo Chrome → `TypeError` imediato → todo erro virava `network` → o código de foco (só em `forbidden`) nunca rodava.
2. Sem `host_permissions`, o 403 do Ollama (sem cabeçalhos CORS) chega ao `fetch` como `TypeError: Failed to fetch`, indistinguível de porta fechada (medido no Chromium 156).
3. No teste do responsável, o Ollama em execução não tinha lido `OLLAMA_ORIGINS` (variável correta, mas processo não reiniciado). No momento da investigação, o Ollama estava fechado.
4. Descoberto no experimento: com `host_permissions`, o Chrome **não envia `Origin` em GET** e envia em POST. Um teste só com `GET /api/tags` diria "conectado" sem a liberação, e a tradução (POST) falharia depois.

**Correção (ADR-009, aceita):** service worker como cliente HTTP único; `host_permissions` só `localhost:11434`/`127.0.0.1:11434`; portas personalizadas via permissão opcional com **porta explícita** (padrão sem porta cobriria todas — verificado); teste de conexão = `GET /api/tags` + `POST /api/show` (envia `Origin`, verifica autorização e modelo); sondagem `no-cors` removida; seção de liberação oculta por padrão, revelada só em 403, com rolagem suave (respeita *reduced motion*) e foco no título apenas quando iniciado pelo usuário.

**Validação no navegador real:** Chromium 156 com `dist/` e Ollama 0.40.12 real na porta 11434 (instâncias temporárias com `OLLAMA_ORIGINS` explícito no processo; a variável da conta não foi alterada), endpoint `http://localhost:11434`: (1) sem liberação → mensagem de HTTP 403, seção visível, foco no título; (2) liberado → "Conectado. 4 modelo(s)", `translategemma:4b` listado; (3) modelo inexistente → aviso de `ollama pull`; (4) Ollama desligado → mensagem de inacessível, seção oculta. Nenhuma mensagem de console sobre `no-cors`, ACAO ou redirect. E2E (mock): 8/8. Unit: 398/398. Revisões: reviewer (aprovado com ressalvas) e security (sem bloqueantes).

**Pendências registradas:** E2E do pedido de permissão para porta personalizada (hoje só unitário; diálogo do Chrome exige teste manual); `retries: 1` no CI pode mascarar instabilidade; negar a permissão impede salvar porta personalizada (decisão de UX); sem fluxo para revogar portas concedidas; o ID mudará na publicação (rever `OLLAMA_ORIGINS`); revisão da CWS avaliará as permissões de loopback; validação no **Chrome estável** do responsável ainda pendente.

**ID fixo da extensão:** `mjkoppimccgajnabfeheglepjapkchlk` (`npm run extension-id`; conferido de forma independente em Python). Chave privada descartada; nenhuma chave privada no repositório.

**Validações executadas:** `npm run lint`, `typecheck`, `test` (232/232) e `build` com código 0; sem `innerHTML`, `eval` ou `console` em `src/`; manifesto com `permissions: ["storage"]`, sem `host_permissions`. Revisões: reviewer (aprovado com ressalvas) e security (ressalvas, nada bloqueante) — tratadas em `fff968b`, `467e353` e `3f28e4e`.

**Decisões:**
- ADR-007: `OLLAMA_ORIGINS` com o ID exato; sem curinga, sem remoção de `Origin`, sem `host_permissions`.
- Sem `host_permissions`, o 403 do Ollama chega ao `fetch` como erro de rede (CORS). O cliente faz uma sondagem `no-cors`: servidor alcançável → `forbidden`; inalcançável → `network`.
- Página de opções testa o endereço salvo ao abrir (só loopback, sem dados da página) e o digitado ao clicar; o campo de texto do modelo segue como valor salvo, com `<select>` auxiliar.

**Gate da Fase 2:** aprovado pelo responsável no Chrome estável após reiniciar o Ollama: conexão estabelecida, `translategemma:4b` listado, Ollama fechado com mensagem de inacessível.

## Fase 2 — `feat/settings-storage`

| Commit | Mensagem |
|---|---|
| `590f75c` | `docs(decisions): registra adr-008 de configurações locais por usuário` |
| `6f1be21` | `feat(core): define TranslationSettings e valores padrão` |
| `35054dc` | `feat(shared): valida endpoint loopback, modelo e idiomas` |
| `b146e80` | `feat(storage): adiciona repositório com mescla de padrões na leitura` |
| `565a140` | `feat(manifest): solicita permissão storage` |
| `aec40e6` | `feat(options): traduz códigos de validação em mensagens pt-br` |
| `81f75d2` | `feat(options): adiciona formulário de configurações persistentes` |
| `93a8f04` | `fix(shared): reporta porta fora do intervalo e exige endereço ascii` |
| `eb3f2d5` | `fix(shared): restringe nome do modelo a caracteres permitidos` |
| `7804035` | `fix(storage): recusa idioma de origem igual ao de destino` |
| `0727988` | `test(storage): cobre protótipo e endpoint malicioso armazenados` |
| `f8f3dec` | `docs(decisions): registra limitação de schemaVersion na adr-008` |
| `715ede4` | `fix(options): preserva foco ao salvar e bloqueia ações até carregar` |
| (este commit) | `docs(progress): registra configurações persistentes da fase 2` |

**Evidência que orientou a fase (máquina do responsável, Ollama 0.40.12, `OLLAMA_ORIGINS` indefinido):** `GET /api/tags` sem `Origin` → 200; com `Origin: chrome-extension://…` → 403; site → 403; preflight → 403. Em instância temporária isolada (porta 11999) com `OLLAMA_ORIGINS=chrome-extension://<ID>`: ID liberado → 200, outra extensão → 403, site → 403, preflight `POST /api/chat` → 204 restrito ao ID. Decisão de origem será registrada como ADR-007 em `feat/ollama-discovery`.

**Validações executadas:** `npm run lint`, `typecheck`, `test` (178/178) e `build` com código 0; sem `innerHTML`, `eval` ou `console` em `src/`; manifesto com `permissions: ["storage"]` apenas. Revisões: reviewer (aprovado com ressalvas) e security (ressalvas, risco baixo) — todas as ressalvas tratadas em commits próprios.

**Decisões:**
- ADR-008: `chrome.storage.local`, configuração global por perfil, padrões mesclados na leitura, gravação só ao salvar (sem `onInstalled` nem service worker nesta fase).
- Branch `fix/default-migration` do plano absorvida: o modelo de leitura não destrutiva evita o problema por construção, e os testes ("atualização simulada não grava", storage parcial/inválido) estão nesta branch.
- Endpoint: apenas `http` em `localhost`/`127.0.0.1`, porta configurável, ASCII visível, sem credenciais/caminho/query/hash; valor gravado é sempre `url.origin`.
- Modelo: allowlist `A-Z a-z 0-9 . _ : / -`, sem `..`; origem ≠ destino.
- Paralelismo, modo e domínios excluídos ficam para as fases que implementam esses comportamentos.

**Teste manual (responsável):** aprovado — persistência após recarregar a extensão; erros de endereço e de idiomas iguais exibidos nos campos.

## Fase 1 — `feat/popup-shell`

| Commit | Mensagem |
|---|---|
| `551b74d` | `feat(options): cria página de configurações vazia e navegável` |
| `8de3bfc` | `feat(popup): cria popup em pt-br com acesso às configurações` |
| `81376f6` | `docs(readme): documenta instalação via load unpacked` |
| `a1f0549` | `fix(popup): separa aviso fixo da região de feedback de erro` |
| `64c0473` | `fix(popup): delimita o botão no tema escuro com borda contrastante` |
| (este commit) | `docs(progress): registra popup e opções da fase 1` |

**Validações executadas:** `npm run lint`, `typecheck`, `test` (10/10) e `build` com código 0; `dist/` contém popup, opções, assets e ícones; sem `innerHTML`, `eval`, script ou estilo inline. Contrastes (WCAG 2.2 AA): texto 14,68:1 (claro) e 16,12:1 (escuro); rótulo do botão 6,29:1; foco 6,29:1 / 8,90:1; borda do botão no tema escuro 8,9:1. Revisão do reviewer: aprovado com ressalvas, todas tratadas.

**Decisões:**
- `options_ui` com `open_in_tab: true`, aberto por `chrome.runtime.openOptionsPage()` (não exige permissão); `permissions` segue vazio.
- Popup fecha com `window.close()` após abrir as opções; em erro, mensagem genérica em PT-BR numa região `role="status"` própria, sem log.
- Sugestão de clarear o botão para `#6366f1` no tema escuro recusada: o rótulo branco cairia para 4,47:1 (< 4,5:1). Adotada borda `#a5b4fc`.

**Teste manual (responsável):** aprovado — popup por teclado, aba de opções abre, tema escuro conferido.

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

**Teste manual (responsável, após o merge do #6):** *Load unpacked* de `dist/` no Chrome sem erros; ícone e popup exibidos corretamente.

**Observação:** nos commits `339463f`–`ca9dea8` o typecheck falha com TS18003 (ainda sem arquivos `.ts`), documentado no corpo de `339463f`.

## Fase 1 — `chore/claude-config`

| Commit | Mensagem |
|---|---|
| `dbc3680` | `chore(claude): versiona configuração do claude code no projeto` |
| `6702f6c` | `chore(claude): adiciona skills do ECC com aviso de licença MIT` |

Skills derivadas de https://github.com/affaan-m/ECC (MIT, licença verificada via API do GitHub); aviso de copyright em `.claude/skills/LICENSE`.

## Fase 1 — `ci/quality-gates`

| Commit | Mensagem |
|---|---|
| `5bcb92c` | `ci: executa lint, typecheck, testes e build no pull request` |
| `1ec8841` | `docs(ci): adiciona template de pull request` |
| (este commit) | `docs(progress): registra ci e teste manual da fase 1` |

**Validação:** primeira execução do workflow no PR #7 passou (run `40755828921`, 16 s; Node 24.22.1 no runner, `npm ci` sem avisos). Workflow com `permissions: contents: read` e `persist-credentials: false`. Actions fixadas por tag major (`@v7`); fixar por SHA fica como melhoria futura.

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

Fase 4 — `feat/dom-collection`: coleta de texto com `TreeWalker` e regras de exclusão, com a fixture própria `tests/fixtures/novel-chapter.html`.
