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

## ADR-007 — Origem da extensão no Ollama

**Status:** Aceita (28/10/2026)

**Contexto.** RF01 e RF06 exigem que as páginas da extensão consultem o
Ollama local (`GET /api/tags`, depois `POST /api/chat`). O Ollama valida o
cabeçalho `Origin` contra uma lista de origens permitidas. Evidência medida na
máquina do responsável (Ollama 0.40.12, `OLLAMA_ORIGINS` indefinido):

- sem `Origin` → 200;
- `Origin: chrome-extension://…` → 403;
- `Origin` de um site → 403;
- preflight (`OPTIONS`) → 403.

Em instância temporária isolada, com `OLLAMA_ORIGINS=chrome-extension://<ID>`:

- `Origin` com o ID liberado → 200;
- outra extensão → 403;
- site → 403;
- preflight de `POST /api/chat` → 204, com `Access-Control-Allow-Origin`
  restrito ao ID liberado.

Ou seja, o padrão do Ollama recusa a extensão, e liberar apenas o ID do
Lerium é suficiente e não abre acesso a sites nem a outras extensões.

**Decisão.**

- O usuário define `OLLAMA_ORIGINS=chrome-extension://<ID do Lerium>`. Se a
  variável já tiver valores, o ID é **acrescentado** a eles, separado por
  vírgula, sem remover origens existentes.
- O ID é estável via campo `key` (chave pública) no manifesto. A chave
  privada correspondente é descartada: não é necessária para carregar a
  extensão sem empacotamento (unpacked). Empacotar como `.crx` ou publicar na
  Chrome Web Store exigirá nova ADR; a CWS atribui ID próprio.
- Sem `host_permissions` enquanto o teste no Chrome real não demonstrar
  necessidade.

**Alternativas rejeitadas.**

- `OLLAMA_ORIGINS=chrome-extension://*`: qualquer extensão instalada poderia
  ler prompts e chamar endpoints destrutivos (`/api/delete`, `/api/pull`).
- Remover o `Origin` via `declarativeNetRequest`: desliga a proteção do
  Ollama contra sites, o escopo da regra não foi comprovado e a permissão
  pesa na revisão da CWS.
- Native messaging ou proxy local: contraria a premissa "sem backend"
  (PLAN.md §0 e RF07).

**Consequências.** A configuração passa a ter um passo manual (definir a
variável e reiniciar o Ollama), que a página de opções deve explicar quando a
conexão for recusada. O ID muda se a `key` mudar; um teste fixa o ID
esperado para detectar troca acidental. Validações pendentes no Chrome real:
se o `Origin` é enviado em requisições `GET` das páginas da extensão e se o
CORS funciona sem `host_permissions`.

## ADR-008 — Configurações locais por usuário

**Status:** Aceita (28/10/2026)

> Nota: o número 007 está reservado para a ADR sobre a origem das requisições
> ao Ollama, que será registrada na branch `feat/ollama-discovery`.

**Contexto.** RF01 exige persistir endpoint, modelo e idiomas, mantendo os
valores após recarregar ou atualizar a extensão. A referência grava padrões
com `storage.sync.set` em `onInstalled` sem checar dados existentes e pode
apagar preferências em atualizações ([PLAN.md §2.2](PLAN.md), item 13). O
endpoint aponta para o Ollama da própria máquina, e sincronização em nuvem
está fora do escopo do MVP ([PLAN.md §1](PLAN.md)).

**Decisão.**

- Área: `chrome.storage.local`. O endpoint pertence à máquina, não à conta;
  `storage.sync` levaria a configuração a outros computadores.
- Escopo: configurações globais por perfil do Chrome, sem sobrescrita por
  aba. Estado por aba é assunto de job/sessão (ADR-004).
- Padrões mesclados **na leitura**; gravação só quando o usuário salva. Isso
  dispensa `onInstalled` e service worker nesta fase.
- Chave única `settings`, com `schemaVersion: 1`, para permitir migrações
  futuras não destrutivas.
- Campo armazenado inválido cai no padrão apenas em memória e **nunca** é
  regravado automaticamente.
- Na gravação, chaves desconhecidas existentes dentro de `settings` são
  preservadas (compatibilidade com versões futuras ou anteriores).

**Consequências.** O manifesto passa a pedir a permissão `storage`.
Atualizações da extensão não alteram o armazenamento; novos campos ganham
padrão automaticamente na leitura. Um valor inválido persiste no storage até
o usuário salvar novamente; a interface deve mostrar o valor efetivo. Uma
mudança futura de formato exige migração explícita guiada por
`schemaVersion`.

Limitação conhecida: esta versão sempre grava `schemaVersion: 1`. Se o
usuário fizer downgrade depois de uma versão futura ter gravado um schema
maior, salvar aqui rebaixaria o número para 1 mantendo as chaves
desconhecidas do schema novo. A migração entre versões (incluindo esse caso)
será tratada quando existir o schema 2.
