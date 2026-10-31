# Arquitetura — Lerium

Documento de limites de responsabilidade do Lerium. Resume e referencia a
proposta de [PLAN.md §4](PLAN.md); requisitos detalhados estão em
[PLAN.md §3](PLAN.md) e em [SCOPE.md](SCOPE.md). Decisões formais ficam em
[DECISIONS.md](DECISIONS.md).

## Visão geral

```mermaid
flowchart TD
    A[Usuário inicia a tradução] --> B[Popup ou menu de contexto]
    B --> C[Content script coleta segmentos]
    C --> D[Scheduler ordena por visibilidade]
    D --> E[Service worker valida job e configuração]
    E --> F[Cliente Ollama local em loopback]
    F --> G[Parser NDJSON incremental]
    G --> H[Resultado por segmento]
    H --> I[Content script aplica texto com segurança]
    I --> J[Progresso exibido e original preservado]
```

O usuário aciona a tradução pelo popup ou pelo menu de contexto. O content
script coleta os segmentos elegíveis da página e os entrega a uma fila
priorizada (conteúdo principal visível primeiro). O service worker valida o
job e a configuração e chama o Ollama local, cuja resposta em streaming é
lida por um parser NDJSON robusto. Cada segmento concluído volta ao content
script, que aplica o texto sem `innerHTML`, atualiza o progresso e mantém o
original para restauração imediata. Toda inferência ocorre na máquina do
usuário; não há backend próprio.

## Módulos e responsabilidades

| Módulo | Faz | Não pode fazer |
|---|---|---|
| `content` | Acessa o DOM, coleta e segmenta texto, aplica traduções, guarda e restaura o original, observa visibilidade/mutações, exibe overlay de progresso e mantém a máquina de estados por documento. A coleta (`dom-collector.ts`, `collectTextNodes`) devolve os nós `Text` elegíveis em ordem de documento, com as exclusões da ADR-012. | Chamar a API do Ollama diretamente; inserir saída do modelo via `innerHTML`; executar scripts ou instruções vindas da página. |
| `background` (service worker) | Roteia mensagens, valida jobs e configuração, chama o cliente Ollama, propaga cancelamentos (`AbortController`) e registra menus de contexto. | Usar variáveis globais como fonte de verdade de estado (o worker MV3 pode ser suspenso a qualquer momento); acessar o DOM das páginas; sobrescrever configurações em `onInstalled`. |
| `core` | Tipos/contratos, `PromptBuilder` versionado, contrato `TranslationProvider` e seu adaptador sobre o `OllamaClient` (`createOllamaTranslationProvider`), escopo de prazos, parser NDJSON e, na Fase 5, o scheduler. | Depender de DOM ou de APIs do Chrome; manter estado de UI. Deve ser testável em isolamento. |
| `popup` / `options` | Apresentação, comandos do usuário e validação de entrada em PT-BR. | Conter lógica de tradução, prompt ou `fetch` próprios (todas as entradas usam o mesmo motor); precisar permanecer aberto para a tradução concluir. |
| `storage` | Preferências em `chrome.storage.local` com defaults e migrações não destrutivas; estado mínimo de sessão em `chrome.storage.session`. | Persistir conteúdo traduzido ou original das páginas por padrão; apagar preferências existentes em atualizações. |

## Contratos

Tipos compartilhados previstos (definidos em código a partir das Fases 2 e 3):

- `TranslationSettings` — preferências do usuário: endpoint local, modelo, idiomas, paralelismo, modo e domínios excluídos.
- `TranslationSegment` — bloco de texto segmentado do DOM (`src/content/segmenter.ts`, ADR-013): id ordinal `seg-N`, elemento de bloco, nós `Text` e texto normalizado. Guarda referências do DOM e **nunca atravessa mensagens**: do content script só sai `{ segmentId, text }`. Blocos com markup inline de um nível vão ao modelo com marcadores `<gN>` (`src/core/inline-markers.ts`, ADR-003); os demais, como texto puro ou nó a nó. A aplicação e a restauração (`src/content/page-applier.ts`, ADR-014) escrevem só por `node.data`, de forma atômica por segmento, e só restauram nós que ainda têm o texto aplicado. O content script fala com o service worker por uma Port por job (ADR-010): envia uma unidade por vez (`job:unit`) e recebe `job:result`; endpoint, modelo e idiomas ficam no service worker. O content script (`content.js`, IIFE) é injetado sob demanda: o popup pede `page:inject` ao service worker, que injeta com `chrome.scripting.executeScript` e registra o `documentId`; o popup então comanda a página com `page:command` (ADR-002).
- `TranslationRequest` — pedido de tradução de um segmento dentro de um job, com idiomas e versão de prompt.
- `TranslationResult` — texto traduzido de um segmento, associado ao job e ao segmento de origem.
- `TranslationProgress` — contagem de segmentos concluídos, pendentes e com falha para a UI.
- `TranslationJob` — trabalho de tradução isolado por aba, documento e identificador do job.
- `TranslationError` — erro classificado (conexão, modelo ausente, HTTP, timeout, cancelamento, validação), transitório ou definitivo.
- `MessageRequest` — mensagem enviada entre popup, content script e service worker.
- `MessageResponse` — resposta tipada a uma `MessageRequest`, com sucesso ou `TranslationError`.

Tipos de compilação não bastam: toda mensagem recebida (e toda resposta do
Ollama) passa por validação em runtime antes de ser usada.

## Motor de tradução (Fase 3)

Implementado em `src/core`, sem DOM e sem `chrome` (testável no Node):

```text
TranslationProvider.translate(input, { signal, onToken })
  -> buildChatRequest (PromptBuilder, ADR-011)
  -> chatStream (POST /api/chat, parser NDJSON, prazos)
  -> TranslationResult { ok, text | error, retryable }
```

- **Contrato** (`translation-provider.ts`): `translate` nunca lança; em erro não há texto parcial, e o consumidor descarta o que recebeu por `onToken` (RF06: o original é preservado). Cada provider nasce com um snapshot de endpoint e modelo.
- **Prazos** (`deadline-scope.ts`): `total` 300 s (nunca reinicia), `first_token` 120 s (cobre a carga do modelo) e `idle` 30 s entre trechos (só após o primeiro). O primeiro motivo de parada vence: prazo, cancelamento ou erro do consumidor.
- **Cliente único:** só `ollama-translation-provider.ts` usa `chatStream`, e `fetch` só é chamado em `background/index.ts`; um teste varre `src/` para garantir isso (Gate da Fase 3).

**Erros do provider** (`retryable` = a fila ou o usuário podem repetir a mesma chamada):

| Origem | `TranslationErrorKind` | `retryable` |
|---|---|---|
| endpoint, modelo ou idiomas inválidos | `invalid_config` | não |
| texto vazio ou entrada/opções inválidas | `invalid_input` | não |
| Ollama inacessível, stream interrompido | `network` | sim |
| prazo estourado (qualquer fase) | `timeout` | sim |
| HTTP 429 ou 5xx | `http_error` | sim |
| outro HTTP 4xx | `http_error` | não |
| HTTP 403 (origem recusada) | `forbidden` | não |
| HTTP 404 (modelo ausente) | `model_missing` | não |
| `{ error }` no stream | `provider_error` | não |
| resposta malformada | `invalid_response` | não |
| `done_reason: length` | `truncated` | não |
| resposta vazia | `empty_response` | não |
| cancelado | `cancelled` | não |
| `onToken` lançou | `consumer_error` | não |
| falha inesperada do Lerium | `internal_error` | não |

**Nova tentativa automática:** no máximo uma, após 500 ms canceláveis, só para `network`, stream interrompido e HTTP 429/5xx, e só se nenhum trecho foi entregue a `onToken` e o sinal não foi abortado. `timeout` não tem nova tentativa interna (dobraria uma espera de até 120 s); fica para a fila (Fase 5) ou o usuário.

## Estados de tradução

Estados explícitos por documento (RF04, [PLAN.md §3](PLAN.md)):

- `idle` — nada em andamento; página no original.
- `loading` — preparando o job: verificando configuração e conexão, coletando segmentos.
- `translating` — segmentos sendo traduzidos e aplicados progressivamente.
- `translated` — todos os segmentos elegíveis concluídos; alternância com o original disponível.
- `cancelled` — usuário parou; novas requisições bloqueadas, as em andamento abortadas e original restaurado.
- `error` — falha que impede continuar; original preservado e opção de tentar novamente.

**Invalidação:** cada resultado carrega o identificador do job que o gerou.
Cancelamento, desligamento, recarga ou navegação (inclusive em SPA) encerram
o job atual; qualquer resultado que chegue depois com identificador antigo é
descartado e nunca aplicado ao DOM. Uma aba não interfere em outra.

## Limites de confiança e privacidade

- **Página é dado não confiável:** o texto coletado é apenas conteúdo a traduzir, nunca instrução para a extensão; o prompt separa instrução e texto com delimitação explícita.
- **Rede só no service worker:** popup, opções e content scripts não fazem `fetch`; enviam mensagens tipadas e validadas ao service worker, que aceita apenas remetentes da própria extensão (ADR-009).
- **Somente loopback:** o endpoint aceita apenas `http://localhost` ou `http://127.0.0.1` no MVP; endpoint remoto fica desabilitado.
- **DOM seguro:** traduções são inseridas via `textContent`/`nodeValue`; nenhuma URL ou HTML é criado a partir da resposta do modelo.
- **Sem logs de conteúdo:** logs registram só metadados (duração, quantidade de segmentos, códigos de erro).
- **Sem terceiros:** sem backend, telemetria, analytics ou upload de texto.
- **Menor privilégio:** sem `<all_urls>` indiscriminado; injeção sob demanda; cada permissão do manifesto justificada (ver [PLAN.md §8](PLAN.md)).

## Estrutura de diretórios

A árvore alvo é a proposta de [PLAN.md §4](PLAN.md) (`public/`,
`src/{background,content,core,popup,options,storage,shared}`,
`tests/{unit,integration,e2e,fixtures,mocks}`, `docs/`). Ela é uma
referência, não uma obrigação: pode ser adaptada se o build MV3 exigir,
mantendo a separação de responsabilidades acima.

A estrutura será criada **incrementalmente a partir da Fase 1**, apenas
quando houver código ou teste real para cada pasta. Não criar pastas vazias
para simular arquitetura.

## Decisões em aberto

Ainda não resolvidas; não tratar como definidas até haver ADR aceita em
[DECISIONS.md](DECISIONS.md) (ver também "Questões em aberto" em
[SCOPE.md](SCOPE.md)):

- **Injeção e permissões** — `activeTab` + `scripting` após ação do usuário vs. permissões opcionais por domínio para tradução automática persistente (ADR-002).
- **DOM com markup inline** — tradução por nó, por bloco com marcadores ou outra estratégia que não esvazie nós inline (ADR-003).
- **Identidade de documento/job e reidratação do service worker** — qual identificador comprovado usar (`documentId`, identificador de navegação ou equivalente) e como recuperar estado após suspensão do worker (ADR-004).
- **UX da tradução de seleção** — balão na página vs. resultado no popup, e comportamento quando o popup fecha (ADR-005).
- **CORS do Ollama** — validar se as requisições da extensão exigem configurar `OLLAMA_ORIGINS`; se exigirem, restringir à origem da extensão, nunca `*`.
