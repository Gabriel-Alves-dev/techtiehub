# Techtie Hub — contexto para agentes

Escritório em pixel art (estilo game) onde cada **mesa é um projeto** e cada **personagem é um agente de IA** (Claude). O hub mostra o status dos agentes e roda o Claude na pasta de cada projeto via Claude Agent SDK. O usuário conversa com os agentes, responde perguntas e aprova permissões pelo navegador.

Leia `docs/ARQUITETURA.md` antes de mudanças estruturais.

## Mapa rápido

- `server.js`: servidor HTTP nativo (sem framework), API REST, SSE e hooks. O estado fica em memória e é salvo em `data/state.json`.
- `runner.js`: uma execução do Claude por mesa. `canUseTool` fica pendente até o usuário responder. Também cuida da memória do agente.
- `session-store.js`: espelha as sessões do Claude em `data/sessions/`, para continuar a conversa em outro PC.
- `git.js`: HEAD, remote e comparação de commits das pastas dos projetos.
- `public/app.js`: canvas do escritório, balões HTML, janelas flutuantes e diálogos. JS puro, sem build.
- `hub-hook.js` / `instalar-hook.js`: integração com o Claude Code do VS Code via hooks.
- `data/`: dados locais do usuário. **Nunca versionar** (está no `.gitignore`).
- **Pasta por PC:** a pasta de uma mesa fica em `project.folders[envId]` e no servidor se lê com `folderOf(p)`. Nunca grave `project.folder`. A identidade do PC fica em `~/.techtie-hub/ambiente.json`.

## Convenções

- **Textos de interface, comentários e documentação em português do Brasil.**
- **Sem dependências novas sem necessidade.** Hoje só existe `@anthropic-ai/claude-agent-sdk`. Servidor com `http` nativo, front em JS puro, sem bundler.
- **Toda mudança de estado no servidor termina em `save()`.** Ela salva e transmite o estado por SSE.
- **A janela da mesa no front é atualizada por partes**, nunca recriada inteira, para não apagar o que o usuário digita.
- **Segurança:**
  - o servidor escuta só em `127.0.0.1`;
  - requisições não-GET exigem `Content-Type: application/json`;
  - mantenha essas proteções, porque a API abre programas e roda agentes.
- **Comentários curtos explicando o porquê**, no estilo do código existente.

## Rodar e testar

- `npm start` sobe em <http://localhost:4321>, e `iniciar.bat` faz o mesmo no Windows.
- **Instância de teste isolada:** `PORT=4399 HUB_DATA=/caminho/temp/state.json HUB_ENV_FILE=/caminho/temp/ambiente.json node server.js`. Com outro `HUB_ENV_FILE`, a instância se comporta como outro PC. Não use os dados reais do usuário em testes.
- **Checagem de sintaxe:** `for f in server.js runner.js hub-hook.js public/app.js; do node --check "$f"; done`.
- Não há testes automatizados. Valide pela API (`curl`) e abrindo o navegador.
