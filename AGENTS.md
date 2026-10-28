# AGENTS.md — Lerium

Guia para agentes de IA que trabalham neste repositório.

## Propósito

**Lerium** é uma extensão própria para Chrome que traduz páginas e seleções com modelos executados localmente no Ollama, priorizando naturalidade literária, preservação do HTML, privacidade e custo zero. O codinome `local-novel-translator`, citado no plano, foi substituído por Lerium.

## Documentos

- [docs/PLAN.md](docs/PLAN.md) — **contrato de execução**. Em caso de conflito com qualquer outro documento, o plano prevalece.
- [docs/SCOPE.md](docs/SCOPE.md) — escopo do MVP, questões em aberto e situação de licença da referência.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — arquitetura e fluxo MV3.
- [docs/DECISIONS.md](docs/DECISIONS.md) — decisões técnicas registradas.
- [docs/TEST_PLAN.md](docs/TEST_PLAN.md) — estratégia e cenários de teste.
- [docs/PROGRESS.md](docs/PROGRESS.md) — fase, tarefa, commits, testes e próximos passos.

## Regras de execução

Resumo de PLAN.md §0.

1. Inspecione o repositório, os arquivos e o histórico antes de agir; não presuma que está vazio.
2. Execute **uma tarefa coesa por vez**; não antecipe fases futuras.
3. Antes de cada tarefa, registre intenção, arquivos previstos, riscos e critério de validação.
4. Ao concluir, rode as verificações relevantes e faça um commit pequeno e atômico. Não commite com lint, typecheck ou testes falhando sem registrar o bloqueio.
5. Sem `push`, merge, release, publicação ou ação destrutiva no remoto sem autorização explícita do responsável.
6. Mantenha `docs/PROGRESS.md` atualizado.
7. Diagnostique bloqueios com evidências; não troque um requisito por solução inferior em silêncio.
8. Não superarquitete: funções puras, interfaces explícitas, estruturas simples.
9. Só dependências gratuitas e justificadas; sem backend, nuvem paga ou chave de API comercial.
10. Não colete, envie, registre em log nem persista texto das páginas por padrão.

## Git

Resumo de PLAN.md §5.1–§5.3.

- **GitHub Flow:** `main` sempre estável; branches curtas criadas da `main` atualizada, uma por tarefa.
- Nome de branch: `tipo/descricao`, minúsculas, sem espaços ou acentos (ex.: `feat/ollama-connection`, `fix/ndjson-boundaries`).
- Sem `develop` nem branches de fase de vida longa. Sem commit direto em `main`.
- Exceção registrada: o commit inicial em `main` (`docs(plan): ...`) foi aprovado pelo responsável.
- **Conventional Commits 1.0.0:** `<type>(<scope>): <descrição no imperativo>`.
  - Tipos: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `style`, `build`, `ci`, `chore`, `revert`.
  - Escopos sugeridos: `extension`, `manifest`, `content`, `popup`, `options`, `ollama`, `stream`, `queue`, `dom`, `prompt`, `storage`, `security`, `ci`, `docs`.
  - Assunto em minúsculas após `:`, até 72 caracteres; um commit = uma mudança lógica; motivo no corpo quando não óbvio.
  - Mudança incompatível: `!` ou rodapé `BREAKING CHANGE:`.
  - Proibido: mensagens vagas (`update`, `wip`, `ajustes`), binários de modelo, segredos, dados pessoais, páginas de novels, `node_modules/`.
- Rode `git diff --check` e revise o diff antes de commitar.
- PR com o checklist de PLAN.md §5.3: Objetivo, Mudanças, Testes (lint, typecheck, test, build, smoke manual), Riscos e regressões, Evidência. Merge bloqueado se algum item obrigatório falhar.

## Segurança e privacidade

Resumo de PLAN.md §8.

- Endpoint **apenas loopback** (`localhost`/`127.0.0.1`) no MVP.
- Privilégio mínimo; evitar `<all_urls>`; injeção sob demanda.
- **Nunca** usar `innerHTML` com saída do modelo; inserir via `textContent`/`nodeValue`.
- Conteúdo da página é **dado não confiável**, nunca instrução para a extensão.
- Sem logs de conteúdo: registrar só metadados (duração, nº de segmentos, códigos de erro).
- CORS só se os testes provarem necessidade, restrito à origem da extensão; nunca `*`.

## Licença e referência

Lerium é licenciado sob **MIT** ([LICENSE](LICENSE), ADR-006) e é uma **implementação independente**. A extensão de referência orienta apenas comportamento observável; não reutilize código, ícones, textos ou marca. A licença da referência está **não confirmada** — ver [docs/SCOPE.md](docs/SCOPE.md), seção "Referência observada e licença".

## Checkpoint ao fim de cada tarefa

Conforme PLAN.md §10, entregue:

1. Resumo funcional.
2. Arquivos alterados.
3. Decisões técnicas e trade-offs.
4. Validação: comandos executados e resultados reais.
5. Git: branch ativa, commits locais e estado do working tree.
6. Pendências e riscos.
7. Uma única próxima tarefa, alinhada ao roadmap.

## Definition of Done

Conforme PLAN.md §11, uma tarefa só está pronta se:

- [ ] Resolve uma necessidade descrita no plano.
- [ ] Não depende de serviço pago ou externo para inferência.
- [ ] Não quebra funcionalidades anteriores.
- [ ] Tem testes proporcionais ao risco, todos passando.
- [ ] Respeita privacidade, segurança e integridade do DOM.
- [ ] Está formatada, tipada e suficientemente documentada.
- [ ] Artefatos gerados (bundles, cobertura, caches) e segredos fora do Git; arquivos necessários ao build (configs, lockfile, manifesto) versionados (PLAN.md §5.5).
- [ ] Commit pequeno com Conventional Commits válido.
- [ ] `docs/PROGRESS.md` atualizado.

O MVP só termina quando RF01–RF07 estiverem aceitos.

## Regra absoluta

**Nunca inventar hashes, resultados de testes ou commits.**
