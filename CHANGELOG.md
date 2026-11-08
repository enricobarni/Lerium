# Changelog

Todas as mudanças relevantes do Lerium são registradas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa [Versionamento Semântico](https://semver.org/lang/pt-BR/) (ver [docs/PLAN.md §5.4](docs/PLAN.md)).

## [Não lançado]

Fase 5 — o texto que você está lendo é traduzido primeiro.

### Adicionado

- Fila com prioridade: o texto visível vai antes, depois o que está perto da tela, o resto e por fim cabeçalhos, rodapés e menus ([ADR-015](docs/DECISIONS.md)).
- A ordem se ajusta enquanto você rola a página ([ADR-016](docs/DECISIONS.md)).
- Um trecho fora da tela é interrompido quando o texto visível espera mais de meio segundo ([ADR-017](docs/DECISIONS.md)).
- Capítulos separados por `<br>` também priorizam o trecho na tela ([ADR-018](docs/DECISIONS.md)).
- Indicador de progresso na própria página, acessível e discreto, que some sozinho ao terminar ([ADR-019](docs/DECISIONS.md)).
- Métricas locais no estado do job, sem texto: tempo até a primeira tradução visível, duração, espera do visível e interrupções.

### Alterado

- Uma tradução por vez no Ollama, entre todas as abas: no CPU, traduzir em paralelo quase não ganhou tempo ([ADR-015](docs/DECISIONS.md)).

### Segurança

- O indicador fica num shadow root fechado, nunca mostra texto da página e o build recusa shadow root aberto no script da página.

## [0.2.0] - 2026-10-31

Primeira versão que **traduz páginas**: clique no ícone do Lerium e em **Traduzir página**. A tradução roda no Ollama do seu computador.

### Adicionado

- Tradução da página pelo popup: **Traduzir página**, **Cancelar tradução**, **Mostrar original** e **Mostrar tradução**, com progresso e mensagens em PT-BR para cada erro (Ollama fechado, origem recusada, modelo ausente, página não suportada, permissão de porta).
- Coleta do texto da página sem tocar em código, campos de formulário, áreas editáveis, scripts, texto oculto e trechos marcados com `translate="no"` ([ADR-012](docs/DECISIONS.md)).
- Segmentação por bloco (parágrafo, título, item de lista), com `<br>` separando parágrafos ([ADR-013](docs/DECISIONS.md)).
- Preservação de negrito, itálico e links dentro do parágrafo com marcadores `<gN>`, e tradução nó a nó quando o modelo não os preserva ([ADR-003](docs/DECISIONS.md)).
- Aplicação só por texto (nunca HTML) e restauração exata do original, que respeita mudanças feitas pelo site ([ADR-014](docs/DECISIONS.md)).
- Motor de tradução local sobre o Ollama: chat em streaming com prazos e cancelamento, prompt versionado para o TranslateGemma ([ADR-011](docs/DECISIONS.md)), nova tentativa conservadora para falhas passageiras.
- Protocolo entre a página e o service worker por uma conexão por tradução, com cancelamento ([ADR-010](docs/DECISIONS.md)).
- Fixtures literárias próprias, testes E2E de tradução de página e teste manual opt-in com o modelo real (`npm run test:manual`).

### Segurança

- Permissões `activeTab` e `scripting`: o Lerium só lê uma página depois do seu clique e não tem acesso permanente a sites ([ADR-002](docs/DECISIONS.md)). Versão mínima: Chrome 114.
- O script de tradução só é aceito no documento em que foi injetado; páginas web e outras extensões não conseguem comandá-lo.
- Guardas contra respostas suspeitas do modelo (texto omitido, texto deslocado para dentro de links, tags HTML) e expressões regulares lineares.
- O build verifica o pacote final: script clássico, sem APIs perigosas, sem permissões fora da lista, sem sourcemaps.

### Conhecido

- A tradução é sequencial, do início ao fim da página, e no CPU leva alguns segundos por parágrafo. Priorizar o texto visível é a Fase 5.

## [0.1.0] - 2026-10-29

Esqueleto funcional e conexão com o Ollama local. A extensão ainda **não traduz**.

### Adicionado

- Extensão Chrome Manifest V3 em TypeScript strict, com build Vite, ícones originais e licença MIT.
- Popup em PT-BR com acesso à página de configurações.
- Configurações persistentes em `chrome.storage.local` (endereço do Ollama, modelo, idiomas de origem e destino), com valores padrão aplicados na leitura, sem sobrescrever preferências ([ADR-008](docs/DECISIONS.md)).
- Validação do endereço: apenas `http` em `localhost` ou `127.0.0.1`.
- Botão "Testar conexão": lista os modelos instalados, avisa quando o modelo configurado não existe e diagnostica Ollama inacessível, resposta que não é do Ollama e origem recusada (HTTP 403).
- Orientação para liberar a origem exata do Lerium em `OLLAMA_ORIGINS`, com ID fixo `mjkoppimccgajnabfeheglepjapkchlk` ([ADR-007](docs/DECISIONS.md)).
- Service worker como único cliente HTTP, com acesso restrito ao loopback na porta 11434 e permissão opcional, com porta explícita, para outras portas ([ADR-009](docs/DECISIONS.md)).
- Testes unitários (Vitest), testes E2E no Chromium (Playwright) e CI no GitHub Actions.

### Segurança

- Permissões mínimas: `storage` e acesso a `localhost:11434`/`127.0.0.1:11434`; sem content scripts nem acesso a sites.
- Nenhum envio de dados a terceiros e nenhum log de conteúdo.

[Não lançado]: https://github.com/enricobarni/Lerium/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/enricobarni/Lerium/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/enricobarni/Lerium/releases/tag/v0.1.0
