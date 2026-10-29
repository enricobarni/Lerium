# Changelog

Todas as mudanças relevantes do Lerium são registradas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa [Versionamento Semântico](https://semver.org/lang/pt-BR/) (ver [docs/PLAN.md §5.4](docs/PLAN.md)).

## [Não lançado]

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

[Não lançado]: https://github.com/enricobarni/Lerium/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/enricobarni/Lerium/releases/tag/v0.1.0
