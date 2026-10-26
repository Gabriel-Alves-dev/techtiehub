# Publicar o hub na VPS com Coolify

Guia para colocar o Techtie Hub em `https://hub.techtie.digital` numa VPS (Hostinger, Ubuntu) com [Coolify](https://coolify.io), e passar a usar os seus PCs como conectores.

```
navegador (qualquer lugar) ──HTTPS──► hub.techtie.digital  (Coolify → contêiner do hub, volume /data)
                                            ▲
PC de casa / PC do escritório ── conector ──┘  (conexão de saída; roda o Claude com o login daquele PC)
```

A VPS **não roda o Claude** e não precisa de login do Claude: ela só guarda os escritórios e serve a interface. Quem trabalha são os conectores nos seus PCs.

## 1. DNS

No painel do domínio `techtie.digital`, crie um registro:

| Tipo | Nome | Valor |
|---|---|---|
| A | `hub` | IP da VPS |

A propagação costuma levar alguns minutos. Confira com `nslookup hub.techtie.digital`.

## 2. Criar o app no Coolify

1. **Projects** → escolha (ou crie) um projeto → **+ New** → **Application**.
2. **Origem:** o repositório `https://github.com/Gabriel-Alves-dev/techtiehub`, branch `main`.
   - Público: *Public Repository*.
   - Privado: *Private Repository (with GitHub App)*.
3. **Build Pack:** `Dockerfile`. O `Dockerfile` da raiz já está pronto.
4. **Configuração (General):**
   - **Domains:** `https://hub.techtie.digital`. O Coolify emite o certificado HTTPS (Let's Encrypt) sozinho.
   - **Ports Exposes:** `4321`.
   - **Não** preencha *Ports Mappings*. O hub deve ser acessado só pelo proxy do Coolify, com HTTPS.
5. **Environment Variables:**

   | Variável | Valor | Para quê |
   |---|---|---|
   | `HUB_PUBLIC_URL` | `https://hub.techtie.digital` | Endereço mostrado no comando de parear PCs; cookie `Secure` |
   | `HUB_SETUP_CODE` | um código seu, ex.: `ABCD-1234` | Opcional. Código para criar a primeira conta. Se não definir, o hub gera um e mostra nos **Logs** |

   O `Dockerfile` já define `HUB_HOST=0.0.0.0`, `HUB_SEM_CONECTOR=1`, `HUB_TRUST_PROXY=1` e `HUB_DATA=/data/state.json`.
6. **Persistent Storage** → **+ Add** → **Volume**:
   - **Name:** `techtie-hub-data`
   - **Destination Path:** `/data`

   **Não pule este passo.** É aí que ficam contas, escritórios, conversas e sessões. Sem o volume, tudo some a cada deploy.
7. **Deploy.**

## 3. Criar a sua conta

1. Abra **Logs** do app no Coolify e copie a linha `Código de instalação (pedido ao criar a primeira conta): XXXX-XXXX`, ou use o seu `HUB_SETUP_CODE`.
2. Acesse `https://hub.techtie.digital`, preencha nome, e-mail, senha e o código de instalação.

O código existe para que ninguém crie a "primeira conta" antes de você só por ter achado o endereço. Depois disso, novas contas só entram com convite (**Conta → Gerar convite**).

## 4. Levar o seu escritório para a VPS

1. **No hub local** (o que roda no seu PC hoje): **PC → Backup → Exportar**. O arquivo contém mesas, agentes, conversas, memória e sessões. Trate-o como confidencial.
2. **No hub da VPS:** **PC → Backup → Importar…** e escolha o arquivo.
3. **Conecte o seu PC** (próximo passo). Como o PC é o mesmo, com a mesma identidade em `~/.techtie-hub/ambiente.json`, as mesas já reconhecem as pastas configuradas nele.

## 5. Conectar os PCs

**Jeito fácil:** no PC que vai trabalhar, entre em `https://hub.techtie.digital` com a sua conta, clique em **PC → Conectar um PC → Baixar conector (Windows)**, extraia o zip numa pasta fixa e dê dois cliques em **`Iniciar Techtie.bat`**. Ele baixa o Node.js portátil se faltar, instala, pareia o PC, abre o login do Claude se precisar e conecta. Não precisa clonar o repositório nem usar linha de comando.

**Pela linha de comando** (PC com o repositório clonado, Node.js 18+, `npm install` feito e Claude Code logado):

1. No hub: **PC → Conectar um PC → Já tenho o repositório clonado → Gerar código** (vale 10 minutos).
2. Na pasta do repositório, no PC:

   ```bash
   node conector.js --hub https://hub.techtie.digital --codigo XXXX-XXXX --nome "PC de casa"
   ```

3. Pronto. O PC aparece como **conectado** na janela de PCs.

Das próximas vezes, basta dar dois cliques em **`conectar.bat`** (ou `npm run conector`).

**Ligar sozinho com o Windows:** aperte `Win + R`, digite `shell:startup` e crie ali um atalho para o `conectar.bat`.

**Hooks do VS Code:** depois de parear, o `hub-hook.js` passa a falar com a VPS automaticamente, porque usa a mesma configuração em `~/.techtie-hub/conector.json`. Se ainda não instalou: `npm run instalar-hook`.

**Hub local:** pode desligar (feche o `iniciar.bat`). Se um dia abrir de novo, ele não mexe na configuração que aponta para a VPS.

## 6. Atualizar

- **Hub:** dê `git push` no repositório e clique em **Redeploy** no Coolify. Também dá para ativar *Auto Deploy* com o webhook do GitHub. Os dados ficam no volume e não se perdem.
- **Conectores:** quem usa o pacote baixa de novo no hub e extrai por cima da pasta antiga (o PC continua o mesmo). Quem usa o repositório: `git pull` e abra o `conectar.bat` de novo.

## 7. Backup

- **Pela interface:** **PC → Backup → Exportar**, de tempos em tempos. Isso cobre o escritório da sua conta.
- **Do servidor inteiro** (todas as contas): faça backup do volume. Na VPS:

  ```bash
  docker volume ls | grep techtie-hub-data        # o Coolify acrescenta um prefixo ao nome
  docker run --rm -v <nome-do-volume>:/data -v "$PWD":/backup alpine \
    tar czf /backup/techtie-hub-$(date +%F).tgz -C /data .
  ```

- **Snapshots da Hostinger:** ative os snapshots periódicos da VPS como rede de segurança.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| Certificado não sai / site não abre | DNS ainda não propagou, ou o domínio no Coolify não está com `https://` |
| Dados somem depois de um deploy | Volume `/data` não configurado em *Persistent Storage* |
| Erro de permissão em `/data` | O volume foi criado como *bind mount* de uma pasta do host. Use *Volume* (gerenciado pelo Docker) |
| Conector: "este PC não está pareado" | O PC foi removido ou pareado com outro hub; gere um código novo |
| A conversa trava no "Trabalhando…" | O conector daquele PC caiu; o hub encerra o pedido e avisa na conversa |
| Comando de parear mostra `http://` | Falta `HUB_PUBLIC_URL=https://hub.techtie.digital` |
