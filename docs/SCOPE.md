# Escopo do MVP — Lerium

> Resumo do escopo derivado de [PLAN.md](PLAN.md). Em caso de conflito, o plano prevalece.
> **Nome do produto:** Lerium. O codinome provisório `local-novel-translator`, citado no plano, foi substituído por este nome.

## Objetivo

Extensão própria para Chrome que traduz páginas e trechos selecionados diretamente no navegador, usando modelos de IA executados localmente no Ollama. Prioridades: **naturalidade literária**, **preservação do HTML**, **privacidade** (nada sai da máquina), rapidez percebida e **custo zero** (sem quotas, cobranças ou backend). Ver PLAN.md §0 e §1.

## Ambiente-alvo

- Windows 11, Google Chrome desktop.
- Intel Core i5-13420H, 32 GB de RAM, vídeo integrado.
- Ollama local em `http://localhost:11434`, modelo `translategemma:4b` (4,3B, GGUF Q4_K_M).
- Idioma de origem padrão `en`; destino padrão `pt-BR`.
- O relato do usuário (tradução progressiva com espera baixa usando a referência modificada) é observação, **não benchmark** reproduzível nem garantia de tempo. Ver PLAN.md §1.

## Requisitos P0

Detalhes e critérios completos em PLAN.md §3.

| ID | Descrição | Critério de aceite (resumo) |
|---|---|---|
| RF01 | Opções em PT-BR (endpoint, modelo, idiomas, paralelismo, modo, domínios excluídos); defaults `localhost:11434` + `translategemma:4b`; apenas loopback; migração não destrutiva. | Configurações sobrevivem a recarga da extensão; erros em português; nada sobrescrito indevidamente. |
| RF02 | Traduzir seleção pelo popup e pelo menu de contexto, com indicador de carregamento e o mesmo `TranslationService`/prompt da página. | Funciona no conteúdo principal e em elementos inline; resultado correto em PT-BR; trata seleção vazia e páginas Chrome não suportadas. |
| RF03 | Traduzir página inteira: só nós elegíveis, exclusões (`script`, `code`, campos editáveis etc.), prioridade ao conteúdo principal visível, atualização progressiva, original retido. | `<p>`, `<em>`, `<strong>` e `<a>` seguem navegáveis/estilizados; sem duplicação ou remoção de nós; progresso coerente. |
| RF04 | Controles (iniciar, cancelar, original/tradução, tentar novamente) e estados explícitos; jobs isolados por aba + documento/navegação + job. | Desligar no meio não injeta texto depois; reativar não duplica; abas não interferem entre si. |
| RF05 | Prompt literário universal, independente de obra, em `PromptBuilder` versionado e testado, com delimitação explícita do texto. | Mesma engine para romance, fantasia e sci-fi; saída só com a tradução; fixtures com nomes próprios, diálogo e termos recorrentes. |
| RF06 | Cliente único Ollama (`/api/tags`, `/api/chat`), NDJSON incremental com buffer, scheduler de 1 a 5 (default 2), retry limitado só para falhas transitórias. | Nenhum token perdido em stream fragmentado; falha preserva o original; timeout/cancelamento controlados; sem requisições infinitas. |
| RF07 | Sem backend, telemetria ou persistência de conteúdo; permissões mínimas; injeção sob demanda; página como dado não confiável; inserção via `textContent`/`nodeValue`. | Auditoria manual de permissões; nenhuma requisição a terceiros; `chrome://` e Chrome Web Store tratadas como não suportadas. |

## Requisitos P1 (não antecipar)

- Glossários por obra, somente com evidência real de inconsistência.
- Perfis de prompt, cache opcional e controles de desempenho.
- Robustez para SPA/conteúdo dinâmico (F10).

Implementar apenas após uso real do MVP. Ver PLAN.md §1 e §6 (Fase 9).

## Fora de escopo do MVP

Publicação na Chrome Web Store; sincronização em nuvem; contas; backend; pagamento; endpoint remoto; OCR/imagens/manhwa; tradução em massa de acervos; scraping; desbloqueio de conteúdo pago; TTS; suporte completo a Firefox/Safari; treinamento de modelo; indexação de obras protegidas. Ver PLAN.md §1.

## Questões em aberto

| Questão | Por que está em aberto | Decidir em |
|---|---|---|
| Licença do próprio Lerium | Não há arquivo `LICENSE` no repositório; a escolha afeta distribuição e contribuições. | Fase 0, antes do primeiro código. |
| Política de injeção | `activeTab` + `scripting` (menor privilégio, exige ação do usuário) vs permissões opcionais por domínio (permite tradução persistente por site). Ver PLAN.md §4 e §8. | Fase 0/1, antes do manifesto. |
| Estratégia DOM para markup inline | Tradução por nó preserva estrutura mas perde contexto; marcadores preservam contexto mas dependem do modelo respeitá-los. | Fase 4, com testes de restauração. |
| Identificador de documento/job e reidratação | O service worker MV3 é suspenso e perde estado global; é preciso um ID comprovado e fonte de verdade fora do worker. | Fase 3/4, antes do scheduler. |
| UX do resultado de seleção (RF02) | Balão na página independe do popup aberto; resultado no popup é mais simples, mas some ao fechar. | Fase 6. |
| Detecção de idioma de origem | Heurísticas da referência são insuficientes; detectar vs fonte explícita (padrão `en`) muda UI e prompt. | Fase 2 (configuração) / Fase 6. |
| Necessidade e restrição de CORS (`OLLAMA_ORIGINS`) | Não se sabe se o Ollama aceita a origem da extensão sem ajuste; se necessário, restringir à origem específica, nunca `*`. | Fase 2, testando a conexão real. |
| Estratégia de merge de PRs | Squash simplifica o histórico, mas apaga commits atômicos; merge/rebase os preserva. Ver PLAN.md §5.1. | Fase 1, ao configurar o repositório remoto e a CI. |

## Referência observada e licença

**Repositório observado:** https://github.com/shikira/ollama-translator

**Limites da engenharia reversa:** análise estática do código público, complementada pelo relato de uso do usuário. Não é auditoria completa nem cobre todos os sites. Ver PLAN.md §2.

**Fatos verificados em 28/10/2026 via API do GitHub:**

- O campo `license` do repositório é `null`.
- A raiz contém `README.md`, `README.ja.md`, `background.js`, `content.js`, `popup.js`/`popup.html`, `options.js`/`options.html`, `manifest.json`, `create-icons.html` e ícones PNG.
- **Não há arquivo `LICENSE`.**
- O `README.md` declara "MIT License" em sua seção de licença.

**Decisão:**

- Implementar apenas o **comportamento observável** da referência (PLAN.md §2.1).
- **Não reutilizar** código, ícones, textos ou marca da referência.
- Qualquer reutilização futura exige licença verificada (PLAN.md §8, item 8).
- Os 14 problemas listados em PLAN.md §2.2 **não devem ser reproduzidos**.

**Status:** licença da referência permanece **não confirmada**. Não tratar como resolvida.
