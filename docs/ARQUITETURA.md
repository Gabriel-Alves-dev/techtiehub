# Arquitetura do Techtie Hub

Este documento explica como as peças do hub se conectam, para quem vai manter ou estender o projeto. Para instalar e usar, veja o [README](../README.md).

## Visão geral

```
                ┌─────────────────────────── navegador ───────────────────────────┐
                │ public/app.js                                                    │
                │  canvas (escritório) · balões (HTML) · janelas flutuantes        │
                └──────▲───────────────────────────────┬──────────────────────────┘
                       │ SSE /api/events               │ fetch /api/...
                       │ (estado + mensagens de chat)  │ (ações do usuário)
                ┌──────┴───────────────────────────────▼──────────────────────────┐
                │ server.js  (http nativo do Node, 127.0.0.1:4321)                 │
                │  estado em memória ⇄ data/state.json · API · SSE · estáticos     │
                │                                                                  │
                │  runner.js ── Claude Agent SDK ── processo do Claude Code        │
                │   1 execução por mesa, cwd = pasta da mesa                       │
                │   canUseTool fica pendente até o usuário responder no navegador  │
                └──────▲──────────────────────────────────────────────────────────┘
                       │ POST /api/hook
                ┌──────┴───────────┐
                │ hub-hook.js      │  ← chamado pelo Claude Code do VS Code / terminal
                └──────────────────┘    (hooks configurados por instalar-hook.js)
```

Os princípios:

- **O servidor é a única fonte da verdade.** O navegador não guarda estado próprio, só recebe e desenha. Toda ação do usuário vira uma chamada de API. O servidor altera o estado, salva e transmite o resultado por SSE para todas as abas abertas.
- **Sem frameworks.** O servidor usa só o `http` do Node e o front é JavaScript puro. A única dependência é o `@anthropic-ai/claude-agent-sdk`.
- **Tudo local.** O estado fica em arquivos JSON em `data/`.

## Modelo de dados

`data/state.json`:

```jsonc
{
  "projects": [
    {
      "id": "p1a2b3c4d",
      "name": "TechTie Flow",
      "description": "CRM da TechTie",
      "color": "#4f8cff",
      "folder": "C:\\Users\\...\\techtie-flow", // pasta do projeto (opcional)
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
  "log": [ { "t": 1729700000000, "agentId": "...", "projectId": "...", "text": "[concluido] ..." } ]
}
```

Regras:

- **Uma mesa tem no máximo um agente.** Ao atribuir um agente a uma mesa, ele sai da mesa anterior (função `assign` em `server.js`).
- **O histórico (`log`) guarda as 300 entradas mais recentes**, com a mais nova primeiro.
- **O id ganha o prefixo da coleção** (`p…` para mesas, `a…` para agentes) mais 8 caracteres hexadecimais.

`data/chats/<projectId>.json` guarda a conversa de cada mesa:

```jsonc
{
  "sessionId": "886991a4-…", // sessão do Claude Code, usada para continuar a conversa (resume)
  "entries": [
    { "t": 1729700000000, "role": "user", "text": "..." }, // role: user | assistant | tool | system
  ]
}
```

O estado transmitido ao navegador tem um campo a mais, **`live`**, que não é salvo em disco. Ele descreve o que está rodando agora:

```jsonc
"live": {
  "<projectId>": {
    "running": true,
    "pending": {                  // null quando nada espera o usuário
      "id": "ff58bff7",
      "toolName": "Bash",         // ou "AskUserQuestion"
      "summary": "Rodando: npm test",
      "detail": "npm test",       // prévia: comando, diff, conteúdo do arquivo…
      "questions": [ ... ],       // só para AskUserQuestion
      "canRemember": true         // se dá para oferecer "Sempre permitir"
    }
  }
}
```

## Servidor (`server.js`)

- **`save()`** grava `state.json` e transmite o estado completo, `snapshot()` = estado + `live`, para todos os clientes SSE. **Qualquer mudança de estado deve terminar em `save()`.**
- **`broadcast(event, data)`** transmite eventos SSE. O evento sem nome carrega o estado completo, e o evento `chat` carrega uma nova linha de conversa.
- **Rotas** são resolvidas na função `api()` a partir de `/api/<resource>/<id>/<action>`.
- **Proteções:**
  - escuta só em `127.0.0.1`;
  - recusa corpos que não sejam `application/json` (contra CSRF via `<form>`);
  - valida que a pasta de uma mesa existe;
  - impede path traversal nos arquivos estáticos.
- **`handleHook(ev)`** converte eventos do Claude Code em status. A mesa é encontrada pela pasta: `projectForPath(cwd)` escolhe a pasta mais específica que contém o `cwd`, sem diferenciar maiúsculas. Eventos de sessões criadas pelo próprio hub são ignorados (`runner.isHubSession`), porque essas sessões já são acompanhadas pelo runner.
- **`describeTool(name, input)`** transforma uma chamada de ferramenta em texto curto ("Editando app.js"). É usado pelos hooks e pelo runner.

## Runner (`runner.js`)

Executa o Claude por mesa usando `query()` do Claude Agent SDK. O SDK sobe o processo do Claude Code, que usa o login do usuário.

O fluxo de um pedido:

1. **O usuário manda um pedido.** `POST /api/projects/:id/chat` chama `runner.send(project, text)`.
2. **O runner inicia o Claude.** Ele chama `query({ prompt, options: { cwd: project.folder, resume: sessionId, abortController, canUseTool } })`.
3. **As mensagens do SDK viram conversa e status** (`handle`):
   - `system/init` → guarda o `session_id`. A próxima mensagem continua a mesma conversa (`resume`).
   - `assistant` → texto vira linha de conversa; `tool_use` vira linha "🔧 …" e atualiza o balão.
   - `result` → status **concluído**, ou **bloqueado** em caso de erro.
4. **Permissões e perguntas ficam pendentes.** O SDK chama `canUseTool` sempre que o Claude precisa de permissão ou chama a ferramenta `AskUserQuestion`. O runner devolve uma **Promise que fica pendente** e registra o pedido em `run.pending`. O agente fica **bloqueado** e o navegador mostra o cartão.
5. **A resposta do usuário libera o Claude.** `POST /api/projects/:id/answer` resolve a Promise:
   - **permitir** → `{ behavior: "allow", updatedInput: input }`
   - **sempre permitir** → o mesmo, mais `updatedPermissions` com as sugestões do SDK (destino `localSettings`)
   - **negar** → `{ behavior: "deny", message }`
   - **pergunta** → `updatedInput: { questions, answers }`. As respostas chegam **na ordem das perguntas** e o runner monta o mapa `texto da pergunta → resposta`. Usar o índice evita problemas de codificação com acentos.
6. **Parar** chama `abort()` no `AbortController`. O pedido pendente é negado automaticamente.

Os callbacks que o servidor passa ao runner são `onStatus` (atualiza o agente da mesa e o histórico), `onLive` (retransmite o estado) e `onChat` (transmite a nova linha).

## Hook (`hub-hook.js`)

O Claude Code executa o hook a cada evento configurado (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Notification`, `Stop`, `SessionEnd`), passando um JSON no stdin. O script faz duas coisas:

- **Resume o evento**, tirando conteúdo de arquivos e textos grandes, e envia para `POST /api/hook` com timeout de 1,5 s.
- **Sempre termina com código 0**, mesmo com o hub desligado, para nunca atrapalhar o Claude Code.

O `instalar-hook.js` registra o hook em `~/.claude/settings.json`. Ele é idempotente: remove versões antigas do mesmo hook antes de adicionar.

## Front-end (`public/app.js`)

O arquivo é dividido em seções comentadas:

| Seção | O que faz |
|---|---|
| **Layout do mundo** | Geometria em "pixels de mundo" (tile de 16 px), multiplicada por `SCALE` (2–4) na tela. Fileiras de 4 mesas (5×5 tiles cada), lounge à direita, parede com janelas no topo. A sala cresce conforme o número de mesas. |
| **Caminhos** | Os personagens andam pelo corredor horizontal de cada fileira e pelo corredor vertical à direita das mesas (`route`), para não atravessar mesas. |
| **Simulação** (`update`) | Define o destino de cada agente: com mesa e status ≠ ocioso → cadeira da mesa; senão → um ponto livre do lounge, trocado de tempos em tempos. Move a velocidade constante. |
| **Desenho** (`draw…`) | Tudo é desenhado com retângulos no canvas, sem imagens: sala, mesas, monitores (conteúdo depende do status), personagens (frente/costas, passos, piscadas, mãos digitando). Textos são desenhados em coordenadas de tela para ficarem nítidos. |
| **Balões** (`updateBubbles`) | Elementos HTML posicionados a cada quadro sobre o canvas. Mais nítidos que texto no canvas e clicáveis. O conteúdo vem de `bubbleFor(agent)` e só é reescrito quando muda. |
| **Janelas flutuantes** (`openWindow`) | Gerenciador genérico: arrastar pela barra, redimensionar (CSS `resize`), minimizar, foco/z-index. Posição e tamanho ficam salvos no `localStorage`. |
| **Janela da mesa** (`openProjectWindow` / `updateProjectWindow`) | Conversa, cartão pendente e caixa de texto. **É atualizada por partes**, nunca recriada, para não apagar o que o usuário está digitando ou já marcou. O cartão pendente só é redesenhado quando chega um pedido com id novo. |
| **Diálogos** | `<dialog>` nativo para criar e editar mesas e agentes. |

O ciclo de atualização:

1. **Chega um estado novo pelo SSE.** `applyState` recalcula a geometria, cria ou remove personagens e chama `refreshUI()`, que atualiza as estatísticas e todas as janelas abertas.
2. **Chega um evento `chat`.** `onChatEvent` acrescenta a mensagem na janela daquela mesa, se estiver aberta.
3. **A cada quadro** (`requestAnimationFrame`), rodam `update` → `draw` → `updateBubbles`.

## Como estender

- **Novo status de agente:** adicione em `STATUSES` (`server.js`), `STATUS` (`app.js`), na classe `.st-<status>` (`style.css`) e trate em `bubbleFor` e no desenho do monitor (`drawDesk`).
- **Nova rota de API:** adicione um bloco em `api()`. Se mudar o estado, termine com `save()`.
- **Novo móvel ou decoração:** desenhe em `drawRoom` ou `drawLounge` com `rect()`. As coordenadas são em pixels de mundo.
- **Opções do agente** (modelo, modo de permissão, prompt de sistema): ficam em `runner.send`, nas `options` do `query()`. Veja a [referência do SDK](https://code.claude.com/docs/en/agent-sdk/typescript).

## Testar

Não há testes automatizados ainda. Para testar sem mexer nos seus dados, suba uma instância separada:

```bash
# PORT muda a porta; HUB_DATA aponta para outro arquivo de estado (as conversas ficam ao lado dele)
PORT=4399 HUB_DATA=/tmp/hub-teste/state.json node server.js
```

Depois:

- **Para verificar a API**, use `curl` com `-H "Content-Type: application/json"`.
- **Para simular eventos do Claude Code**, envie um JSON para o hook: `echo '{"hook_event_name":"Stop","cwd":"..."}' | HUB_PORT=4399 node hub-hook.js`.
