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

**Status:** Aceita (30/10/2026), Opção 1

**Decisão.** `activeTab` + `scripting`, com injeção sob demanda e só no
frame principal. O manifesto declara `permissions: ["activeTab", "scripting",
"storage"]` e `minimum_chrome_version: "114"`, sem `content_scripts`,
`web_accessible_resources`, `externally_connectable`, `tabs` nem
`<all_urls>`; `scripts/verify-dist.mjs` falha o build se isso mudar.

- O popup pede `page:inject` ao service worker, que confere a URL da aba
  (só `http(s)`), as configurações e a permissão da porta do Ollama, injeta
  `content.js` (IIFE) com `chrome.scripting.executeScript` e registra o
  `documentId` devolvido; a Port do job só é aceita desse documento
  (ADR-010).
- Páginas internas do Chrome, a Web Store, PDFs e outras extensões são
  recusadas como `page_unsupported`.

**Consequências.**

- Sem acesso permanente a sites: o Lerium só lê uma página depois do clique
  do usuário. Tradução automática ao navegar (Opção 2) fica para a Fase 7.
- Pela documentação do Chrome, `activeTab` e `scripting` não geram aviso de
  permissão na instalação; confirmar no smoke manual da atualização.
- A permissão opcional `http://localhost/*` (sem porta), se concedida, vale
  para qualquer porta local; o Lerium sempre pede a origem exata com porta,
  mas o trade-off fica registrado.
- O service worker consegue injetar sem gesto do usuário em
  `localhost:11434`/`127.0.0.1:11434`, por causa das host permissions do
  Ollama; isso só é usado nos testes E2E, que servem a fixture nessa origem.

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

**Status:** Aceita (30/10/2026)

**Contexto.** A referência insere toda a tradução no primeiro nó de texto e
esvazia os seguintes, quebrando `<em>`, `<strong>` e `<a>`
([PLAN.md §2.2](PLAN.md), nº 6). O modelo traduz melhor com o parágrafo
inteiro, mas a resposta nunca pode ser inserida como HTML.

**Opções.**

1. Tradução por nó de texto (preserva estrutura, perde contexto da frase).
2. Tradução por bloco com marcadores para nós inline, validados e mapeados de volta via `nodeValue`.
3. Híbrida: bloco quando não há markup inline; marcadores ou nó a nó quando há, com fallback seguro.

**Experimento** (`tests/manual/inline-markers.manual.test.ts`, 30/10/2026):
`translategemma:4b` no Ollama 0.40.12 (instância isolada, i5-13420H), prompt
v1 da ADR-011 sem alteração, 10 fixtures autorais de markup inline
(`tests/fixtures/inline-markup/`) × 3 execuções. Regra de decisão fixada
antes da medição: ≥ 90% de saídas válidas → Opção 3 com o formato; 60–90% →
Opção 3 registrando a taxa de fallback; < 60% → inline vai nó a nó.

| Formato | Saídas válidas (1ª rodada) |
|---|---|
| `<g1>…</g1>` | **73%** (22/30) |
| `[1]…[/1]` | 67% (18/27; 3 recusados por colisão com nota de rodapé) |
| `⟦1⟧…⟦/1⟧` | 63% (19/30) |

Padrões observados (iguais nos três formatos):

- marcadores em palavras e nomes, sem aninhamento, são preservados (7 de 10
  fixtures em 3/3 com `<g>`);
- marcador em volta de fala entre aspas é trocado pelas aspas e some;
- aninhamento (`<a><strong>`) é achatado ou perdido em todos os formatos;
- ênfase em palavra que muda na tradução às vezes some ("so angry" →
  "tão furioso").

2ª rodada, só `<g>` e com profundidade máxima 1: 81% das saídas codificadas
válidas (22/27); as 3 com aninhamento foram direto para nó a nó, sem chamada
ao modelo. 3ª rodada, com as guardas de integridade abaixo: os mesmos 22/27,
sem nenhuma saída boa recusada por elas.

**Decisão.** Opção 3 (híbrida), com o formato `<gN>…</gN>`.

1. Bloco sem markup inline vai como texto puro (`segment.text`).
2. Bloco com markup inline de um nível vai com marcadores
   (`src/core/inline-markers.ts`): `encodeMarkers` recusa colisão com a
   sintaxe já presente no texto, mais de `MAX_INLINE_WRAPPERS` wrappers e
   profundidade acima de 1; `decodeMarkers` exige a mesma sequência e o mesmo
   aninhamento dos marcadores originais e recusa saídas que:
   - omitem texto: runs externos com letras que voltam vazios, ou razão de
     letras saída/entrada fora de 0,25–4 (`lost_text`);
   - deslocam texto para dentro de um wrapper, como uma frase inteira dentro
     de um `<a>` (`run_growth`);
   - trazem tags HTML que não estavam no texto enviado (`collision`).
   As expressões regulares do codec são lineares: a versão anterior de uma
   delas levava 42 s com 2.000 espaços (ReDoS).
3. Marcadores recusados ou inválidos → tradução nó a nó. Se essa também
   falhar, o original permanece.
4. Em nenhum caso a tradução é concentrada no primeiro nó, e o texto entra no
   DOM só por `nodeValue`.
5. Os formatos perdedores saíram do código.

**Consequências.**

- Cerca de 1 em cada 4 blocos com markup inline cai no nó a nó, com perda de
  contexto da frase nesses blocos; a taxa vale para o modelo e o prompt
  medidos e precisa ser medida de novo se algum dos dois mudar.
- Um prompt v2 que peça para preservar as tags pode subir a taxa; é
  experimento da branch `test/inline-markup`, como nova versão da ADR-011.
- A aplicação no DOM e a restauração exata ficam em `feat/page-translation`.
- O caminho de texto puro tem o mesmo risco de omissão; uma checagem de
  tamanho plausível equivalente entra junto com a aplicação.
- O limite inferior de 0,25 pode recusar uma tradução CJK concisa e legítima
  (uma frase em zh-CN ficou em 0,17 na revisão); nesse caso o bloco vai nó a
  nó, o que é seguro. Ajustar o piso por idioma fica para quando houver
  medição com destino CJK.

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

**Decisão (30/10/2026, parcial).** Opções 1 e 3 combinadas, no mínimo
necessário para a Fase 4:

- `jobId` UUID v4 gerado no content script, que é a fonte de verdade do job;
  `tabId`, `frameId` e ciclo de vida do documento vêm de `port.sender`,
  nunca da mensagem.
- Cada Port pertence a um documento: navegação, recarga ou fechamento da aba
  descarregam o frame e fecham a Port, e nada do job sobrevive.
- O content descarta resultado cujo `jobId` não é o atual ou cujo `unitId`
  não é o pendente; os ids de unidade carregam o token do plano (ADR-014).
- Sem `chrome.storage.session` por enquanto: não há o que reidratar, porque
  o job morre com a Port.
- A Port fica presa ao `documentId` registrado na injeção (ADR-002, ADR-010);
  SPA e reidratação ficam para a Fase 7.

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

**Status:** Aceita (29/10/2026)

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
  (conferido no model card oficial pelo responsável em 29/10/2026): "You are a professional {Source}
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

**Validação.**

Executada em 29/10/2026 com `npm run test:manual` (branch
`test/translation-service`): Ollama 0.40.12 em instância isolada,
`translategemma:4b`, i5-13420H, 6 fixtures literárias próprias × 3 execuções.

- **18/18 execuções aprovadas** nos critérios automáticos: sem preâmbulo,
  sem truncamento, nomes próprios preservados (Kael Ardent, Seren Vael,
  Ironvale), razão de tamanho entre 1,04 e 1,20, idioma de destino plausível.
- **Injeção:** o bilhete com "ignore todas as instruções anteriores" foi
  traduzido como parte da cena nas 3 execuções; o canário nunca apareceu.
- **Termo inventado:** "Ascension Array" virou "Matriz de Ascensão" de forma
  consistente nas 3 ocorrências; a fixture passou a aceitar preservação ou
  tradução consistente (glossário fica para P1).
- **Tempo** (modelo já carregado): 6–15 s por segmento curto, 24–30 s para o
  parágrafo de 1288 caracteres.
- **Qualidade (leitura humana):** fluente e fiel na narrativa, no diálogo e na
  injeção. Erros recorrentes de **concordância de gênero** ("suas dezesseis
  anéis") e de **pronome oblíquo** ("que lhe a entregou"), além de pequenas
  imprecisões lexicais ("brazier" → "lareira"). São limites de um modelo de
  4B, não do formato do prompt; ficam como entrada para o A/B do PLAN.md §9.
- `temperature: 0.2` e `num_predict` mantidos: nenhum caso de corte ou de
  divergência relevante entre execuções.

**Model card:** o responsável conferiu, em 29/10/2026, que a instrução, a
frase final e as três quebras de linha antes do texto coincidem com o
formato do model card oficial do TranslateGemma. Com isso e a validação
acima, a ADR passa a Aceita. O A/B com prompt literário (PLAN.md §9) segue
como versão futura, sem alterar esta decisão.

## ADR-012 — Coleta de texto do DOM e ambiente de teste

**Status:** Aceita (30/10/2026)

**Contexto.** O RF03 exige coletar só nós elegíveis e excluir `script`,
`style`, `noscript`, `code`, `pre`, campos editáveis, inputs, textareas,
conteúdo da extensão e elementos ocultos. É a primeira tarefa da Fase 4
(PLAN.md, "Criar coleta com `TreeWalker` e regras de exclusão"). A estratégia
de tradução de markup inline (ADR-003) ainda não foi decidida, e a coleta não
pode antecipá-la. Os testes de DOM precisam de um ambiente DOM no Vitest, que
até aqui só rodava no Node.

**Decisão.** Implementada em `src/content/dom-collector.ts`.

- `collectTextNodes(root: Document | Element): Text[]` devolve os nós `Text`
  elegíveis em ordem de documento. Só lê o DOM: não altera nós, não loga e não
  guarda referências entre chamadas. Nós só de espaço são incluídos; agrupar
  por bloco e decidir o que traduzir é papel da segmentação. Devolver nós (e
  não blocos) mantém a coleta neutra quanto à ADR-003.
- Um único `TreeWalker` com `SHOW_ELEMENT | SHOW_TEXT`: elemento excluído →
  `FILTER_REJECT` (poda a subárvore); outros elementos → `FILTER_SKIP`; texto →
  `FILTER_ACCEPT`. Comentários ficam fora por construção. Comparação por
  `nodeType` e `localName` em minúsculas (vale para HTML, SVG e MathML), sem
  `instanceof`, para não depender do realm do documento.
- Se a raiz, ou um ancestral dela, é excluída, o resultado é `[]`.
- Documento em `designMode` `"on"` (sem diferenciar maiúsculas) devolve `[]`,
  com `Document` ou `Element` como raiz: a página inteira é editável.

| Exclusão (poda da subárvore) | Motivo |
|---|---|
| `head` | metadados (`title`, `style`, `script`), não é texto de leitura |
| `title` (também fora do `head`) | o parser mantém `<title>` no `body`; não é texto de leitura |
| `script`, `style`, `noscript`, `template` | código, CSS, conteúdo alternativo ou inerte |
| `code`, `pre`, `kbd`, `samp`, `xmp`, `listing`, `plaintext` | código, saída técnica e elementos obsoletos de texto bruto perderiam sentido traduzidos |
| `textarea`, `input`, `select`, `option`, `optgroup`, `datalist` | valores de formulário pertencem ao usuário ou ao site |
| `svg`, `math` | texto posicionado ou semântico; traduzir quebra o desenho ou a fórmula |
| `iframe`, `object`, `embed`, `canvas`, `video`, `audio` | outro documento ou conteúdo embutido |
| `contenteditable` com `""`, `true` ou `plaintext-only` no próprio elemento, ou `isContentEditable === true` | campo editável; alterar o texto interfere na edição (a propriedade, do Chromium, é defesa extra; falta no jsdom) |
| `translate="no"` (sem diferenciar maiúsculas) e classe `notranslate` | opt-out explícito do autor (HTML e convenção comum) |
| atributo `hidden` (qualquer valor, inclusive `until-found`) | elemento oculto |
| `style` inline com `display: none` | elemento oculto, detectável sem estilo computado |
| `[data-lerium-ui]` (`LERIUM_UI_ATTRIBUTE`) | interface do próprio Lerium |

- **Poda sem reativação:** um `translate="yes"` ou `contenteditable="false"`
  dentro de uma área excluída continua fora. Simplifica a regra e erra para o
  lado de não tocar no que o autor protegeu. Fora de área excluída,
  `contenteditable="false"` é texto comum.
- **Sem estilo computado:** o `style` inline é lido por um parser simples
  (sem diferenciar maiúsculas, com espaços, comentários e `!important`; a
  última declaração vence, salvo `!important` anterior), em tempo linear com
  `indexOf`/`trimEnd`/`endsWith` (as regex anteriores tinham backtracking
  quadrático); comentário sem fechamento descarta o resto. Atributo `style`
  com mais de 4096 caracteres não é analisado e o elemento é tratado como
  visível (coletado), o que fixa o custo por elemento. `getComputedStyle`
  força cálculo de estilo em cada elemento, custa caro em capítulos longos e
  não é necessário para a coleta. Consequência aceita: texto oculto por folha
  de estilo (classe com `display: none`) é coletado; o refino por
  visibilidade fica para a Fase 5, junto com a priorização por viewport.
- **`visibility` não poda:** é herdada, mas um descendente com
  `visibility: visible` volta a aparecer; podar a subárvore descartaria texto
  exibido. Texto oculto só por `visibility` é coletado, como o oculto por
  folha de estilo (custo, não risco).
- `button` e `aria-hidden="true"` continuam traduzíveis: são texto visível
  ao leitor (`aria-hidden` só o esconde da árvore de acessibilidade).
- **Fora do escopo:** Shadow DOM (o `TreeWalker` não entra em shadow roots) e
  iframes (dependem da política de injeção da ADR-002).
- **`data-lerium-ui` é só exclusão:** nunca deve ser usado como sinal de
  confiança, porque a página pode aplicá-lo a qualquer elemento. A UI futura
  fica em shadow root fechado, com referências próprias.
- **Limitações aceitas (coletado mesmo sem ser texto de leitura visível):**
  - texto oculto por folha de estilo;
  - conteúdo de `<dialog>` e `<details>` fechados;
  - light DOM de custom elements que não é exibido (sem `slot`);
  - declaração inválida após uma válida (`display:none; display: nonsense`):
    o navegador ignora a inválida e oculta, a coleta usa a última e coleta;
  - editores que renderizam o texto do usuário sem `contenteditable` (ex.:
    Monaco);
  - dados pessoais exibidos pela própria página: a tradução é iniciada pelo
    usuário e o destino é o Ollama em loopback.

**Ambiente de teste.** Vitest com dois projetos em `vite.config.ts`: `unit`
(`tests/unit`, Node) e `integration` (`tests/integration`, jsdom 30.1.3,
devDependency). `npm test` roda os dois; `tsconfig.integration.json` tipa os
testes de integração com `DOM`.

- **jsdom (escolhido):** implementação madura de `TreeWalker`, `DOMParser`,
  `attachShadow` e atributos, integrada ao Vitest; não faz layout, o que é
  coerente com uma coleta que não usa estilo computado.
- **happy-dom:** em geral mais rápido, mas prioriza velocidade sobre
  conformidade com o padrão; não foi avaliado aqui, e a velocidade não importa
  no tamanho atual da suíte (a suíte de integração roda em menos de 1 s).
- **Só Playwright:** DOM real, porém lento e sem isolar a função; fica para
  os E2E de tradução de página.

**Consequências.**

- A segmentação (`feat/dom-segmentation`) recebe `Text[]` e decide blocos,
  espaços e a estratégia da ADR-003.
- Páginas que escondem conteúdo só por CSS terão esse texto coletado até a
  Fase 5.
- Conteúdo em Shadow DOM ou iframes não é traduzido no MVP.
- Uma dependência de desenvolvimento a mais (jsdom, MIT), fora do bundle.
  Quando o content script entrar no build, verificar que o jsdom não vai para
  `dist`.

## ADR-013 — Segmentação por bloco e identidade de segmento

**Status:** Aceita (30/10/2026)

**Contexto.** A Fase 4 pede segmentação por bloco (parágrafo, subtítulo,
lista), preservando espaços e quebras, e identidade de segmento estável por
documento. A entrada é a lista de nós da coleta (ADR-012).

**Decisão.** Implementada em `src/content/segmenter.ts` e
`src/content/inline-layout.ts`.

- **Bloco:** o ancestral mais próximo da lista `BLOCK_ELEMENTS` (`p`,
  `h1`–`h6`, `li`, `dt`, `dd`, `blockquote`, `td`, `th`, `caption`,
  `figcaption`, `div`, `section`, `article`, `nav`, `center`, `form` e
  outros). Todo o resto é
  inline, inclusive elementos customizados; sem estilo computado (ADR-012).
- **Fronteiras:** novo segmento quando muda o bloco ou quando há, entre dois
  nós, um elemento de bloco, um `<br>` ou um elemento excluído pela coleta.
  `<br>` sempre separa: capítulos inteiros em um `div` com `<br><br>` viram
  parágrafos, em vez de um segmento gigante.
- **Conteúdo:** `nodes` guarda todos os nós, inclusive os só de espaço, para
  a restauração exata; `text` colapsa espaço ASCII e preserva U+00A0.
  Segmentos sem nenhuma letra (`|`, `* * *`, `—`) são descartados.
- **Identidade:** id ordinal `seg-N` em ordem de documento, por chamada. Hash
  do conteúdo foi rejeitado (textos repetidos colidem e o hash funcionaria
  como impressão digital do texto em mensagens); caminho estrutural foi
  rejeitado (tão frágil quanto o ordinal e mais caro). A identidade real é a
  referência ao objeto; o job (ADR-004) só aplica resultados que casem
  `jobId` e `segmentId`. Ids monotônicos por documento ficam para a Fase 7
  (MutationObserver).
- **Fronteira de mensagens:** `TranslationSegment` guarda referências do DOM
  e nunca atravessa mensagens; só `{ segmentId, text }` sai do content script.
- **Layout inline:** `inlineLayoutOf` descreve o bloco como runs com caminho
  de wrappers; wrappers que envolvem todo o conteúdo são ignorados (nós só de
  espaço não contam nessa cobertura). Acima de `MAX_INLINE_DEPTH` ou de
  `MAX_INLINE_WRAPPERS`, devolve `INLINE_LIMITS_EXCEEDED` sem montar o resto,
  e o bloco vai nó a nó; cada nó visita no máximo `MAX_INLINE_DEPTH + 2`
  ancestrais.
- **Tamanho:** `MAX_SEGMENT_CHARS = 6000`; segmentos maiores são devolvidos
  inteiros e quem aplica os mantém no original (`segment_too_long`).
  Divisão por frase fica para a Fase 5, se a medição pedir.

**Consequências.**

- Custo linear no trecho do documento entre o primeiro e o último nó.
- Elementos exibidos como bloco só por CSS (`span` com `display:block`)
  são tratados como inline; `white-space: pre-wrap` via CSS não é detectado.
- `nav` é segmentado como qualquer bloco; prioridade é tema da Fase 5.
- Elemento excluído no meio da frase (`translate="no"` em um nome, `<code>`
  inline) separa a frase em fragmentos traduzidos à parte; um marcador opaco
  no lugar dele fica como melhoria futura.
- `<ruby>` mistura a leitura (`<rt>`) ao texto enviado ao modelo; excluir
  `rt`/`rp` fica como melhoria da coleta.

## ADR-014 — Aplicação da tradução e restauração do original

**Status:** Aceita (30/10/2026)

**Contexto.** O Gate da Fase 4 exige que `original -> traduzido -> original`
retorne o conteúdo exato, com links e formatação, e o PLAN.md §8 proíbe
inserir saída do modelo como HTML. A página pode alterar ou remover nós a
qualquer momento, e resultados podem chegar atrasados.

**Decisão.** Implementada em `src/content/page-applier.ts`, sem `chrome`.

- **Plano por segmento:** `plan(segment)` escolhe o caminho da ADR-003
  (`plain`, `markers` ou `per_node`) e devolve unidades de texto a traduzir.
  Texto puro com mais de um nó com conteúdo vai `per_node`: a tradução nunca
  é concentrada no primeiro nó (risco nº 6 da referência).
- **Escrita só por `node.data`.** Saída acima de `MAX_OUTPUT_CHARS`, vazia ou
  com razão de letras implausível (`checkLetterRatio`, também usada pelo
  codec) é recusada antes de qualquer processamento.
- **Atomicidade por segmento:** no `apply`, todos os nós do plano precisam
  estar conectados, com o mesmo texto e o mesmo pai do momento do plano, e
  fora de contexto excluído ou editável; senão `node_changed` e nada é
  escrito. Se qualquer unidade falhar, o segmento inteiro fica no original:
  um parágrafo sem tradução confunde menos que um parágrafo com dois idiomas.
- **Vínculo resultado-plano:** cada plano tem um token próprio embutido nos
  ids das unidades; resultado de plano substituído ou id forjado não escreve.
- **Registro** `Map<Text, { original, applied }>`: se o site trocou o texto
  aplicado, o texto atual passa a ser o original. `restore` só escreve se o
  nó ainda tem exatamente o texto aplicado e não está em contexto editável;
  `reapply` faz o inverso. Nós desconectados saem do registro no `restore`.

**Consequências.**

- A restauração respeita mudanças do site e do usuário, à custa de não
  restaurar nós que o site alterou depois da tradução.
- O registro guarda referências fortes até o `clear`, que o executor de job
  chama ao iniciar um novo job; cancelar não limpa, para que “Mostrar
  original” ainda restaure o que já foi aplicado. Limpar ao descarregar a
  página fica com a entrada do content script.
- As garantias pressupõem o mundo isolado do content script; com
  `world: 'MAIN'`, a página poderia adulterar protótipos e elas não valem.
- Nó movido dentro do mesmo pai ou texto inserido no meio do segmento entre o
  plano e a aplicação não são detectados no MVP.

## ADR-010 — Protocolo entre service worker e página

**Status:** Aceita (30/10/2026)

**Contexto.** O content script coleta, segmenta e aplica (ADR-012 a 014), mas
só o service worker fala com o Ollama (ADR-009). O worker MV3 pode ser
encerrado por ociosidade, e a tradução de uma página leva minutos.

**Decisão.** Uma `chrome.runtime.Port` por job, com o content script no
comando (`src/shared/page-messages.ts`, `src/background/page-job.ts`,
`src/content/job-runner.ts`).

- **Conexão:** `chrome.runtime.connect({ name: 'lerium:page-job' })`. O worker
  aceita só a própria extensão (`sender.id`), aba com id numérico, frame
  principal (`frameId === 0`), página `http(s)` e documento ativo
  (`documentLifecycle`); qualquer outra Port é desconectada sem resposta. O
  manifesto não declara `externally_connectable`.
- **Configurações:** endpoint, modelo e idiomas vêm do storage, lidos uma vez
  por Port na primeira mensagem válida; um provedor por Port (snapshot). A
  mensagem só traz o texto, então o content não consegue mudar destino nem
  idiomas.
- **Mensagens tipadas e validadas** nos dois sentidos, com allowlist de
  códigos de erro: `job:unit` (texto até `MAX_UNIT_CHARS`), `job:ping`,
  `job:result`, `job:progress` (só contagem de caracteres) e `job:fatal`
  (`invalid_config`, `model_missing`, `forbidden`, `settings_unavailable`).
  Nenhuma mensagem além do resultado leva texto.
- **Sequência:** o content envia uma unidade por vez e espera o resultado; o
  worker responde `busy` a uma segunda unidade na mesma Port. Uma Port por
  aba: uma nova derruba a anterior. O limite global entre abas é do
  scheduler (Fase 5).
- **Cancelamento:** desconectar a Port aborta a requisição em voo; saída
  acima de `MAX_OUTPUT_CHARS` é abortada durante o stream.
- **Ciclo de vida do worker:** pela documentação do Chrome, mensagens de
  Port renovam o timer de ociosidade de 30 s (Chrome 114+). O content envia
  `job:ping` a cada 20 s com unidade em voo, e o worker envia `job:progress`
  no máximo a cada 5 s. Port que cai sem resultado vira `interrupted`; o que
  já foi aplicado continua restaurável.

**Consequências.**

- Precisa ser medido no Chrome real: se uma resposta do Ollama que demora
  mais de 30 s para começar (modelo frio) encerra o worker mesmo com ping.
  Mitigações previstas: aquecer o modelo antes ou repetir uma vez a primeira
  unidade interrompida. `minimum_chrome_version: "114"` já está no manifesto.
- A Port só é aceita do documento registrado na injeção (`documentId`) e
  com `documentLifecycle === 'active'`. O registro vive em memória: se o
  worker reiniciar, a Port é recusada e o job vira `interrupted`. Por isso o
  popup envia `page:inject` antes de todo `start`; a reinjeção é idempotente
  e devolve o mesmo `documentId`.
- `network` encerra o job (`job:fatal`): com o Ollama desligado, insistir
  segmento a segmento só acumularia requisições perdidas. `timeout` não é
  fatal, porque pode ser um segmento longo num modelo lento.
- A permissão de porta personalizada é conferida no `page:inject`, antes de
  injetar (`permission_required`).
- `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`
  é chamado no início do worker, para que um content script não leia nem
  regrave as configurações; o efeito em `storage.local` precisa de
  confirmação no smoke manual.
