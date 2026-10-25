# Techtie Hub

Um escritório em pixel art, estilo game, onde **cada mesa é um projeto** e **cada personagem é um agente de IA** (Claude) trabalhando nele.

Você vê de relance quem está trabalhando, quem terminou e quem precisa de você. Também pode conversar com cada agente, responder às perguntas dele e aprovar ou negar ações direto do escritório, sem abrir o VS Code.

![Escritório](docs/escritorio.png)

![Janela de conversa com pergunta do agente](docs/janela-conversa.png)

![Áreas especiais: copa, reunião e descanso](docs/areas.png)

---

## Recursos

- **Salas.** Organize as mesas em salas, por exemplo uma por cliente ou time. Cada sala tem o próprio formato (de 2 a 8 mesas por fileira) e o próprio piso, e a aba da sala avisa quando algum agente de lá precisa de você.
- **Áreas especiais.** Cada sala tem uma coluna lateral com **copa**, **sala de reunião** e **área de descanso** (você escolhe quais). Os agentes ociosos circulam entre elas: tomam café, "conversam" em reunião, sentam no sofá, cochilam no puff e jogam fliperama.
- **Zoom e navegação.** Use os botões ou Ctrl + roda do mouse para dar zoom, e arraste o escritório com o mouse quando ele for maior que a tela.
- **Escritório animado.** Os personagens andam pelo escritório. Sentam e digitam na mesa quando trabalham, vão tomar café no lounge quando estão ociosos, e o monitor de cada mesa mostra o status. As janelas mudam de cor conforme a hora do dia e o relógio da parede marca a hora real.
- **Balões de fala** sobre cada personagem. Mostram o que o agente está fazendo, ou piscam em amarelo quando ele tem uma pergunta ou precisa de permissão.
- **Janelas flutuantes de conversa.** Clique no balão, no personagem ou na mesa para abrir. As janelas podem ser arrastadas, redimensionadas e minimizadas, e dá para abrir várias ao mesmo tempo.
- **Agentes de verdade.** O hub roda o Claude (via [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)) na pasta de cada projeto, usando o seu login do Claude Code. As conversas continuam de onde pararam.
- **Permissões e perguntas no hub.** Quando o agente quer rodar um comando ou editar um arquivo, aparece um cartão com **Permitir / Sempre permitir / Negar**. Quando ele faz uma pergunta de múltipla escolha, as opções aparecem para você clicar.
- **Integração com o Claude Code do VS Code (opcional).** Por hooks, sessões abertas no VS Code dentro da pasta de uma mesa também atualizam o escritório.
- **API simples** para qualquer script ou agente reportar status.
- **Roda só na sua máquina.** Sem banco de dados, sem nuvem.

## Requisitos

- **Windows 10/11.** O servidor e a API são multiplataforma, mas o seletor de pastas e os botões "Abrir pasta" / "VS Code" usam recursos do Windows.
- **[Node.js](https://nodejs.org) 18 ou mais novo.**
- **Uma conta do Claude com Claude Code**, com login feito no VS Code ou no terminal. Os agentes do hub usam essa mesma conta e consomem o seu plano.
- **[VS Code](https://code.visualstudio.com)**, opcional, para o botão "VS Code".

## Instalação e uso

```bash
git clone https://github.com/Gabriel-Alves-dev/techtiehub.git
cd techtiehub
npm install
npm start
```

Depois abra <http://localhost:4321>.

No Windows, você também pode dar dois cliques em **`iniciar.bat`**. Ele instala as dependências na primeira vez, inicia o servidor e abre o navegador.

### Primeiros passos

1. **Contrate agentes** no botão **+ Contratar**: escolha nome, cargo e as cores do personagem.
2. **Crie salas, se quiser,** pela aba **+ Sala**. Clique na aba da sala atual (⚙) para mudar o nome, as mesas por fileira, as áreas especiais e o piso.
3. **Crie uma mesa** no botão **+ Mesa** ou clicando na mesa tracejada. Dê um nome, escolha a **pasta do projeto** com o botão "Escolher…" e o agente que vai sentar nela.
4. **Clique na mesa ou no personagem** para abrir a janela de conversa e peça algo, por exemplo: *"Analisa a estrutura do projeto e me diz o que falta para o MVP"*.
5. **Acompanhe pelos balões.** Quando o balão ficar amarelo, clique nele para responder.

### Status dos agentes

| Status | No escritório |
|---|---|
| **Trabalhando** | Sentado digitando, código passando no monitor, balão com a ação atual |
| **Bloqueado** | Monitor vermelho, balão amarelo pulando: tem pergunta ou pedido de permissão |
| **Concluído** | Monitor azul com ✓, balão "Pronto!" |
| **Ocioso** | Levanta e vai para as áreas da sala: café ☕, reunião 💬, sofá, puff 💤 ou fliperama 🕹️ |

### Conversando com os agentes

Na janela de uma mesa:

- **Enviar.** Enter envia e Shift+Enter quebra a linha. Cada mesa executa uma tarefa por vez, mas mesas diferentes trabalham em paralelo.
- **Pedido de permissão.** Mostra o comando ou o arquivo envolvido.
  - **Permitir** libera só essa vez.
  - **Sempre permitir** grava a regra em `.claude/settings.local.json` dentro da pasta do projeto.
  - **Negar** avisa o agente, que tenta outro caminho.
- **Pergunta do agente.** Marque uma opção ou escreva uma resposta própria em "Outra resposta".
- **Parar** interrompe o agente no meio da tarefa.
- **Nova conversa** começa do zero. O agente esquece o contexto da conversa anterior.

O agente usa as suas configurações do Claude Code (modelo, esforço, permissões) e lê o `CLAUDE.md` do projeto, se existir.

> **Dica:** abra `http://localhost:4321/#<id-da-mesa>` para já abrir a conversa de uma mesa. O id fica em `data/state.json`.

## Integração com o Claude Code do VS Code (opcional)

Para que as sessões do Claude Code que **você** abre no VS Code também movimentem o escritório, instale o hook:

```bash
npm run instalar-hook
```

O comando adiciona o `hub-hook.js` aos hooks do seu `~/.claude/settings.json`, com backup em `settings.json.bak-techtie`, e não mexe nas suas outras configurações. A partir daí, quando o Claude Code trabalha numa pasta vinculada a uma mesa, o agente da mesa reage:

| Evento no Claude Code | No escritório |
|---|---|
| Sessão aberta | Agente chega (ocioso) |
| Você manda um pedido | Senta e trabalha, com o pedido no balão |
| Claude usa uma ferramenta | Balão mostra a ação ("Editando app.js") |
| Claude pede permissão / espera você | Bloqueado |
| Claude termina | Concluído |
| Sessão encerrada | Volta a ficar ocioso |

Pastas sem mesa são ignoradas. Se o hub estiver desligado, o hook sai em silêncio e não atrasa o Claude.

**Detalhes:**
- Os hooks só valem para sessões abertas **depois** da instalação.
- Se você mover a pasta do hub, rode `npm run instalar-hook` de novo.
- Para remover: `npm run remover-hook`.

## API

O servidor escuta só em `127.0.0.1:4321`. Para mudar a porta, use a variável `PORT`. Requisições que não são `GET` precisam de `Content-Type: application/json`.

| Método e rota | O que faz |
|---|---|
| `GET /api/state` | Estado completo: mesas, agentes, histórico e `live` (execuções em andamento) |
| `GET /api/events` | Stream SSE. Evento padrão = estado completo; evento `chat` = nova mensagem `{ projectId, entry }` |
| `POST /api/report` | Atualiza um agente: `{ agent, status, message?, project? }`. `agent` e `project` aceitam id ou nome |
| `POST /api/hook` | Recebe eventos do `hub-hook.js` |
| `POST /api/rooms` · `PATCH /api/rooms/:id` · `DELETE /api/rooms/:id` | CRUD de salas: `{ name, cols (2–8), areas: ["copa", "reuniao", "descanso"], floor: "madeira" | "carpete" | "piso" | "escuro" }`. Ao remover uma sala, as mesas dela vão para outra |
| `POST /api/projects` · `PATCH /api/projects/:id` · `DELETE /api/projects/:id` | CRUD de mesas: `{ name, description, color, folder, agentId, roomId }` |
| `POST /api/agents` · `PATCH /api/agents/:id` · `DELETE /api/agents/:id` | CRUD de agentes: `{ name, role, shirt, hair, skin, status, message }` |
| `GET /api/projects/:id/chat` | Conversa salva da mesa: `{ sessionId, entries }` |
| `POST /api/projects/:id/chat` | Envia um pedido ao agente da mesa: `{ message }` |
| `POST /api/projects/:id/answer` | Responde o pedido pendente: `{ requestId, decision: "allow" \| "always" \| "deny" }` ou `{ requestId, answers: [...] }` |
| `POST /api/projects/:id/stop` | Interrompe o agente |
| `POST /api/projects/:id/reset` | Começa uma conversa nova |
| `POST /api/projects/:id/open` | Abre a pasta: `{ app: "explorer" \| "vscode" }` |
| `POST /api/pick-folder` | Abre o seletor de pastas do Windows e devolve `{ folder }` |

Status válidos: `trabalhando`, `ocioso`, `bloqueado`, `concluido`.

Para reportar status de qualquer script, use o `report.js`:

```bash
node report.js "Ana" trabalhando "Escrevendo testes" --projeto "Site Techtie"
```

## Estrutura do projeto

```
techtiehub/
├── server.js          # Servidor HTTP (sem framework): API, SSE, arquivos estáticos, hooks
├── runner.js          # Roda o Claude Agent SDK por mesa; permissões e perguntas pendentes
├── hub-hook.js        # Hook do Claude Code → repassa eventos para /api/hook
├── instalar-hook.js   # Instala/remove o hook em ~/.claude/settings.json
├── report.js          # CLI para reportar status de um agente
├── iniciar.bat        # Atalho do Windows: instala dependências, sobe o servidor e abre o navegador
├── public/
│   ├── index.html     # Página única
│   ├── style.css      # Tema escuro + estilos de balões e janelas
│   └── app.js         # Escritório em canvas, balões, janelas flutuantes, diálogos
├── docs/
│   ├── ARQUITETURA.md # Como as peças se conectam (leitura recomendada para quem vai mexer)
│   └── *.png          # Capturas de tela
└── data/              # Criado em tempo de execução, fora do git
    ├── state.json     # Salas, mesas, agentes e histórico
    └── chats/<id>.json# Conversa e id de sessão do Claude de cada mesa
```

Para entender o funcionamento interno (fluxo de dados, estados, como o canvas é desenhado e como as permissões são intermediadas), veja **[docs/ARQUITETURA.md](docs/ARQUITETURA.md)**.

## Dados e privacidade

- Tudo fica na pasta `data/`, na sua máquina. Ela está no `.gitignore` porque contém as conversas com os agentes e os caminhos das suas pastas.
- Os pedidos aos agentes vão para a Anthropic pelo Claude Code, como qualquer sessão do Claude Code.
- Para zerar o escritório, apague `data/` com o servidor desligado.

## Segurança

O hub abre pastas e programas e executa agentes que editam arquivos, então:

- **O servidor só aceita conexões da própria máquina** (`127.0.0.1`).
- **A API só aceita requisições JSON.** Isso impede que um site qualquer dispare ações com um formulário (CSRF).
- **Os agentes rodam com as permissões do Claude Code.** Nada destrutivo acontece sem passar pelo cartão de permissão, a não ser o que você já liberou com "Sempre permitir" ou nas suas configurações.

## Ideias para o futuro

- Notificação do Windows quando um agente ficar esperando você
- Reunião de verdade: escolher agentes e um tema para eles discutirem e devolverem um resumo
- Modo de edição para montar e decorar as salas (arrastar mesas, móveis)
- Hub na nuvem com conector local por PC: contas, memória do agente portátil entre computadores
- Vários agentes na mesma mesa
- Contador de horas trabalhadas por projeto
- Sons e mais animações (comemoração ao concluir, por exemplo)
