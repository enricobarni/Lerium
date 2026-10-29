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

Nota: as permissões de loopback da ADR-009 (`localhost`/`127.0.0.1`) são
de acesso à API local do Ollama, não de injeção em sites; não decidem esta
ADR.

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

Parcialmente substituída pela ADR-009 (host_permissions e diagnóstico; a sondagem no-cors foi removida).

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

Riscos residuais e diagnóstico:

- **A `key` é pública.** Qualquer extensão descompactada carregada com a
  mesma `key` herda o ID do Lerium e teria acesso total ao Ollama liberado.
  Mitigações: carregar o Lerium apenas a partir deste repositório; remover a
  origem de `OLLAMA_ORIGINS` ao desinstalar; o ID mudará na publicação
  (tratado em ADR futura).
- **A liberação vale para a API inteira.** O Ollama não restringe origens por
  rota; liberar a origem concede ao Lerium todos os endpoints, embora o
  código só use `/api/tags` e `/api/chat`.
- **O 403 é invisível ao `fetch`.** Sem `host_permissions`, a página está
  sujeita a CORS: o 403 para origem não liberada vem sem
  `Access-Control-Allow-Origin` e o `fetch` rejeita como erro de rede, igual
  a um Ollama desligado. Para distinguir os casos, o cliente faz, após o erro
  de rede, uma sondagem `GET` com `mode: 'no-cors'` dentro do mesmo prazo: se
  ela resolver (resposta opaca, corpo não lido), o servidor está alcançável
  e recusou a origem; se falhar, está inacessível. Não exige permissão
  adicional.

## ADR-008 — Configurações locais por usuário

**Status:** Aceita (28/10/2026)

> Nota: o número 007 foi reservado para a ADR sobre a origem das requisições
> ao Ollama, registrada acima como ADR-007.

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

## ADR-009 — Service worker como cliente HTTP e acesso ao Ollama em loopback

**Status:** Aceita (29/10/2026)

**Validação.** Chromium 156 (Playwright) com `dist/` carregado e Ollama 0.40.12 real na porta 11434, endpoint `http://localhost:11434`: sem `OLLAMA_ORIGINS` → mensagem de HTTP 403, seção de liberação revelada e foco no título; com o ID liberado → conectado e 4 modelos listados; modelo inexistente → aviso de `ollama pull`; Ollama desligado → mensagem de inacessível. Nenhum erro de console sobre `no-cors`, `Access-Control-Allow-Origin` ou modo de redirecionamento. O ID carregado é o fixo. Cenários também cobertos por E2E com mock (`tests/e2e`). Padrões de permissão usam porta explícita: `http://127.0.0.1:80/*` concede só a porta 80, enquanto `http://127.0.0.1/*` concederia todas (verificado com `chrome.permissions.contains`).

**Contexto.** A sondagem `no-cors` da ADR-007 não funciona: no Chrome, um
`fetch` com `mode: 'no-cors'` e `redirect: 'error'` é combinação proibida e
rejeita na hora com `TypeError`. Todo erro virava `network`, a mensagem de
origem recusada nunca aparecia e o foco nunca ia para a seção de instruções.
Evidência medida no Chromium 156 (Playwright), com uma extensão de teste:

- **Sem `host_permissions`**, um servidor que responde 403 sem CORS gera
  `TypeError: Failed to fetch`, indistinguível de porta fechada, tanto no
  service worker quanto na página da extensão.
- **Com `host_permissions`**, o status 403 fica legível. O padrão
  `http://127.0.0.1/*` (sem porta) cobre todas as portas.
- Com `host_permissions`, o Chrome **não envia** `Origin` em `GET` (o servidor
  viu o cabeçalho ausente) e **envia** `Origin: chrome-extension://<ID>` em
  `POST`, no service worker e na página.
- Sem `host_permissions`, o Chrome envia `Origin` em `GET` e faz preflight
  `OPTIONS` antes de um `POST` JSON.

No Ollama 0.40.12, em instância isolada:

- sem `OLLAMA_ORIGINS`, `POST /api/show` com o `Origin` do Lerium → 403;
- com o ID liberado → 200;
- modelo inexistente → 404 `{"error":"model '...' not found"}`;
- `qwen` sem tag → 200;
- `GET /api/tags` sem `Origin` → 200, mesmo sem liberação.

Conclusão: com `host_permissions`, `GET /api/tags` não prova que a origem
está liberada. Só um `POST`, que leva o `Origin`, revela a recusa.

**Decisão.**

- O **service worker é o único cliente HTTP** do Ollama. Opções, popup e
  content scripts enviam mensagens tipadas e validadas; o worker valida
  remetente, endpoint e modelo antes de qualquer `fetch`.
- `host_permissions`: exatamente `http://localhost:11434/*` e
  `http://127.0.0.1:11434/*` (porta padrão).
- `optional_host_permissions`: `http://localhost/*` e `http://127.0.0.1/*`.
  A página de opções as solicita no gesto do usuário, apenas para a origem
  exata de uma porta personalizada (ex.: `http://localhost:8080/*`).
- Teste de conexão = `GET /api/tags` (alcance e lista de modelos) +
  `POST /api/show` (somente leitura; envia `Origin`, prova a liberação e
  verifica se o modelo configurado existe). O corpo de `/api/show` não é
  lido nem repassado (modelfile, licença).
- Sem `mode: 'no-cors'` em nenhum lugar.
- O `Origin` continua sendo enviado no `POST`: as permissões de host **não**
  contornam a proteção do Ollama. `OLLAMA_ORIGINS` com o ID do Lerium
  continua obrigatório para `/api/show` e `/api/chat` (ADR-007).

**Alternativas rejeitadas.**

- Manter a sondagem `no-cors` sem `redirect: 'error'`: reabre o risco de
  seguir redirecionamento para outro host e só distingue "alcançável", não
  o motivo.
- `host_permissions` amplas (`http://localhost/*` fixas, `<all_urls>`):
  privilégio maior que o necessário para a porta padrão.
- Diagnosticar só por `/api/tags`: com `host_permissions` ele responde 200
  mesmo com a origem recusada, e o erro só apareceria na tradução.

**Consequências.**

- A instalação exibe aviso de permissão de acesso a `localhost` e
  `127.0.0.1`; a revisão da Chrome Web Store avaliará essas permissões.
- O manifesto ganha `background` (service worker) e as chaves de host;
  o teste de manifesto fixa as listas exatas.
- A ADR-007 fica parcialmente substituída: `host_permissions` e o
  diagnóstico passam a seguir esta ADR; a sondagem `no-cors` foi removida.
- Porta personalizada sem permissão concedida resulta em
  `permission_required`, tratado pela página de opções.

## ADR-011 — Prompt de tradução para o TranslateGemma

**Status:** Proposta (29/10/2026)

> A ADR-010 está reservada para o protocolo entre service worker e páginas.

**Contexto.** O RF05 exige um `PromptBuilder` versionado e independente de
obra; o PLAN.md §9 pede um baseline curto, comparado por A/B manual com uma
versão literária mais longa. O modelo padrão é `translategemma:4b`. Evidência
medida no Ollama 0.40.12 (`ollama show translategemma:4b`):

- arquitetura `gemma3`, 4,3B parâmetros, quantização Q4_K_M, contexto 131072;
- parâmetros do modelfile: `stop "<end_of_turn>"`, `top_k 64`, `top_p 0.95`;
  sem temperatura e **sem system prompt**; licença Gemma Terms of Use;
- o template itera as mensagens: `user` **e** `system` viram ambos
  `<start_of_turn>user\n{{content}}<end_of_turn>`; `assistant` vira
  `<start_of_turn>model`; após a última mensagem abre `<start_of_turn>model`.

Ou seja, não existe papel `system`: enviar system+user gera dois turnos de
usuário seguidos, formato que o modelo não viu no treino.

**Decisão.** Implementada em `src/core/prompt-builder.ts`.

- **Mensagem única `user`**, com a instrução fixa primeiro e o texto da
  página ao final; nenhuma mensagem `system`.
- **Formato recomendado para o TranslateGemma** no model card do Google
  (a confirmar no model card oficial): "You are a professional {Source}
  ({src}) to {Target} ({tgt}) translator. … Please translate the following
  {Source} text into {Target}:" seguido de três quebras de linha e do texto.
  Sem frase literária adicional: o baseline fica fiel ao formato.
- **Nomes de idioma em inglês** (`PROMPT_LANGUAGE_NAMES`, ex.: `pt-BR` →
  "Brazilian Portuguese", `zh-CN` → "Simplified Chinese"), distintos dos
  rótulos PT-BR da interface.
- **Parâmetros:** `stream: true`; `temperature: 0.2` (o modelfile não define;
  tradução pede estabilidade, sem o greedy puro);
  `num_predict = clamp(ceil(chars/2), 256, 4096)`, folga de ~1,5–2× sobre a
  entrada em línguas latinas, contra geração sem fim. `num_ctx` e `keep_alive` não são
  definidos.
- **Validação:** texto não vazio após trim (mas enviado sem alteração),
  idiomas suportados, origem ≠ destino e modelo via `validateModel`; erros
  como códigos.
- **Versionamento:** `PROMPT_VERSION = 'v1-translategemma-baseline'`. Toda
  mudança de texto ou de parâmetros cria nova versão; o teste fixa o
  conteúdo por snapshot.
- **Injeção de prompt:** o texto é dado. Defesa: instrução fixa antes, texto
  uma única vez ao final e saída tratada como texto puro (`textContent`).

**Alternativas rejeitadas.**

- **system + user:** rejeitado pelo template; viraria dois turnos de usuário.
- **Prompt literário longo:** adiado para A/B futuro (PLAN.md §9), como nova
  versão; prompt mais longo não melhora necessariamente modelo especializado.
- **Delimitadores XML** (`<text>…</text>`): nem o template nem o formato
  recomendado os preveem; o modelo pode traduzi-los ou ecoá-los. O teste com
  o modelo real decidirá se alguma delimitação extra é necessária.

**Consequências.**

- O pedido é específico do TranslateGemma; outros modelos podem exigir outro
  formato (nova versão ou builder por família).
- A instrução e o texto ficam no mesmo turno; a proteção depende da saída
  ser sempre inserida como texto.

**Validação pendente (antes de Aceitar).**

- Confirmar o formato do prompt no model card oficial do TranslateGemma.
- Rodar as fixtures literárias (PLAN.md §9) com o modelo real na branch do
  serviço de tradução, incluindo texto com tentativa de injeção, e calibrar
  `temperature` e `num_predict`.
