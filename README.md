# Lerium

Lerium é uma extensão para Chrome que traduzirá páginas e seleções de texto com modelos executados localmente no [Ollama](https://ollama.com), priorizando naturalidade literária, preservação do HTML original, privacidade e custo zero.

**Status:** em desenvolvimento. A versão atual contém apenas a estrutura da extensão (popup e página de configurações) e **ainda não traduz**.

## Requisitos

- Node.js 24 (versão fixada em [`.nvmrc`](.nvmrc)) e npm.
- Google Chrome para desktop.
- Ollama em execução local. A página de configurações já testa a conexão e lista os modelos instalados; a tradução virá nas próximas versões.

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

## Conectar ao Ollama

O Lerium fala com o Ollama somente pelo seu service worker e somente no seu computador. Por isso, ao carregar a extensão, o Chrome informa que ela pode acessar `localhost:11434` e `127.0.0.1:11434` (a porta padrão do Ollama). Se você configurar outra porta, o Lerium pede permissão para essa porta exata ao clicar em **Testar conexão** ou **Salvar** ([ADR-009](docs/DECISIONS.md)).

Por segurança, o Ollama recusa pedidos de extensões cuja origem não esteja liberada na variável de ambiente `OLLAMA_ORIGINS`. Libere apenas a origem do Lerium:

```text
chrome-extension://mjkoppimccgajnabfeheglepjapkchlk
```

O ID `mjkoppimccgajnabfeheglepjapkchlk` é fixo, derivado da chave pública do manifesto ([ADR-007](docs/DECISIONS.md)); confira com `npm run extension-id`. A página de configurações também mostra essa origem, com o botão **Copiar origem**.

No Windows:

1. No menu Iniciar, pesquise e abra **Editar as variáveis de ambiente para sua conta**.
2. Em **Variáveis de usuário**, crie a variável `OLLAMA_ORIGINS` com a origem acima como valor, ou edite-a se ela já existir.
3. Se `OLLAMA_ORIGINS` já tiver um valor, não o apague: acrescente uma vírgula ao final e cole a origem depois dela.
4. Clique em **OK** para salvar.
5. Feche o Ollama pelo ícone na bandeja do sistema (**Quit Ollama**) e abra-o de novo, para que ele leia a variável.
6. Na página de configurações do Lerium, clique em **Testar conexão**.

Para verificar, use o botão **Testar conexão**: ele deve mostrar "Conectado" e a quantidade de modelos. Um teste com `curl` não serve, porque o `curl` não envia o cabeçalho `Origin` e é aceito mesmo sem a liberação.

### Se aparecer o erro HTTP 403

O Ollama está aberto, mas recusou o Lerium. Confira:

1. Se `OLLAMA_ORIGINS` contém exatamente `chrome-extension://mjkoppimccgajnabfeheglepjapkchlk`.
2. Se o Ollama foi **fechado totalmente** (ícone da bandeja → **Quit Ollama**) e aberto de novo depois de salvar a variável. Ele só lê a variável ao iniciar.
3. Se o ID mostrado em `chrome://extensions` é o mesmo acima. Se você carregou uma versão antiga do Lerium, remova-a e carregue `dist/` de novo.

Se a mensagem for "Não foi possível conectar ao Ollama", o problema é outro: o Ollama está fechado ou a porta está errada. Nesse caso, a liberação da origem não ajuda.

> **Não use `*` nem `chrome-extension://*`** em `OLLAMA_ORIGINS`: com eles, qualquer site ou extensão instalada poderia usar o seu Ollama.

## Scripts

| Script                 | Descrição                                               |
| ---------------------- | ------------------------------------------------------- |
| `npm run build`        | Gera a extensão em `dist/`.                             |
| `npm run typecheck`    | Verifica os tipos do TypeScript.                        |
| `npm run test`         | Executa os testes com Vitest.                           |
| `npm run lint`         | Executa ESLint e confere a formatação com Prettier.     |
| `npm run format`       | Formata os arquivos com Prettier.                       |
| `npm run icons`        | Gera os ícones da extensão.                             |
| `npm run extension-id` | Imprime a origem (com o ID fixo) para `OLLAMA_ORIGINS`. |
| `npm run test:e2e`     | Testes de ponta a ponta no Chromium (exige `npm run build` e a porta 11434 livre). |

## Documentação

- [docs/PLAN.md](docs/PLAN.md) — plano e roadmap do projeto.
- [docs/PROGRESS.md](docs/PROGRESS.md) — progresso por fase e tarefa.
- [AGENTS.md](AGENTS.md) — guia para agentes de IA que trabalham no repositório.

## Licença

[MIT](LICENSE).
