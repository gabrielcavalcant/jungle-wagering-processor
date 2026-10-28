# Distributed Wagering Processor

[![CI](https://github.com/gabrielcavalcant/jungle-wagering-processor/actions/workflows/ci.yml/badge.svg)](https://github.com/gabrielcavalcant/jungle-wagering-processor/actions/workflows/ci.yml)

Serviço financeiro que processa transações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`) vindas de múltiplos provedores, por **HTTP** e **SQS**. Ele continua correto com mensagens duplicadas, entregues fora de ordem ou processadas ao mesmo tempo por **N instâncias**.

**Stack:** Bun 1.x · TypeScript estrito · NestJS 11 · PostgreSQL 16 · MikroORM 6 · AWS SQS via LocalStack · Docker Compose.

> Decisões, trade-offs e limitações estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.
> Banco de dados (diagrama, garantias e SQL): **[docs/DATABASE.md](docs/DATABASE.md)** · **[docs/schema.sql](docs/schema.sql)**.

---

## Rodar o desafio inteiro com 1 comando

```bash
bun install
bun run showcase
```

Sobe o Docker Compose (PostgreSQL, LocalStack e **3 instâncias** da aplicação, esperando cada uma ficar saudável), roda o typecheck e os testes de unidade, integração e concorrência, faz a demonstração dos cenários nas instâncias do Docker, mostra os logs e as métricas, imprime um resumo por etapa (cada uma com a seção do enunciado que prova) e, no fim, abre o **Swagger UI** no navegador e executa sozinho todas as operações (preenche as caixas, clica em Execute e confere cada resposta), enquanto os logs das 3 instâncias aparecem ao vivo. Flags: `--rapido` (pula a concorrência) e `--sem-testes`.

## Ver funcionando em 1 minuto

```bash
bun install
bun run swagger
```

Sobe PostgreSQL + LocalStack, aplica as migrations, inicia a API em `http://localhost:3000` e abre o **Swagger** (`/docs`) no navegador. Em outro terminal:

```bash
bun run demo
```

Roda os cenários do desafio contra a API e mostra cada resultado na tela: carteira, as duas apostas de 80.00 simultâneas, idempotência, 50 duplicatas em paralelo, WIN/LOSS, REFUND antes da BET, reversão que deixaria saldo negativo, validação de dinheiro, mensagem SQS duplicada, extrato, reconciliação e métricas.

## Subindo tudo

Pré-requisitos: Docker (com Compose v2) e Bun ≥ 1.2.

```bash
bun install
docker compose up -d --build
```

Isso sobe:

| serviço | porta no host | papel |
|---|---|---|
| `postgres` | 5433 | banco (`wagering` para a app, `wagering_test` para os testes) |
| `localstack` | 4566 | SQS: `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wagering-events.fifo` |
| `migrate` | — | roda as migrations uma vez e sai |
| `app-1`, `app-2`, `app-3` | 3001, 3002, 3003 | **três instâncias** do mesmo serviço (HTTP + consumer SQS + outbox publisher + worker de referências + limpeza) |

```bash
curl localhost:3001/health/ready
```

Documentação interativa da API (Swagger): **http://localhost:3001/docs**

### Rodando local (fora do Docker)

```bash
bun run infra:up
DB_PORT=5433 bun run migration:up
DB_PORT=5433 PORT=3000 bun run start
```

## Comandos

| comando | o que faz |
|---|---|
| `bun run showcase` | o processo completo: Docker com 3 instâncias, todos os testes, demonstração, logs e Swagger |
| `bun run swagger:tour` | abre o Swagger UI no Chrome (ou Edge) e executa **todas as operações** sozinho, devagar, com uma faixa explicando cada passo |
| `bun run swagger` | sobe a infra, as migrations e a API, e abre o Swagger |
| `bun run demo` | demonstração dos cenários do desafio contra a API rodando |
| `bun run start` | sobe uma instância |
| `bun run migration:up` / `migration:down` | aplica / reverte migrations |
| `bun run typecheck` | `tsc --noEmit` (modo estrito) |
| `bun run test:unit` | domínio e regras de negócio (sem I/O, ~1 s) |
| `bun run test:integration` | PostgreSQL + LocalStack reais: constraints, atomicidade, inbox, outbox ordenada, retry, DLQ + `FAILED`, retenção, locks |
| `bun run test:concurrency` | **3 processos reais** da aplicação: 50 duplicatas em paralelo, corrida de saldo, crash após commit, kill de todas as instâncias + restart |
| `bun run test:all` | tudo: 133 testes (no CI: ~2 min) |
| `bun run test:load` | teste de carga → [`test/load/RESULTS.md`](test/load/RESULTS.md) |

Os testes de integração e concorrência exigem `bun run infra:up`. Eles usam o banco `wagering_test` e criam **filas próprias por execução**, então não interferem no ambiente de dev. Nenhum teste substitui PostgreSQL ou SQS por mock. Os mocks em memória (`test/support/in-memory.ts`) servem só para os testes de unidade das regras.

**Invariante final verificada em todos os testes de integração e concorrência:** `wallet.balance == Σ ledger`, `balance_before` de cada entrada igual ao `balance_after` da anterior, nenhum saldo negativo e no máximo uma entrada por transação.

## API

| método | rota | descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet (+ transação `OPENING` e crédito no ledger, na mesma transação SQL) |
| `GET` | `/wallets/:walletId` | saldo e versão |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | ledger paginado por keyset (cursor opaco e estável) |
| `POST` | `/wallets/:walletId/reconciliation` | compara o saldo materializado com o ledger; **não corrige** |
| `POST` | `/wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| `GET` | `/health/live` · `/health/ready` | liveness · readiness (PostgreSQL + SQS) — sem autenticação |
| `GET` | `/metrics` | métricas Prometheus |
| `GET` | `/docs` · `/docs/openapi.json` | **Swagger UI** (documentação interativa) · contrato OpenAPI 3 |

### Códigos HTTP (iguais em todos os endpoints)

| status | significado | o provedor deve… |
|---|---|---|
| `201` | transação nova, `PROCESSED` | — |
| `200` | replay idempotente (`idempotentReplay: true`), resultado original | — |
| `202` | aceita, `PENDING_REFERENCE` (aguardando a referência) | consultar depois ou reenviar com a mesma key |
| `400` | payload inválido / `Idempotency-Key` ausente (`VALIDATION_ERROR`) | corrigir, não reenviar igual |
| `404` | wallet ou transação inexistente | não reenviar |
| `409` | `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` | não reenviar |
| `422` | rejeição de negócio (`status: REJECTED` + `failureCode`) | ver o `failureCode` |
| `500` | transação `FAILED` (`PERMANENT_INFRASTRUCTURE_FAILURE`, `retryable: false`): esgotou as tentativas de infraestrutura | não reenviar com a mesma key; conciliar |
| `503` | falha transitória de infraestrutura (`Retry-After`) | **reenviar com a mesma key** |

Erros têm sempre o formato `{ "error": { "code", "message", "retryable", "details?" } }`.

### Exemplo

```bash
W=$(curl -s -XPOST localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}')
WID=$(echo "$W" | sed -E 's/.*"id":"([^"]+)".*/\1/')

curl -s -XPOST localhost:3002/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",\"walletId\":\"$WID\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

`REFUND` e `ROLLBACK` levam `"referenceExternalTransactionId": "<id da transação no provedor>"`.

### Via SQS

Publique em `wager-transactions.fifo` (com `MessageGroupId = walletId`) o envelope do enunciado:

```json
{ "messageId": "msg-123", "type": "WagerTransactionRequested", "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "transaction-123", "idempotencyKey": "provider-a:transaction-123", "...": "..." } }
```

Os eventos de integração (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`, `WagerTransactionFailed`) saem em `wagering-events.fifo`, **na ordem do commit por wallet** (`MessageGroupId = walletId`, atributos `eventId` e `sequence`).

## Configuração

Todas as variáveis têm default e estão em [`src/config.ts`](src/config.ts). As principais:

| variável | default | |
|---|---|---|
| `DB_HOST` / `DB_PORT` / `DB_NAME` | `localhost` / `5432` / `wagering` | |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima por lock de wallet (vira 503 / retry) |
| `SQS_ENDPOINT` | `http://localhost:4566` | |
| `SQS_MAX_RECEIVE_COUNT` | `5` | tentativas antes da DLQ (igual ao `maxReceiveCount` da redrive policy) |
| `PENDING_REFERENCE_BASE_DELAY_MS` / `_MAX_ATTEMPTS` | `1000` / `10` | backoff exponencial das referências fora de ordem |
| `OUTBOX_LEASE_MS` | `15000` | lease de uma linha da outbox reivindicada por um publisher |
| `OUTBOX_RETENTION_HOURS` / `INBOX_RETENTION_HOURS` | `168` / `360` | limpeza de outbox publicada / inbox processada (inbox > 14 dias da retenção máxima do SQS) |
| `CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `PENDING_REFERENCE_WORKER_ENABLED`, `RETENTION_ENABLED` | `true` | liga/desliga cada worker por instância |
| `FAULT_INJECTION` | — | `after-commit-before-ack` (**só para testes**: mata o processo entre o commit e o ack) |

## Estrutura

```
src/
  domain/            Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos, hash canônico
  application/       use cases + portas (UnitOfWork, repositórios, Clock, IdGenerator, Metrics, ProviderIdentity)
  infrastructure/
    persistence/     MikroORM (EntitySchemas + LockMode), migrations, repositórios, unit of work, outbox, retenção
    messaging/       consumer SQS, outbox publisher, workers periódicos
    observability/   logger JSON (pino), métricas (prom-client)
  http/              controllers, OpenAPI/Swagger, mapeamento de erros → HTTP, health, guard de auth (no-op)
test/
  unit/ integration/ concurrency/ load/ support/
scripts/
  showcase.ts        processo completo (Docker, testes, demo, logs, tour do Swagger)
  swagger.ts         sobe infra + API e abre o Swagger
  swagger-tour.ts    executa todas as operações no Swagger UI (Chrome ou Edge)
  demo.ts            cenários do desafio contra a API
docs/
  DATABASE.md        diagrama do banco, garantias e consultas
  schema.sql         schema completo (pg_dump)
.github/workflows/   CI: typecheck, unidade, integração e concorrência
```

Pré-requisitos: Docker (Compose v2) e Bun ≥ 1.2. O `swagger:tour` usa o Chrome (ou o Edge) já instalado.
