# Monitor de servidores (VPS) no hub

O monitor da VPS **envia** um resumo ao hub; o hub nunca acessa a VPS. Não é preciso abrir porta de entrada na VPS nem entregar ao hub o token do painel.

## Configuração

1. No hub, abra uma sala do tipo **Sala de servidores** (aba **+ Sala** → Tipo) e clique no rack (ou na mensagem "SEM MONITOR").
2. Em **Gerar segredo**, copie o valor (aparece uma única vez; o hub guarda só o hash) e grave-o na VPS por um canal seguro, nunca no chat.
3. O monitor faz `POST https://<seu-hub>/api/monitor/report` a cada 1 a 5 minutos.

Só a dona do hub vê os racks e gera ou revoga o segredo. Gerar outro segredo invalida o anterior.

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

## Situação do rack

- **Crítico:** algum item em `errored`, `unhealthy` ou `failed`, ou CPU, memória ou disco a partir de 90%.
- **Atenção:** `highRestarts`, CPU a partir de 75%, memória ou disco a partir de 80%.
- **Sem sinal:** 3 intervalos sem envio. **OK:** o resto.

As seis unidades do rack são, de cima para baixo: CPU, memória, disco, PM2, Docker e systemd.

## Respostas

`200 {"ok":true,"host":"..."}`. `400` corpo inválido, `401` segredo errado (8 erros seguidos do mesmo IP bloqueiam por 15 min, `429`), `415` sem `Content-Type: application/json`.

## Armazenamento

`data/monitor.json` guarda só o hash do segredo. Os resumos ficam em memória: depois de reiniciar o hub, cada rack volta no próximo envio.
