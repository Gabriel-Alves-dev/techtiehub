# Monitor de servidores (VPS) no hub

O monitor da VPS **envia** um resumo ao hub; o hub nunca acessa a VPS. Não é preciso abrir porta de entrada na VPS nem entregar ao hub o token do painel.

## Configuração

1. No hub, abra uma sala do tipo **Sala de servidores** (aba **+ Sala** → Tipo) e clique no rack (ou na mensagem "SEM MONITOR").
2. Em **Gerar segredo**, copie o valor (aparece uma única vez; o hub guarda só o hash) e grave-o na VPS por um canal seguro, nunca no chat.
3. O monitor faz `POST https://<seu-hub>/api/monitor/report` a cada 1 a 5 minutos.

Só a dona do hub vê os racks e gera ou revoga o segredo. Gerar outro segredo invalida o anterior.

## Várias VPS

Todas as VPS usam o **mesmo segredo**. O que separa uma da outra é o campo `host` do envio: cada `host` vira um rack próprio na sala (até 20). Para somar uma VPS, instale o monitor nela com o mesmo segredo e um `host` diferente (o nome do servidor). Se gerar um novo segredo, todas as VPS precisam receber o novo.

## Requisição

```
POST /api/monitor/report
Authorization: Bearer <segredo>
Content-Type: application/json      (corpo de até 16 KB)
```

```json
{ "v": 1, "host": "vps-principal", "interval": 60,
  "cpu": 23.5, "mem": 61.2, "disk": 71, "uptime": 864000,
  "pm2": { "total": 12, "errored": ["api"], "highRestarts": ["bot"] },
  "docker": { "total": 8, "unhealthy": ["redis"] },
  "systemd": { "total": 210, "failed": ["nginx"] },
  "ports": { "exposed": 14 } }
```

| Campo | Significado |
| --- | --- |
| `host` | nome do servidor (letras, números, `.`, `_` e `-`, até 64). Um rack por `host`, no máximo 20 |
| `interval` | segundos entre envios (30 a 3600). Sem envio por 3 intervalos, o rack fica **sem sinal** |
| `cpu` | carga média de 1 min ÷ vCPUs, em % (não é o uso instantâneo) |
| `mem`, `disk` | uso em % |
| `uptime` | segundos desde o boot |
| `pm2.errored`, `pm2.highRestarts`, `docker.unhealthy`, `systemd.failed` | **lista de nomes** (até 20, 64 caracteres) ou **só a contagem**, se o monitor não enviar nomes |
| `pm2.total`, `docker.total`, `systemd.total`, `ports.exposed` | contadores |

`highRestarts` é o acumulado desde o boot: um processo com reinícios antigos continua na lista. Qualquer campo fora desta tabela é descartado.

## Envio v2 (detalhamento por serviço)

Com `"v": 2` o envio troca os contadores por `sys` (CPUs, `load_pct`, memória, swap, disco e uptime) e pela lista `services`. O hub aceita os dois formatos na mesma sala, identificados pelo `host`, e converte o v2 para o formato do v1 (as telas de rack continuam iguais).

```json
{ "v": 2, "host": "srv584582", "interval": 60,
  "sys": { "cpus": 2, "load_pct": 23.5, "mem_used_pct": 61.2, "mem_total_mb": 7940,
           "swap_used_pct": 0.0, "disk_used_pct": 71.0, "uptime_s": 864000 },
  "services": [
    { "src": "pm2", "name": "api", "project": "api", "status": "online", "health": "ok",
      "instances": 2, "cpu_core_pct": 12.4, "mem_mb": 180, "restarts": 3 },
    { "src": "swarm", "name": "whatsapp-gateway_gateway", "status": "running", "health": "ok",
      "replicas": "1/1", "cpu_core_pct": 138.3, "mem_mb": 2390, "restarts": null } ],
  "ports": { "listening": 63, "exposed": 12 }, "truncated": false }
```

- `src`: `pm2`, `docker`, `swarm` ou `systemd` (itens com outra origem são descartados).
- `status`: `online`, `stopped`, `errored`, `launching`, `running`, `exited`, `restarting`, `active`, `inactive` ou `failed`; qualquer outro valor vira `other`.
- `cpu_core_pct` é a % de **um** núcleo e **não é cortada em 100**. `restarts` é acumulado desde o boot e vem `null` no Docker e no Swarm.
- Até 60 itens (o hub corta o excedente e marca `truncated`). A lista deve vir com os problemas primeiro.
- O systemd manda só as unidades em `failed` ou marcadas como próprias, então o total de systemd mostrado é o das **unidades listadas**, não o do sistema. O Swarm entra junto com o Docker nos totais do rack; a tabela mostra a origem de cada item.
- Item com problema: `status` `errored` ou `failed`, ou `health` `unhealthy`. `restarting` conta como atenção.
- Números fora da faixa são limitados e textos inesperados são limpos (nomes só com letras, números, `.`, `_` e `-`).
- Corpo de até 32 KB: 60 itens típicos ocupam ~9 KB; o pior caso (todos os campos no tamanho máximo) ~19 KB.

## Situação do rack

- **Crítico:** algum item em `errored`, `unhealthy` ou `failed`, ou memória ou disco a partir de 90%.
- **Atenção:** `highRestarts`, **carga** a partir de 75%, memória ou disco a partir de 80%.

O campo `cpu` (v1) e `sys.load_pct` (v2) é a **carga média de 1 min ÷ vCPUs, não o uso de CPU**: ela sobe com o *steal* do hypervisor mesmo com a VM quase ociosa. Por isso, sozinha, a carga **nunca passa de Atenção**. O Crítico por CPU virá de `cpu_busy_pct` e `steal_pct` quando o monitor passar a enviá-los (ainda não são lidos pelo hub).
- **Sem sinal:** 3 intervalos sem envio. **OK:** o resto.

As seis unidades do rack são, de cima para baixo: CPU, memória, disco, PM2, Docker e systemd.

## Respostas

`200 {"ok":true,"host":"..."}`. `400` corpo inválido, `401` segredo errado (8 erros seguidos do mesmo IP bloqueiam por 15 min, `429`), `415` sem `Content-Type: application/json`.

## Armazenamento

`data/monitor.json` guarda só o hash do segredo. Os resumos ficam em memória: depois de reiniciar o hub, cada rack volta no próximo envio.
