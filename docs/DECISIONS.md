# Decisões de arquitetura — Lerium

Registro de decisões no formato ADR (Architecture Decision Record). Cada ADR
contém **Contexto**, **Decisão** e **Consequências**, com um **Status**:

- **Proposta** — em discussão; opções levantadas, sem decisão.
- **Aceita** — decisão vigente.
- **Substituída** — superada por outra ADR (indicar qual).

Regra: uma ADR aceita não é editada para mudar a decisão. Para alterá-la,
crie uma nova ADR e marque a anterior como **Substituída por ADR-XXX**.
Contexto completo em [PLAN.md](PLAN.md), [SCOPE.md](SCOPE.md) e
[ARCHITECTURE.md](ARCHITECTURE.md).

## ADR-001 — Manifest V3 + TypeScript strict + Ollama local

**Status:** Aceita (28/10/2026)

**Contexto.** O Lerium traduz páginas de novels no Chrome com qualidade
literária, sem custo e sem enviar texto a terceiros. O usuário já executa o
Ollama localmente. A extensão de referência analisada
([PLAN.md §2.2](PLAN.md)) mostrou riscos de estado efêmero, permissões amplas
e clientes de API duplicados.

**Decisão.**

- Plataforma: Chrome Extension **Manifest V3**.
- Linguagem: **TypeScript** em modo `strict`.
- Build: **Vite**, configurado para bundle MV3.
- Inferência **apenas via Ollama local** em loopback (`localhost`/`127.0.0.1`); sem backend próprio e sem serviço em nuvem.
- Adaptador `TranslationProvider` para permitir troca futura de runtime, mas **somente Ollama é implementado no MVP**.

**Consequências.**

- O service worker MV3 pode ser suspenso a qualquer momento: estado não pode depender de variáveis globais; requisições longas e reidratação precisam ser testadas (ver ADR-004).
- A necessidade de CORS (`OLLAMA_ORIGINS`) para chamadas da extensão ainda precisa ser validada; se necessária, será restrita à origem da extensão.
- O desempenho depende do hardware e do modelo do usuário; nenhum SLA é fixado sem medição real.
- Ferramentas previstas para a Fase 1: Vitest (unit/DOM), Playwright + Chromium (E2E), ESLint, Prettier e `tsc --noEmit`.

## ADR-002 — Política de injeção e permissões

**Status:** Proposta

**Contexto.** A referência usa `<all_urls>` em `host_permissions` e
`content_scripts`. O Lerium deve seguir menor privilégio
([PLAN.md §8](PLAN.md)), mas tradução automática ao navegar exige acesso
persistente a sites.

**Opções.**

1. `activeTab` + `chrome.scripting` com injeção sob demanda após ação do usuário (popup/menu).
2. Opção 1 como padrão + permissões opcionais solicitadas por domínio quando o usuário ativar tradução automática nele.
3. Content script declarado apenas para domínios específicos.

**Quando decidir.** Na Fase 1 (manifesto mínimo), com revisão na Fase 7
(domínios excluídos e permissões opcionais).

## ADR-003 — Estratégia de DOM para markup inline

**Status:** Proposta

**Contexto.** A referência insere toda a tradução no primeiro nó de texto e
esvazia os seguintes, quebrando `<em>`, `<strong>` e `<a>`
([PLAN.md §2.2](PLAN.md), nº 6). O modelo traduz melhor com o parágrafo
inteiro, mas a resposta nunca pode ser inserida como HTML.

**Opções.**

1. Tradução por nó de texto (preserva estrutura, perde contexto da frase).
2. Tradução por bloco com marcadores para nós inline, validados e mapeados de volta via `nodeValue`.
3. Híbrida: bloco quando não há markup inline; marcadores ou nó a nó quando há, com fallback seguro.

Em qualquer opção: nunca esvaziar nós inline silenciosamente.

**Quando decidir.** Na Fase 4, após testes com a fixture
`tests/fixtures/novel-chapter.html` (ver [TEST_PLAN.md](TEST_PLAN.md)).

## ADR-004 — Identidade de job/documento e estado de sessão

**Status:** Proposta

**Contexto.** Jobs precisam ser isolados por aba e documento para que
cancelamentos e navegações invalidem resultados antigos (RF04). O service
worker MV3 pode reiniciar no meio de uma tradução.

**Opções.**

1. `tabId` + `documentId` do Chrome + `jobId` gerado.
2. `tabId` + identificador de navegação gerado pelo content script + `jobId`.
3. Fonte de verdade no content script; `chrome.storage.session` apenas para o mínimo necessário à reidratação do worker (combinável com 1 ou 2).

**Quando decidir.** Nas Fases 3/4, após experimento de suspensão do worker e
requisições longas; revisar na Fase 7 (SPA).

## ADR-005 — UX da tradução de seleção

**Status:** Proposta

**Contexto.** RF02 exige traduzir a seleção pelo popup e pelo menu de
contexto sem perder a seleção. O popup fecha ao perder o foco, o que pode
interromper a exibição do resultado.

**Opções.**

1. Resultado exibido no popup (exige popup aberto até concluir).
2. Balão/overlay na página, próximo à seleção, independente do popup.
3. Balão para o menu de contexto e resultado no popup quando acionado por ele.

**Quando decidir.** Na Fase 6, antes de implementar seleção e menus de
contexto.

## ADR-006 — Licença do Lerium

**Status:** Aceita (28/10/2026)

**Contexto.** O repositório é público e não tinha licença, o que na prática
significa "todos os direitos reservados". A escolha afeta uso, distribuição e
contribuições, e precisava ser feita antes do primeiro commit de código.

**Decisão.** Lerium é distribuído sob a licença MIT (arquivo `LICENSE` na raiz).

**Consequências.** Terceiros podem usar, modificar e redistribuir o código
mantendo o aviso de copyright. Dependências futuras devem ter licenças
compatíveis (PLAN.md §8, item 9). O `package.json` da Fase 1 deve declarar
`"license": "MIT"`. Esta decisão **não** altera a situação da licença da
extensão de referência, que continua não confirmada (SCOPE.md).
