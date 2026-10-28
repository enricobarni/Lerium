# Lerium

Lerium é uma extensão para Chrome que traduzirá páginas e seleções de texto com modelos executados localmente no [Ollama](https://ollama.com), priorizando naturalidade literária, preservação do HTML original, privacidade e custo zero.

**Status:** em desenvolvimento. A versão atual contém apenas a estrutura da extensão (popup e página de configurações) e **ainda não traduz**.

## Requisitos

- Node.js 24 (versão fixada em [`.nvmrc`](.nvmrc)) e npm.
- Google Chrome para desktop.
- Ollama em execução local: requisito das próximas versões, ainda não usado.

## Instalação (Carregar sem compactação)

1. Instale as dependências e gere o build:

   ```sh
   npm ci
   npm run build
   ```

2. Abra `chrome://extensions` no Chrome.
3. Ative o **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação** e selecione a pasta `dist/` do repositório.

Após cada novo `npm run build`, clique no botão de recarregar da extensão em `chrome://extensions` para aplicar as mudanças.

## Scripts

| Script              | Descrição                                               |
| ------------------- | ------------------------------------------------------- |
| `npm run build`     | Gera a extensão em `dist/`.                             |
| `npm run typecheck` | Verifica os tipos do TypeScript.                        |
| `npm run test`      | Executa os testes com Vitest.                           |
| `npm run lint`      | Executa ESLint e confere a formatação com Prettier.     |
| `npm run format`    | Formata os arquivos com Prettier.                       |
| `npm run icons`     | Gera os ícones da extensão.                             |

## Documentação

- [docs/PLAN.md](docs/PLAN.md) — plano e roadmap do projeto.
- [docs/PROGRESS.md](docs/PROGRESS.md) — progresso por fase e tarefa.
- [AGENTS.md](AGENTS.md) — guia para agentes de IA que trabalham no repositório.

## Licença

[MIT](LICENSE).
