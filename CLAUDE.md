# Techtie Hub — contexto para agentes

Escritório em pixel art (estilo game) onde cada **mesa é um projeto** e cada **personagem é um agente de IA** (Claude). O hub mostra o status dos agentes e roda o Claude na pasta de cada projeto via Claude Agent SDK. O usuário conversa com os agentes, responde perguntas e aprova permissões pelo navegador.

Leia `docs/ARQUITETURA.md` antes de mudanças estruturais.

## Mapa rápido

- **Duas partes:** o HUB (`server.js`) guarda tudo e serve a interface, mas nunca roda o Claude nem toca em pastas. O CONECTOR (`conector.js`), um por PC, executa tudo que depende do computador e recebe comandos do hub (`connectors.rpc`). `npm start` sobe o hub com um conector embutido.
- `server.js`: hub. Servidor HTTP nativo (sem framework): rotas, login, canal dos conectores (`/api/connector/*`) e hooks.
- `auth.js`: contas (scrypt), sessões, convites e tokens dos PCs, em `data/auth.json` (só hashes).
- `office.js`: um escritório por conta (`data/offices/<id>/`): estado, conversas, sessões, PCs conectados. **Nunca misture escritórios**: toda rota do navegador recebe o `Office` da conta logada.
- `chats.js` / `session-store.js`: conversas e sessões do Claude, guardadas no hub.
- `runner.js`: roda no conector. Uma execução do Claude por mesa; `canUseTool` fica pendente até o usuário responder. Também cuida da memória do agente.
- `remote-store.js` / `local-ops.js`: no conector, as sessões lidas/gravadas no hub e as operações locais (pastas, seletor, VS Code).
- **Pacote do conector** (`GET /api/connector-download`, `zip.js`, `pacote/`, `preparar.js`): se um arquivo novo passar a ser usado pelo conector, inclua-o em `PACKAGE_FILES` no `server.js`. Os `.bat` precisam ser só ASCII e todo comando deve usar caminho completo ou o PATH (há PCs com `NoDefaultCurrentDirectoryInExePath`). PowerShell 5.1: desfaça arrays de JSON com `ForEach-Object { $_ }`.
- `git.js`: HEAD, remote e comparação de commits das pastas dos projetos.
- `public/app.js`: canvas do escritório, balões HTML, janelas flutuantes e diálogos. JS puro, sem build.
- `hub-hook.js` / `instalar-hook.js`: integração com o Claude Code do VS Code via hooks.
- `Dockerfile` / `docs/DEPLOY-COOLIFY.md`: o hub em servidor (Coolify, `hub.techtie.digital`). **O hub não pode depender de pacotes npm**: a imagem não roda `npm install`. Só o conector carrega o SDK do Claude (import dinâmico em `runner.js`).
- `data/`: dados locais do usuário. **Nunca versionar** (está no `.gitignore`).
- **Pasta por PC:** a pasta de uma mesa fica em `project.folders[envId]`. Nunca grave `project.folder` no hub (no front, `p.folder` é só a pasta do PC em uso, calculada em `resolveEnv`). A identidade do PC fica em `~/.techtie-hub/ambiente.json`, e a configuração do conector em `~/.techtie-hub/conector.json`.

## Convenções

- **Textos de interface, comentários e documentação em português do Brasil.**
- **Sem dependências novas sem necessidade.** Hoje só existe `@anthropic-ai/claude-agent-sdk`. Servidor com `http` nativo, front em JS puro, sem bundler.
- **Toda mudança de estado no servidor termina em `save()`.** Ela salva e transmite o estado por SSE.
- **A janela da mesa no front é atualizada por partes**, nunca recriada inteira, para não apagar o que o usuário digita.
- **Segurança:**
  - o servidor escuta só em `127.0.0.1`;
  - requisições não-GET exigem `Content-Type: application/json`;
  - rotas do escritório exigem login; conectores/hooks usam o token do PC;
  - mantenha essas proteções, porque a API abre programas e roda agentes.
- **Comentários curtos explicando o porquê**, no estilo do código existente.

## Rodar e testar

- `npm start` sobe em <http://localhost:4321>, e `iniciar.bat` faz o mesmo no Windows.
- **Teste com login:** crie a conta via `POST /api/auth/signup` (a primeira não precisa de convite) e guarde o cookie `hub_sessao`.
- **Instância de teste isolada:** `PORT=4399 HUB_DATA=/tmp/t/data/state.json HUB_ENV_FILE=/tmp/t/a.json HUB_CONNECTOR_FILE=/tmp/t/a-con.json node server.js`. Sempre isole `HUB_ENV_FILE` e `HUB_CONNECTOR_FILE`, senão o teste grava em `~/.techtie-hub/` do usuário. Um segundo PC: `node conector.js` com outros arquivos (veja docs/ARQUITETURA.md → Testar). Não use os dados reais do usuário em testes.
- **Checagem de sintaxe:** `for f in *.js public/app.js; do node --check "$f"; done`.
- Não há testes automatizados. Valide pela API (`curl`) e abrindo o navegador.
