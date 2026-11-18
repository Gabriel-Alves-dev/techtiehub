# Techtie Hub — contexto para agentes

Escritório em pixel art (estilo game) onde cada **mesa é um projeto** e cada **personagem é um agente de IA** (Claude). O hub mostra o status dos agentes e roda o Claude na pasta de cada projeto via Claude Agent SDK. O usuário conversa com os agentes, responde perguntas e aprova permissões pelo navegador.

Leia `docs/ARQUITETURA.md` antes de mudanças estruturais.

## Mapa rápido

- **Duas partes:** o HUB (`server.js`) guarda tudo e serve a interface, mas nunca roda o Claude nem toca em pastas. O CONECTOR (`conector.js`), um por PC, executa tudo que depende do computador e recebe comandos do hub (`connectors.rpc`). `npm start` sobe o hub com um conector embutido.
- `server.js`: hub. Servidor HTTP nativo (sem framework): rotas, login, canal dos conectores (`/api/connector/*`) e hooks.
- `auth.js`: contas (scrypt), sessões, convites e tokens dos PCs, em `data/auth.json` (só hashes).
- `office.js`: um escritório por conta (`data/offices/<id>/`): estado, conversas, sessões, PCs conectados. **Nunca misture escritórios**: toda rota do navegador recebe o `Office` da conta logada.
- `community.js`: chat da comunidade (sala geral + conversas individuais entre contas), em `data/community.json`. Também guarda a **sala de voz** da equipe (`/api/community/voice/*`: entrar, sair e repassar a sinalização WebRTC pelo mesmo SSE; só em memória, o áudio não passa pelo hub). É o **único dado compartilhado entre contas**: fica no nível do hub, com SSE próprio (`/api/community/*`), e nunca passa pelo `Office`.
- **Equipe:** cada conta tem `teamId` (a de quem convidou; contas antigas entram na da dona). O chat e as tarefas só alcançam colegas de equipe, e só a dona (`isOwner`) visita escritórios (`/api/team/:id/office`, resumo só de leitura). A secretária fala com a de um colega por `team-send` (usa `delegate` no escritório dele).
- `tasks.js`: tarefas da equipe em `data/tasks.json` (nível do hub, como o chat). Visíveis a quem criou e a quem foi adicionado em `people`; delegar a um agente é sempre na mesa do próprio escritório (`delegateTask` no `server.js`). A secretária usa as ferramentas `listar_tarefas`, `criar_tarefa`, `atualizar_tarefa`, `delegar_tarefa` (`runner.js`).
- `monitor.js`: monitor de VPS. A VPS envia um resumo (`POST /api/monitor/report`, segredo próprio, só o hash em `data/monitor.json`) e o hub só recebe; salas `kind: 'servidor'` desenham um rack por host. Só a dona vê. Contrato em `docs/MONITOR-VPS.md`.
- `chats.js` / `session-store.js`: conversas e sessões do Claude, guardadas no hub.
- `runner.js`: roda no conector. Uma execução do Claude por mesa; `canUseTool` fica pendente até o usuário responder. Também cuida da memória do agente.
- `remote-store.js` / `local-ops.js`: no conector, as sessões lidas/gravadas no hub e as operações locais (pastas, seletor, VS Code).
- **Começar um pedido numa mesa:** sempre por `startRun` no `server.js` (chat, delegação e fila usam o mesmo caminho), e o que a mesa leva ao conector sai de `briefFor`.
- **Pacote do conector** (`GET /api/connector-download`, `zip.js`, `pacote/`, `preparar.js`): se um arquivo novo passar a ser usado pelo conector, inclua-o em `FILES` no `connector-files.js` (vale para o pacote e para a atualização automática). Os `.bat` precisam ser só ASCII e todo comando deve usar caminho completo ou o PATH (há PCs com `NoDefaultCurrentDirectoryInExePath`). PowerShell 5.1: desfaça arrays de JSON com `ForEach-Object { $_ }`.
- `git.js`: HEAD, remote e comparação de commits das pastas dos projetos.
- `public/app.js`: canvas do escritório, balões HTML, janelas flutuantes e diálogos. JS puro, sem build.
- `public/office3d.js` + `public/vendor/three.module.min.js`: vista 3D opcional (botão 🧊). O Three.js é **um arquivo único de terceiros (r170, MIT) servido como estático**, sem npm e sem build; o módulo só é baixado ao ligar o 3D (`import()` em `app.js`). Ele só desenha: o `app.js` manda um retrato da cena a cada quadro (`snapshot3D`), e posições, status e caminhos continuam na lógica 2D. Para atualizar o Three.js, troque o arquivo por outro build de arquivo único (a partir da r171 ele se divide em dois arquivos).
- `public/server3d.js`: a **sala de servidores em 3D** (racks com LEDs, ventoinhas e farol de status por VPS). O `office3d.js` chama `buildServerRoom`/`updateServerRoom` quando o retrato traz `server` (montado em `snapshot3D` no `app.js`, com `svLayout3D` para as fileiras de até 6 racks). O 2D (`drawRacks`) continua como alternativa com o 🧊 desligado. A casca de cada rack é uma malha só (`Builder` de `char/geometry.js`); texturas só são redesenhadas quando os dados mudam.
- `public/char/`: personagens 3D procedurais (sem modelos externos), usados pelo `office3d.js` (o boneco anterior continua como alternativa no botão 🧑). `config.js` normaliza os dados do agente (personalização explícita: `outfit`, `shirt`, `second`, `shoe`, `pants`, `skirt`, `tie`, também aceitos dentro de `look`; o que faltar sai do hash do id), `body.js`/`clothes.js` montam tronco, membros e os 5 conjuntos por perfis em seções, `hair.js`/`face.js` cabelo e rosto, `animations.js` anima o esqueleto de grupos (serve aos dois estilos) e `resources.js` guarda as geometrias com contagem de referências (**nunca descarte geometrias de personagem com `dispose()` direto: use `releaseCharacter`**). `quality.k` (1 no desktop, 0,6 no celular) reduz segmentos, mechas e contornos dos membros. Detalhes de roupa são fitas com espessura (`ribbon`) e pintura por vértice (`torsoPaint`), não placas; `seatFit` calcula o quadril sentado pela altura real do assento (`SEAT_BY_ACT` no `office3d.js`).
- `hub-hook.js` / `instalar-hook.js`: integração com o Claude Code do VS Code via hooks.
- `Dockerfile` / `docs/DEPLOY-COOLIFY.md`: o hub em servidor (Coolify, `hub.techtie.digital`). **O hub não pode depender de pacotes npm**: a imagem não roda `npm install`. Só o conector carrega o SDK do Claude (import dinâmico em `runner.js`).
- `data/`: dados locais do usuário. **Nunca versionar** (está no `.gitignore`).
- **Pasta por PC:** a pasta de uma mesa fica em `project.folders[envId]`. Nunca grave `project.folder` no hub (no front, `p.folder` é só a pasta do PC em uso, calculada em `resolveEnv`). A identidade do PC fica em `~/.techtie-hub/ambiente.json`, e a configuração do conector em `~/.techtie-hub/conector.json`.

## Convenções

- **Textos de interface, comentários e documentação em português do Brasil.**
- **Sem dependências novas sem necessidade.** Hoje só existe `@anthropic-ai/claude-agent-sdk` (npm, só no conector) e o Three.js em `public/vendor/` (arquivo estático, só no navegador). Servidor com `http` nativo, front em JS puro, sem bundler.
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
