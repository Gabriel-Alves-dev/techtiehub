# Arquitetura do Techtie Hub

Este documento explica como as peças do hub se conectam, para quem vai manter ou estender o projeto. Para instalar e usar, veja o [README](../README.md).

## Visão geral

O sistema tem duas partes: o **hub**, que é o escritório central (com contas), e um **conector** em cada PC, onde os agentes de fato trabalham.

```
┌──────────── navegador (qualquer PC) ────────────┐
│ public/app.js: escritório, balões, janelas      │
└───────▲────────────────────────────┬────────────┘
        │ SSE /api/events             │ fetch /api/...  (+ X-Hub-Env: PC escolhido)
┌───────┴────────────────────────────▼────────────────────────────────────┐
│ HUB  server.js (rotas, login) · auth.js (contas, tokens) · office.js    │
│  estado (data/state.json) · conversas (chats.js → data/chats/)          │
│  sessões do Claude (session-store.js → data/sessions/) · API · SSE      │
│  connectors.js: PCs conectados, comandos (RPC) e eventos                │
└───────▲──────────────────────────────▲──────────────────────────────────┘
        │ SSE /api/connector/stream    │ POST /api/connector/{reply,event,sessions/*}
        │ (comandos hub → PC)          │ (respostas, andamento, sessões)
┌───────┴──────────────────────────────┴──────────┐   ┌──────────────────┐
│ CONECTOR  conector.js   (um por PC)             │   │ hub-hook.js      │
│  runner.js ── Claude Agent SDK ── Claude Code   │   │ (Claude Code do  │
│  local-ops.js: pastas, seletor, Explorer/VS Code│   │  VS Code) ──────►│ POST /api/hook
│  git.js · remote-store.js (sessões no hub)      │   └──────────────────┘
└─────────────────────────────────────────────────┘
```

Os princípios:

- **Uma conta, um escritório.** Cada conta é dona de um escritório (`data/offices/<id>/`), carregado sob demanda como uma instância de `Office`. A conta guarda a lista `offices`, preparada para, no futuro, um escritório ter vários membros.
- **O hub é a única fonte da verdade.** O navegador e os conectores não guardam estado próprio. Toda ação vira uma chamada de API: o hub altera o estado, salva e transmite o resultado por SSE.
- **O hub nunca toca no PC de ninguém.** Pastas, git, seletor de pastas, VS Code e o próprio Claude rodam no conector. O hub só manda comandos. É isso que permite colocar o hub numa VPS.
- **A conexão sai do PC.** O conector abre um stream SSE com o hub e responde por HTTP. O PC não precisa de porta aberta nem de IP público, e funciona atrás de proxy e HTTPS. Não há dependência de WebSocket.
- **Modo local por padrão.** `npm start` sobe o hub com um **conector embutido** para o próprio PC (`HUB_SEM_CONECTOR=1` desliga). Para quem usa um computador só, nada muda.
- **Sem frameworks.** Servidor com `http` do Node, front em JavaScript puro. A única dependência é o `@anthropic-ai/claude-agent-sdk`.

## Contas e credenciais (`auth.js`)

`data/auth.json`:

```jsonc
{
  "users": [{ "id": "u…", "email": "…", "name": "…", "salt": "…", "hash": "…", "offices": ["o…"], "createdAt": 0 }],
  "sessions":   { "<sha256 do token>": { "userId": "u…", "exp": 0 } },   // login (cookie hub_sessao)
  "invites":    { "<sha256 do código>": { "by": "u…", "exp": 0 } },      // convite: 7 dias, uso único
  "connectors": { "<sha256 do token>": { "id": "…", "officeId": "o…", "envId": "e…", "name": "PC", "createdAt": 0, "lastSeen": 0 } }
}
```

- **Senhas** com `scrypt` (N=16384) e sal próprio, comparadas com `timingSafeEqual`. **Limite de tentativas** por IP: 8 erros bloqueiam por 15 min.
- **Sessão:** token aleatório no cookie `hub_sessao` (`HttpOnly`, `SameSite=Lax`, `Secure` sob HTTPS), 30 dias. No disco fica só o hash. Trocar a senha encerra as outras sessões.
- **Primeira conta** sem convite; as seguintes exigem um código de convite. Com o hub **exposto na rede** (`HUB_HOST` diferente de 127.0.0.1), a primeira conta exige o **código de instalação** (`HUB_SETUP_CODE`, ou um gerado e mostrado nos logs).
- **Limite de tentativas** por IP e por tipo (senha, cadastro/convite, pareamento): 8 erros bloqueiam por 15 min. O IP vem do `X-Forwarded-For` só com `HUB_TRUST_PROXY=1`, atrás do proxy.
- **Pareamento de PC:** `POST /api/pairing` gera um código (10 min, só em memória). O conector chama `POST /api/connector/pair` com o código e o id do PC (`X-Hub-Env`) e recebe um **token permanente ligado ao escritório e àquele PC**. Toda requisição do conector precisa do token **e** do mesmo id de PC. Remover o PC apaga o token e derruba a conexão.
- **Conector embutido:** no modo local, o hub emite um token para o PC local no escritório da primeira conta (`data/hub.json`) e grava `~/.techtie-hub/conector.json` (se apontar para este hub) para o `hub-hook.js`.
- **Migração:** a primeira conta criada recebe os arquivos que estavam soltos em `data/` (`state.json`, `chats/`, `sessions/`).

## Modelo de dados (por escritório)

`data/offices/<id>/state.json`:

```jsonc
{
  "rooms": [
    { "id": "r1", "name": "Escritório", "cols": 4, "floor": "madeira",
      "areas": ["copa", "reuniao", "descanso"] } // cols: mesas por fileira (2–8); areas: blocos da coluna lateral
  ],
  "projects": [
    {
      "id": "p1a2b3c4d",
      "roomId": "r1",                          // sala onde a mesa fica
      "name": "TechTie Flow",
      "description": "CRM da TechTie",
      "color": "#4f8cff",
      "folders": { "e1a2b3c4": "C:\\Users\\...\\techtie-flow" }, // pasta do projeto em cada PC (id do PC)
      "repo": "https://github.com/…/techtie-flow.git", // remote git, conferido ao vincular pasta em outro PC
      "agentId": "a5e6f7a8b"                  // agente sentado na mesa (ou null)
    }
  ],
  "agents": [
    {
      "id": "a5e6f7a8b",
      "name": "Bia",
      "role": "Designer",
      "shirt": "#3fbf7f", "hair": "#c0392b", "skin": "#f6d5b8", // aparência
      "status": "trabalhando",          // trabalhando | ocioso | bloqueado | concluido
      "message": "Editando app.js"      // texto do balão / última ação
    }
  ],
  "log": [ { "t": 1729700000000, "agentId": "...", "projectId": "...", "text": "[concluido] ..." } ],
  "environments": { "e1a2b3c4": { "name": "PC de casa", "lastSeen": 1729700000000 } } // PCs que já conectaram
}
```

Regras:

- **Uma mesa tem no máximo um agente.** Ao atribuir um agente a uma mesa, ele sai da mesa anterior (função `assign` em `server.js`).
- **Sempre existe pelo menos uma sala.** Dados antigos, sem salas, são migrados ao carregar (`load`): tudo vai para a sala "Escritório". Ao remover uma sala, as mesas dela vão para outra.
- **O histórico (`log`) guarda as 300 entradas mais recentes**, com a mais nova primeiro.
- **O id ganha o prefixo da coleção** (`p…` para mesas, `a…` para agentes, `r…` para salas) mais 8 caracteres hexadecimais.

`data/offices/<id>/chats/<projectId>.json` guarda a conversa de cada mesa (`chats.js`):

```jsonc
{
  "sessionId": "886991a4-…",     // sessão do Claude, retomada com `resume` (de data/sessions/)
  "sessionAppend": "…",          // texto acrescentado ao prompt de sistema desta sessão (a memória, se havia)
  "memory": "## Projeto …",      // memória do agente (Markdown) e quando foi atualizada (memoryAt)
  "lastCommit": "4ed7ca9…",      // HEAD da pasta quando o agente terminou o último pedido
  "lastEnv": "e1a2b3c4", "lastEnvName": "PC de casa", "lastFolder": "C:\\…", // onde rodou por último
  "entries": [
    { "t": 1729700000000, "role": "user", "text": "..." }, // role: user | assistant | tool | system
  ]
}
```

`data/offices/<id>/sessions/<sessionId>.jsonl` guarda as sessões completas do Claude, espelhadas pelo SDK (`session-store.js`).

O estado transmitido ao navegador tem dois campos que não são salvos:

```jsonc
"live": {                         // pedidos em andamento
  "<projectId>": {
    "running": true,
    "envId": "e1a2b3c4",          // PC onde está rodando
    "pending": {                  // null quando nada espera o usuário
      "id": "ff58bff7",
      "toolName": "Bash",         // ou "AskUserQuestion"
      "summary": "Rodando: npm test",
      "detail": "npm test",       // prévia: comando, diff, conteúdo do arquivo…
      "questions": [ ... ],       // só para AskUserQuestion
      "canRemember": true         // se dá para oferecer "Sempre permitir"
    }
  }
},
"connectors": { "e1a2b3c4": { "name": "PC de casa", "since": 1729700000000 } } // PCs conectados agora
```

## Hub (`server.js` + `office.js`)

- **Quem é quem:** `api()` decide pela rota. `/api/auth/*` (contas) não exige login; `/api/connector/*`, `/api/hook` e `/api/report` usam o token do PC; o resto exige o cookie de sessão e usa o escritório da conta (`getOffice(user.offices[0])`) em `officeApi()`.
- **`Office`** (`office.js`) reúne o que antes era global: `state`, `live`, `chats`, `sessions`, `connectors`, navegadores conectados, `save()`, `setStatus()`, `envFor/needEnv`, `handleHook`.
- **`save()`** grava `state.json` e transmite o estado completo, `snapshot()` = estado + `live` + `connectors`, para todos os navegadores. **Qualquer mudança de estado deve terminar em `save()`.**
- **`broadcast(event, data)`** transmite eventos SSE. O evento sem nome carrega o estado completo, e o evento `chat` carrega uma nova linha de conversa.
- **Rotas** são resolvidas a partir de `/api/<resource>/<id>/<action>`: `authApi()`, `connectorApi()` e `officeApi()`.
- **PC de cada pedido.** O navegador manda o cabeçalho `X-Hub-Env` com o PC escolhido. `envFor()` usa esse PC se estiver conectado, ou o único conectado. `needEnv()` responde 409 com uma mensagem amigável quando não há PC. Comandos para um pedido em andamento (`answer`, `stop`) vão para o PC onde ele está rodando (`live[id].envId`), venha de onde vier a resposta.
- **Comandos ao conector** (`connectors.rpc(envId, tipo, dados, timeout)`):

  | Comando | Para quê |
  |---|---|
  | `run` | Começar um pedido. Leva a mesa com a pasta daquele PC e a conversa atual |
  | `answer` · `stop` | Responder permissão/pergunta, interromper |
  | `memory` | Resumir a conversa na memória (Claude do PC) |
  | `git` | Situação do commit da pasta |
  | `folder-info` | Conferir se a pasta existe e qual o remote |
  | `pick-folder` · `open` | Seletor de pastas, abrir Explorer/VS Code |
  | `rename` | Renomear o PC |

- **Eventos do conector** (`POST /api/connector/event`, em ordem): `chat-push` (nova linha), `chat-update` (sessão, commit, memória…), `status` (agente da mesa) e `live` (andamento/pendências).
- **PC caiu.** Quando o stream de um conector fecha, os comandos pendentes falham e as mesas que rodavam nele ficam marcadas `offline` ("aguardando o PC voltar"). Se o PC não reconectar em 90 s (`GRACE_MS`), os pedidos são encerrados e a conversa ganha um aviso (`abandonEnv`). Se reconectar, o `live-sync` acerta tudo.
- **Parar sempre destrava:** se o PC não responde ou diz que já não tinha nada rodando (`wasRunning !== true`), o hub libera a mesa mesmo assim (`forceStop`).
- **Proteções:**
  - escuta só em `127.0.0.1` por padrão (`HUB_HOST` muda; na VPS, atrás do proxy HTTPS);
  - corpo das rotas sem login limitado (100 KB; pareamento 10 KB);
  - cabeçalhos: `X-Frame-Options: DENY` e CSP com `frame-ancestors 'none'` (contra clickjacking nos botões de permissão), `nosniff`, HSTS sob HTTPS;
  - recusa corpos que não sejam `application/json` (contra CSRF via `<form>`);
  - login obrigatório; cada conta só acessa o próprio escritório;
  - conectores, hooks e `report.js` usam o token do PC (`Authorization: Bearer`);
  - impede path traversal nos arquivos estáticos.
- **`handleHook(ev)`** converte eventos do Claude Code em status. A mesa é encontrada pela pasta **naquele PC** (`projectForPath(cwd, env)`). Eventos de sessões do próprio hub são ignorados, porque já chegam pelo conector.

## Conector (`conector.js`)

- **Identidade do PC** em `~/.techtie-hub/ambiente.json` (id + nome) e **configuração** em `~/.techtie-hub/conector.json` (endereço do hub + token do PC). `HUB_ENV_FILE` e `HUB_CONNECTOR_FILE` mudam esses caminhos, o que é útil para simular vários PCs numa máquina.
- **Linha de comando:** `node conector.js --hub <URL> --codigo XXXX-XXXX [--nome "PC"]`. Troca o código por um token (`pair`) e grava a configuração; das próximas vezes basta `node conector.js`. Se o hub recusar o token (PC removido), o conector avisa e tenta de novo só a cada minuto.
- **Conexão:** abre `GET /api/connector/stream` e lê os comandos (`event: cmd`). Se cair, reconecta sozinho com espera crescente e reenvia o andamento dos pedidos em curso (`runner.resendLive`).
- **Eventos em fila, sem perda:** `emit()` manda os eventos um de cada vez, na ordem, para a conversa não embaralhar. Se o hub estiver fora (redeploy, internet), a fila espera e reenvia com espera crescente, para que nenhum aviso se perca, principalmente o de fim de tarefa. Do andamento (`live`) só o mais recente de cada mesa fica na fila.
- **Sincronização ao reconectar:** a cada conexão, o conector manda `live-sync` com tudo o que roda naquele PC. O hub apaga as mesas que achava rodando ali e não estão na lista (`syncLive`), e restaura as que estão, inclusive pedidos de permissão pendentes.
- **No modo local**, o hub chama `conector.start()` no mesmo processo, com o token do PC local (ver Contas e credenciais).

### Atualização automática

A versão do conector é uma impressão digital do conteúdo dos arquivos listados em `connector-files.js` (`versionOf`, ignorando CRLF/LF). O hub calcula a dele ao subir (`CONNECTOR_VERSION`), e o conector manda a sua no stream (`?v=`).

Quando as versões são diferentes:

1. O hub escreve `event: update` no stream.
2. O conector (`selfUpdate`) espera não haver tarefas rodando e baixa `GET /api/connector/update` (arquivos + `package.json`).
3. Ele grava por cima (só nomes `*.js` sem caminho) e sai com o código 75.
4. O `Iniciar Techtie.bat` roda `npm install` e reabre o conector.

Proteções:
- Não se atualiza dentro de um repositório git (`.git` na pasta), nem no conector embutido.
- Não tenta duas vezes a mesma versão (`.atualizado-para`).
- A interface marca PCs com `connectors[env].version !== connectorVersion` (`outdated`). Sem versão = conector muito antigo, que precisa ser baixado de novo.

### Pacote baixável (Windows)

`GET /api/connector-download` (logado) monta na hora um `.zip` (`zip.js`, formato ZIP com deflate do `zlib`, sem dependências) com os arquivos do conector, os extras de `pacote/` (com quebras de linha CRLF), um `package.json` mínimo (só o SDK do Claude) e `conector-config.json` com o endereço do hub e um **código de pareamento de 24 h**. Os códigos ficam guardados (só o hash) em `auth.json`, para sobreviver a um redeploy.

No PC, `Iniciar Techtie.bat`:

1. Usa o Node do sistema ou baixa um portátil para `runtime/` (`baixar-node.ps1`).
2. Roda `npm install` na primeira vez.
3. Roda `preparar.js`:
   - troca o código por um token (e apaga o código do arquivo);
   - confere o login do Claude com o `claude.exe` que vem no SDK (`auth status`) e, se faltar, chama `auth login`;
   - na primeira vez, oferece atalho na Inicialização do Windows e o hook do VS Code.
4. Abre o `conector.js`.

## Runner (`runner.js`, dentro do conector)

Executa o Claude por mesa usando `query()` do Claude Agent SDK. O SDK sobe o processo do Claude Code, que usa o login do Claude **daquele PC**. O runner recebe uma cópia da conversa a cada pedido e manda as novidades ao hub pelos callbacks `hub.push / update / status / live`.

O fluxo de um pedido:

1. **O usuário manda um pedido.** `POST /api/projects/:id/chat` → o hub reserva a mesa em `live` e manda o comando `run` ao PC escolhido → `runner.send(project, text, chat)`.
2. **O runner inicia o Claude** com `query({ prompt, options: { cwd, resume, sessionStore, systemPrompt, abortController, canUseTool } })`.
3. **As mensagens do SDK viram conversa e status** (`handle`):
   - `system/init` → guarda o `session_id`. A próxima mensagem continua a mesma conversa (`resume`).
   - `assistant` → texto vira linha de conversa; `tool_use` vira linha "🔧 …" e atualiza o balão.
   - `result` → status **concluído**, ou **bloqueado** em caso de erro.
4. **Permissões e perguntas ficam pendentes.** O SDK chama `canUseTool` sempre que o Claude precisa de permissão ou chama a ferramenta `AskUserQuestion`. O runner devolve uma **Promise que fica pendente** e avisa o hub (`live`). O agente fica **bloqueado** e o navegador mostra o cartão.
5. **A resposta do usuário libera o Claude.** `POST /api/projects/:id/answer` → comando `answer` → a Promise é resolvida:
   - **permitir** → `{ behavior: "allow", updatedInput: input }`
   - **sempre permitir** → o mesmo, mais `updatedPermissions` com as sugestões do SDK (destino `localSettings`)
   - **negar** → `{ behavior: "deny", message }`
   - **pergunta** → `updatedInput: { questions, answers }`. As respostas chegam **na ordem das perguntas** e o runner monta o mapa `texto da pergunta → resposta`. Usar o índice evita problemas de codificação com acentos.
6. **Parar** chama `abort()` no `AbortController`. O pedido pendente é negado automaticamente.

**Modo de permissão (por mesa).** `project.permissionMode` (`''`, `acceptEdits`, `auto`, `bypassPermissions`) vai no `run` e vira `permissionMode` do SDK (`'default'` quando vazio; `bypassPermissions` exige `allowDangerouslySkipPermissions`). O `AskUserQuestion` sempre passa pelo `canUseTool`, em qualquer modo (testado), então as perguntas de decisão continuam chegando. Como o SDK só aplica o modo no início, uma troca no meio do pedido vai ao conector (`set-mode`), e o runner passa a aprovar sozinho o que o novo modo libera (`autoAllowed`), inclusive o pedido em aberto.

**Compactação automática da sessão (como o `/clear` do Claude Code).** Toda sessão usa `resume`, então ela nunca termina sozinha: cada pedido novo reenvia a conversa inteira, e sem limpeza isso cresce até esgotar a cota de uso rápido, mesmo em tarefas simples. Depois de cada pedido bem-sucedido, o `handle()` guarda `run.contextTokens` a partir do `usage` do `result` (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`: o que seria reenviado no próximo pedido). Se passar de `AUTO_CLEAR_TOKENS` (padrão 100000, ajustável por `HUB_AUTO_CLEAR_TOKENS` só para teste), o runner chama o mesmo `refreshMemory` do botão "Nova conversa" (atualiza a memória incrementalmente a partir do que mudou) e zera `sessionId`: o próximo pedido começa uma sessão nova, já com a memória. Uma mensagem de sistema ("🧹 Conversa compactada sozinha…") avisa no chat da mesa.

**Em qual PC o pedido roda.** As ações da mesa (chat, relatório, memória) usam `envForDesk(o, project, envFor(req))`: o PC escolhido no navegador, se a mesa tiver pasta nele; senão, o primeiro PC conectado que tenha. Assim o celular (que não escolhe PC) usa o PC do escritório. No front, `resolveEnv` calcula o mesmo em `p.runEnv`, que libera o chat e mostra o aviso "🛰 roda no PC X".

**Barra de limite de uso.** Mostra, no topo, a conta Claude do PC em uso e o quanto já foi gasto da sessão de 5h e da semana — os mesmos números da tela "Account & Usage" do Claude Code.
- **No conector**, `Runner.checkUsage()` (`runner.js`) abre uma sessão descartável do SDK em modo de entrada contínua (só esse modo permite chamar métodos de controle), espera o `system/init` (não gasta chamada de modelo) e chama `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`; depois interrompe e fecha a sessão sem nunca mandar uma mensagem de usuário — não consome tokens nem a cota de uso. Tem um timeout de 15 s (sem login, sem rede ou um CLI que não inicia nunca travaria o loop periódico). Lê `rate_limits.limits`, agrupando por `group` (`'session'` = 5h, `'weekly'` = 7 dias) e preferindo a linha `is_active` de cada grupo.
- O `conector.js` chama isso ao conectar e a cada 10 minutos (só quando nenhuma mesa está rodando) e manda `emit('usage', { usage })` ao hub. Durante o trabalho normal, `runner.handle()` também escuta o evento `rate_limit_event` do SDK (de graça, sem chamada extra) e atualiza a mesma informação em tempo real.
- **No hub**, o evento chega em `op === 'event', type === 'usage'` (`server.js`) e vira `office.setUsage(envId, usage)`, guardado em `Office.usage[envId]` (não é salvo em disco — muda o tempo todo) e exposto no `snapshot()`.
- **No front**, `renderUsageBar()` (`public/app.js`) lê `state.usage[state.env.id]` — a barra reflete sempre o PC em uso no momento (o mesmo que define onde os pedidos rodam). Fica escondida quando não há dado (conta sem limites de plano, ex. API key, ou ainda não chegou a primeira leitura).

**Variáveis do escritório.** `state.vars = [{ id, name, value (criptografado), description, projects }]`, CRUD em `/api/vars` (o GET devolve o valor mascarado).
- **Nomes reservados:** PATH, HOME, `ANTHROPIC_*`, `CLAUDE_*` e outros são recusados (`VAR_RESERVED`), para não quebrar o sistema nem o login do Claude.
- **Como chegam ao agente:** o `briefFor` manda `env: varsFor(id)` e o runner passa `env: { ...process.env, ...project.env }` ao SDK. O contexto da mesa lista só os nomes e descrições (`varsContext`).
- **Nos MCPs:** `mcpConfig` troca `${NOME}` pelo valor, na URL, nos cabeçalhos, nos argumentos e nas variáveis.

**Celular.** Só CSS (`@media (max-width: 760px)` no fim do `style.css`): os botões do topo viram uma faixa que rola, e as janelas e diálogos ocupam a tela inteira.

**Secretária, memória do escritório e fila.**

- **Memória do escritório e relatórios.** `state.officeMemory` = `{ general, projects: { id: { text, at, agent } } }`, preenchido por "Enviar para o escritório" (copia a memória da mesa). `state.reports[dia][projectId]` traz os relatórios do dia: o conector resume as entradas daquele dia com uma chamada curta, sem ferramentas (`dailyReport`). O dia segue o fuso `HUB_TZ` (padrão America/Sao_Paulo), e os relatórios ficam por 30 dias.
- **Mesa da secretária** (`project.role = 'secretaria'`):
  - **Sem pasta:** não precisa de pasta, e o conector usa `~/.techtie-hub/secretaria` (`folder: '@secretaria'`).
  - **Contexto a cada pedido:** o `briefFor` manda `office = { role: 'secretaria', context: secretaryContext() }` (instruções, mesas, memória do escritório, relatórios e recados de hoje), que entra no `append` do prompt de sistema.
  - **Ferramentas próprias:** além das comuns (abaixo), `ler_mesa`, `delegar`, `ler_relatorios` e `anotar_memoria_escritorio`.
- **Todas as mesas** recebem `office = { role: 'mesa', context: deskContext(id) }`: quem é o agente, a mesa, a secretária, as outras mesas, e a orientação de usar as ferramentas em vez de procurar arquivos no projeto.
- **Ferramentas do escritório** (`officeTools` no `runner.js`): um servidor MCP em processo (`createSdkMcpServer`, nome `escritorio`).
  - **Comuns:** `listar_mesas` e `ler_memoria_escritorio`.
  - **Das mesas:** `enviar_relatorio` (grava `state.reports[dia][id]`), `salvar_memoria_projeto` (memória da mesa e, por padrão, do escritório) e `avisar_secretaria` (`state.inbox`, os 200 mais recentes).
  - **Como funcionam:** chamam `/api/connector/office/*` com o token do PC e `mesa_id`. O hub recusa as ferramentas só da secretária vindas de outras mesas. São aprovadas automaticamente, porque só mexem no hub.
- **Delegar** (`delegate` no `server.js`):
  - acha a mesa pelo nome do projeto ou do agente (`findDesk`, sem acento e sem maiúscula);
  - escolhe um PC conectado onde a mesa tem pasta, de preferência o da secretária (`envForDesk`);
  - inicia o pedido com `startRun` (o mesmo caminho do chat), com o texto marcado "📨 Demanda da secretária".
- **Fila:** se a mesa estiver ocupada, ou sem PC com a pasta, a demanda entra em `state.queue[projectId]`. A fila anda quando a mesa fica livre (`Office.idle` → `onIdle` → `processQueue`) ou quando um PC conecta.

**Servidores MCP do hub.** Ficam em `state.mcpServers` do escritório. A URL, os cabeçalhos e as variáveis de ambiente são criptografados com AES-256-GCM (`secrets.js`, chave `HUB_SECRET_KEY` ou `data/secret.key`). A API devolve sempre mascarado (`mcpPublic`), e um valor "••••" no PATCH significa manter o atual.

- **No pedido:** o comando `run` leva `mcpServers` da mesa (`mcpFor`: ligados e que valem para ela), já abertos, e o runner passa ao SDK. Eles se somam aos MCPs que o Claude Code do PC já tiver.
- **Testar** (`mcp-test`, `mcp-local.js`): abre uma `query` em modo streaming que nunca envia mensagem, consulta `mcpServerStatus()` e fecha. Não há chamada ao modelo.
- **Importar** (`mcp-scan`): o conector lê `~/.claude.json` (usuário e projetos) e os `.mcp.json` das pastas das mesas. O resultado, com segredos, fica só na memória do hub por 10 min (`mcpScans`), e o navegador recebe a versão mascarada e escolhe pelo índice.

**Imagens.** O navegador reduz a imagem (lado maior até 1568 px; PNG, ou JPEG se ficar grande) e manda em base64 no `POST …/chat`. O hub valida tipo, quantidade (até 6) e tamanho (5 MB cada) e guarda em `uploads/`, para o histórico (a entrada da conversa leva `images: [nomes]`, servidos em `/api/files/:nome`). Depois repassa as imagens no comando `run`. O runner manda o pedido como mensagem da API do Claude (`prompt` iterável com blocos `image` + `text`).

**Modelo e fase.** O hub manda `model` e `effort` do agente da mesa no comando `run` (vazio = padrão do Claude Code do PC). O runner guarda o modelo real informado no `system/init` (`lastModel`) e acompanha a **fase**: `thinking` depois do pedido e de cada resposta de ferramenta, e `tool` enquanto espera uma ferramenta. Ela segue no `live` com `age` (ms). O hub converte em `since` no relógio dele e manda `now` no estado, para o navegador acertar o cronômetro (`renderActivity`) mesmo com relógios diferentes.

### Continuidade: sessão completa, memória e commit

- **Sessão completa no hub.** Toda `query()` recebe `sessionStore` (`remote-store.js`): o SDK manda cada linha da sessão ao hub, que guarda em `data/sessions/<sessionId>.jsonl` (`session-store.js`). Ao retomar (`resume`), o SDK carrega a sessão do hub. Por isso a conversa continua em qualquer PC conectado e em qualquer pasta. A chave é só o `sessionId`, porque o `projectKey` do SDK depende do cwd. Sessões antigas, só no disco local do Claude Code, são importadas na primeira vez (`importSessionToStore`). Esse recurso do SDK ainda é experimental (*alpha*), e a memória é o plano B.
- **Prompt de sistema montado na hora.** `systemPrompt: { type: 'preset', preset: 'claude_code', append, snapshot: false }`. Com `snapshot: true` (o padrão), o prompt, que inclui a pasta de trabalho e o git, ficaria gravado na sessão com os dados do PC antigo.
- **Aviso de mudança.** Se a sessão rodou por último em outro PC ou pasta (`lastEnv`/`lastFolder`), o pedido ganha uma nota no início: onde está agora, onde estava, e que caminhos antigos podem não valer mais.
- **Memória.** `refreshMemory` junta a memória anterior com as entradas da conversa desde `memoryAt`, numa chamada curta ao Claude sem ferramentas, sem configurações do usuário e sem salvar sessão. Roda na **Nova conversa**, no botão *Atualizar com a conversa* e no plano B. Sessões novas recebem a memória pelo `append` do prompt de sistema.
- **Plano B.** Se a retomada falhar antes de o Claude responder (`resume-failed`), o runner atualiza a memória e começa uma sessão nova com ela.
- **Commit.** Ao fim de cada pedido bem-sucedido, grava `lastCommit` (HEAD da pasta). `git.status` compara esse commit com o da pasta atual: `missing` (falta pull), `diverged`, `ahead` ou `ok`.

## Hook (`hub-hook.js`)

O Claude Code executa o hook a cada evento configurado (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Notification`, `Stop`, `SessionEnd`), passando um JSON no stdin. O script:

- **Lê o hub e o token** em `~/.techtie-hub/conector.json` e a **identidade do PC** em `ambiente.json`. Com vários PCs, a mesma pasta pode existir em computadores diferentes, por isso o PC vai junto.
- **Resume o evento**, tirando conteúdo de arquivos e textos grandes, e envia para `POST /api/hook` com timeout de 1,5 s.
- **Sempre termina com código 0**, mesmo com o hub desligado, para nunca atrapalhar o Claude Code.

O `instalar-hook.js` registra o hook em `~/.claude/settings.json`. Ele é idempotente: remove versões antigas do mesmo hook antes de adicionar.

## Front-end (`public/app.js`)

O arquivo é dividido em seções comentadas:

| Seção | O que faz |
|---|---|
| **Login** | `boot()` consulta `/api/auth/status`: sem conta logada mostra a tela de entrada (`showLogin`: criar a primeira conta, entrar ou cadastrar com convite); com conta, conecta o SSE. Qualquer 401 da API volta para a tela de entrada. |
| **PC ativo** | `resolveEnv()` escolhe o PC que executa os pedidos deste navegador: o escolhido na janela de PCs (`localStorage`), se estiver conectado, ou o único conectado. Define `state.env` e `p.folder` (pasta da mesa nesse PC). `api()` manda o cabeçalho `X-Hub-Env`. |
| **Salas** | Só a sala exibida (`roomId`, lembrada no `localStorage`) é desenhada. `roomProjects()` lista as mesas dela, e `visibleAgents()` lista os agentes com mesa nela, mais os agentes sem mesa, que ficam no lounge da primeira sala. Trocar de sala (`switchRoom`) recria os personagens já sentados. |
| **Layout do mundo** | Geometria em "pixels de mundo" (tile de 16 px), multiplicada por `SCALE` na tela. Fileiras de `room.cols` mesas (5×5 tiles cada), áreas especiais à direita, parede com janelas no topo. A sala cresce conforme o número de mesas. |
| **Áreas especiais** | A coluna à direita das mesas é uma pilha de blocos (`world.blocks`): copa, reunião e descanso, conforme `room.areas`. Cada bloco define lugares (`areaSpots`) com uma atividade (`act`: cafe, reuniao, sofa, puff, arcade) e uma direção. Os agentes ociosos sorteiam um lugar livre a cada 10–30 s, e `drawLabels` desenha a atividade. Os lugares ficam em linhas sem móveis, porque o agente chega andando na horizontal a partir do corredor. |
| **Zoom e arrasto** | `SCALE` automático (cabe na tela) ou fixo de 1 a 6 (`setZoom`, em passos inteiros para a pixel art ficar nítida), mantendo parado o ponto sob o mouse. Arrastar o canvas rola o escritório; o clique é ignorado depois de um arrasto. |
| **Caminhos** | Os personagens andam pelo corredor horizontal de cada fileira e pelo corredor vertical à direita das mesas (`route`), para não atravessar mesas. |
| **Simulação** (`update`) | Com mesa e status ≠ ocioso → cadeira da mesa; senão → um lugar livre das áreas especiais (`rt.atSpot` quando chega). Move a velocidade constante. |
| **Desenho** (`draw…`) | Tudo é desenhado com retângulos no canvas, sem imagens. Textos são desenhados em coordenadas de tela para ficarem nítidos. |
| **Balões** (`updateBubbles`) | Elementos HTML posicionados a cada quadro sobre o canvas. O conteúdo vem de `bubbleFor(agent)` e só é reescrito quando muda. |
| **Janelas flutuantes** (`openWindow`) | Arrastar, redimensionar, minimizar, foco. Posição e tamanho ficam no `localStorage`. Janelas: mesa (conversa), memória, PCs, equipe, atividade. |
| **Janela da mesa** | Conversa, avisos (`renderBanner`: sem PC, pasta só em outro PC, commit faltando, rodando em outro PC), cartão pendente e caixa de texto. **É atualizada por partes**, nunca recriada, para não apagar o que o usuário está digitando. |
| **Diálogos** | `<dialog>` nativo para criar e editar mesas, agentes e salas. |

O ciclo de atualização:

1. **Chega um estado novo pelo SSE.** `applyState` resolve o PC ativo, recalcula a geometria, cria ou remove personagens e chama `refreshUI()`, que atualiza estatísticas, abas e janelas abertas.
2. **Chega um evento `chat`.** `onChatEvent` acrescenta a mensagem na janela daquela mesa, se estiver aberta.
3. **A cada quadro** (`requestAnimationFrame`), rodam `update` → `draw` → `updateBubbles`.

## Como estender

- **Novo status de agente:** adicione em `STATUSES` (`server.js`), `STATUS` (`app.js`), na classe `.st-<status>` (`style.css`) e trate em `bubbleFor` e no desenho do monitor (`drawDesk`).
- **Nova rota de API:** adicione um bloco em `api()`. Se mudar o estado, termine com `save()`. Se precisar do PC do usuário, crie um comando em `handlers` no `conector.js` e chame com `connectors.rpc(needEnv(req), …)`.
- **Novo móvel ou decoração:** desenhe nas funções `drawCopa`, `drawMeeting`, `drawRest` ou `drawRoom` com `rect()`. As coordenadas são em pixels de mundo.
- **Opções do agente** (modelo, modo de permissão, prompt de sistema): ficam em `runner.runQuery`, nas `options` do `query()`. Veja a [referência do SDK](https://code.claude.com/docs/en/agent-sdk/typescript).

## Rodar como servidor (Docker)

O `Dockerfile` gera a imagem **só do hub** (`HUB_SEM_CONECTOR=1`). O hub não usa nenhuma dependência npm, porque o SDK do Claude só é carregado pelo conector, então a imagem não roda `npm install`. Os dados ficam no volume `/data`. Passo a passo no Coolify: [DEPLOY-COOLIFY.md](DEPLOY-COOLIFY.md).

```bash
docker build -t techtie-hub .
docker run -p 4321:4321 -v techtie-hub-data:/data -e HUB_PUBLIC_URL=http://localhost:4321 techtie-hub
```

## Testar

Não há testes automatizados ainda. Para testar sem mexer nos seus dados, suba uma instância separada. Com outros arquivos de identidade, cada processo vira "outro PC":

```bash
# hub + conector embutido ("PC A")
PORT=4399 HUB_DATA=/tmp/t/data/state.json HUB_ENV_FILE=/tmp/t/a.json HUB_CONNECTOR_FILE=/tmp/t/a-con.json node server.js
# crie a conta em http://localhost:4399; depois, em PC → Conectar um PC, gere um código para o segundo PC ("PC B")
HUB_ENV_FILE=/tmp/t/b.json HUB_CONNECTOR_FILE=/tmp/t/b-con.json node conector.js --hub http://localhost:4399 --codigo XXXX-XXXX --nome "PC B"
```

Depois:

- **Para verificar a API**, faça login (`POST /api/auth/login`) guardando o cookie (`curl -c/-b`) e use `-H "Content-Type: application/json"` e `-H "X-Hub-Env: <id do PC>"`.
- **Para simular eventos do Claude Code**, envie um JSON para o hook com as mesmas variáveis do PC: `echo '{"hook_event_name":"Stop","cwd":"..."}' | HUB_ENV_FILE=... HUB_CONNECTOR_FILE=... node hub-hook.js`.
