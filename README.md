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
- **Hub e conectores.** O hub guarda tudo; um conector em cada PC roda os agentes com as pastas e o login do Claude daquele computador. Cada PC tem a sua pasta para cada mesa, e o agente **continua a mesma conversa** em qualquer PC conectado. Se a sessão completa não estiver disponível, ele recebe a **memória** do projeto. O hub também avisa quando falta `git pull`.
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

## Hub e conectores: vários PCs

O Techtie Hub tem duas partes:

- **Hub:** o escritório central. Guarda salas, mesas, agentes, conversas, memória e sessões, e serve a interface. Não roda o Claude nem mexe em pastas.
- **Conector:** um programa pequeno em cada PC. Ele se conecta **ao** hub (o PC não precisa de porta aberta), recebe os pedidos e executa ali, com as pastas e o login do Claude Code daquele computador.

No modo local (`npm start`), o hub já sobe com o conector do próprio PC embutido. Quem usa um computador só não precisa pensar nisso.

### Escolher o PC que executa

O botão **PC** (topo) mostra os PCs conectados. Os pedidos enviados deste navegador rodam no PC **em uso**; se houver só um conectado, ele é usado automaticamente. Um pedido em andamento pode ser acompanhado e respondido de qualquer navegador, e a resposta vai para o PC onde ele está rodando.

### Continuar o trabalho em outro PC

Exemplo: você trabalhou em casa com a Bia na mesa "TechTie Flow" e agora está no PC do escritório, ligado ao mesmo hub.

1. **Em casa:** dê `git push` no projeto.
2. **No escritório:** clone o projeto (em qualquer pasta) e rode o conector (veja abaixo). No hub, escolha o PC do escritório em **PC**.
3. **Abra a mesa.** Ela avisa que ainda não tem pasta neste PC e mostra onde estava no outro. Em **⚙ Mesa**, escolha a pasta do clone. O hub confere se é o mesmo repositório git.
4. **Peça algo à Bia.** Ela continua a mesma conversa, com todo o contexto, e é avisada de que agora está em outro PC e outra pasta.

Como a continuidade funciona:

- **Sessão completa.** Cada conversa é espelhada no hub, em `data/sessions/` (recurso `sessionStore` do Claude Agent SDK, ainda experimental). É ela que permite retomar a conversa inteira em outro PC.
- **Memória.** Resumo do projeto mantido pelo hub. É atualizada ao clicar em **Nova conversa** ou em **🧠 Memória** → *Atualizar com a conversa*, e você pode editá-la. O agente recebe a memória ao começar uma sessão nova, ou quando a sessão completa não pode ser retomada.
- **Aviso de commit.** O hub guarda o commit em que o agente parou. Se esse commit não existir na pasta deste PC, a janela da mesa avisa para dar `git pull`.

### Conectar um PC

No computador novo: instale o Node.js, faça login no Claude Code, clone este repositório e rode `npm install`. Depois copie o comando que aparece em **PC → Conectar um PC** (com o endereço do hub e a chave):

```bash
node conector.js --hub http://endereco-do-hub:4321 --chave <chave> --nome "PC do escritório"
```

A configuração fica salva em `~/.techtie-hub/`; das próximas vezes basta `npm run conector`.

> **Hoje o hub só aceita conexões do próprio computador**, porque ainda não tem login. Conectores de outros PCs vão funcionar quando o hub estiver na VPS, com contas (próximas etapas). Até lá, para levar o escritório a outro PC, use **PC → Backup** (exportar/importar).

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

O hub escuta só em `127.0.0.1:4321` (variáveis `PORT` e `HUB_HOST`). Requisições que não são `GET` precisam de `Content-Type: application/json`. Rotas que dependem de um PC (conversa, pasta, git, seletor de pastas) usam o PC do cabeçalho `X-Hub-Env`, ou o único PC conectado.

| Método e rota | O que faz |
|---|---|
| `GET /api/state` | Estado completo: mesas, agentes, histórico e `live` (execuções em andamento) |
| `GET /api/events` | Stream SSE. Evento padrão = estado completo; evento `chat` = nova mensagem `{ projectId, entry }` |
| `POST /api/report` | Atualiza um agente: `{ agent, status, message?, project? }`. `agent` e `project` aceitam id ou nome |
| `POST /api/hook` | Recebe eventos do `hub-hook.js` |
| `POST /api/rooms` · `PATCH /api/rooms/:id` · `DELETE /api/rooms/:id` | CRUD de salas: `{ name, cols (2–8), areas: ["copa", "reuniao", "descanso"], floor: "madeira" | "carpete" | "piso" | "escuro" }`. Ao remover uma sala, as mesas dela vão para outra |
| `POST /api/projects` · `PATCH /api/projects/:id` · `DELETE /api/projects/:id` | CRUD de mesas: `{ name, description, color, folder, agentId, roomId }`. `folder` é a pasta **neste PC**; se a mesa já tem repositório e a pasta é de outro, responde 409 `repo_mismatch` (reenvie com `forceFolder: true` para confirmar) |
| `POST /api/agents` · `PATCH /api/agents/:id` · `DELETE /api/agents/:id` | CRUD de agentes: `{ name, role, shirt, hair, skin, status, message }` |
| `GET /api/projects/:id/chat` | Conversa salva da mesa: `{ sessionId, entries, memory, lastCommit, … }` |
| `GET /api/projects/:id/memory` · `PUT` · `POST` | Ler, salvar `{ memory }` ou atualizar a memória a partir da conversa |
| `GET /api/projects/:id/git` | Situação do git da pasta neste PC: `{ head, branch, dirty, last, state: "ok" \| "ahead" \| "missing" \| "diverged" }` |
| `PATCH /api/environment` | Renomeia o PC em uso: `{ name }` |
| `GET /api/connector-info` | Endereço do hub e chave dos conectores |
| `GET /api/export` · `POST /api/import` | Exporta/importa o escritório inteiro (estado, conversas e sessões) |
| `/api/connector/*` | Canal dos conectores (stream de comandos, respostas, eventos, sessões). Exige `Authorization: Bearer <chave>` |
| `POST /api/projects/:id/chat` | Envia um pedido ao agente da mesa: `{ message }` |
| `POST /api/projects/:id/answer` | Responde o pedido pendente: `{ requestId, decision: "allow" \| "always" \| "deny" }` ou `{ requestId, answers: [...] }` |
| `POST /api/projects/:id/stop` | Interrompe o agente |
| `POST /api/projects/:id/reset` | Começa uma conversa nova (antes, guarda um resumo na memória) |
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
├── server.js          # HUB: estado, API, SSE, interface, canal dos conectores, hooks
├── chats.js           # Conversas das mesas (data/chats/)
├── connectors.js      # PCs conectados: comandos (RPC) e eventos
├── session-store.js   # Sessões do Claude guardadas no hub (data/sessions/)
├── conector.js        # CONECTOR: roda em cada PC e se liga ao hub
├── runner.js          # (no conector) Claude Agent SDK por mesa; permissões, perguntas, memória
├── remote-store.js    # (no conector) sessões do Claude lidas/gravadas no hub
├── local-ops.js       # (no conector) pastas, seletor de pastas, Explorer/VS Code
├── git.js             # Commit atual, remote e comparação com o commit em que o agente parou
├── describe.js        # Texto curto para cada ação do Claude ("Editando app.js")
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
    ├── chats/<id>.json# Conversa, memória e último commit de cada mesa
    ├── sessions/      # Sessões completas do Claude (uma por conversa)
    └── hub.json       # Chave dos conectores
```

Para entender o funcionamento interno (fluxo de dados, estados, como o canvas é desenhado e como as permissões são intermediadas), veja **[docs/ARQUITETURA.md](docs/ARQUITETURA.md)**.

## Dados e privacidade

- Tudo fica na pasta `data/`, na sua máquina, mais a identidade do PC em `~/.techtie-hub/ambiente.json`. O arquivo de exportação contém conversas e sessões completas, inclusive trechos de código: trate-o como confidencial.
- A pasta `data/` está no `.gitignore` porque contém as conversas com os agentes e os caminhos das suas pastas.
- Os pedidos aos agentes vão para a Anthropic pelo Claude Code, como qualquer sessão do Claude Code.
- Para zerar o escritório, apague `data/` com o servidor desligado.

## Segurança

O hub abre pastas e programas e executa agentes que editam arquivos, então:

- **O hub só aceita conexões da própria máquina** (`127.0.0.1`) até existir login.
- **Conectores e hooks precisam da chave** do hub (`data/hub.json`). Quem tem a chave pode mandar trabalho para os PCs conectados: não compartilhe.
- **A API só aceita requisições JSON.** Isso impede que um site qualquer dispare ações com um formulário (CSRF).
- **Os agentes rodam com as permissões do Claude Code.** Nada destrutivo acontece sem passar pelo cartão de permissão, a não ser o que você já liberou com "Sempre permitir" ou nas suas configurações.

## Ideias para o futuro

- Notificação do Windows quando um agente ficar esperando você
- Reunião de verdade: escolher agentes e um tema para eles discutirem e devolverem um resumo
- Modo de edição para montar e decorar as salas (arrastar mesas, móveis)
- Contas e login no hub, e publicação na VPS com HTTPS
- Vários agentes na mesma mesa
- Contador de horas trabalhadas por projeto
- Sons e mais animações (comemoração ao concluir, por exemplo)
