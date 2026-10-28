# ARCHITECTURE

Este documento explica **por que** o sistema é como é. A regra que guiou cada decisão:

> **O banco é a última linha de defesa.** Toda invariante financeira existe duas vezes: no domínio (para dar erro cedo e com significado) e no schema do PostgreSQL (para valer mesmo com bug, com N instâncias ou com alguém rodando SQL na mão).

---

## 1. Visão geral

```
            HTTP (NestJS)                     SQS wager-transactions.fifo
                 │                                       │  (inbox por consumerName+messageId)
                 ▼                                       ▼
        ┌──────────────────── SubmitWagerTransactionUseCase ────────────────────┐
        │   1 transação SQL:  inbox? → lock da wallet (FOR UPDATE) →            │
        │   idempotência → regras (TransactionProcessor) → tx + wallet + ledger │
        │   + outbox → COMMIT                                                   │
        └───────────────────────────────────────────────────────────────────────┘
                 │ ack/resposta só depois do commit
                 ▼
   OutboxPublisher (lease + SKIP LOCKED) ──► SQS wagering-events.fifo
   PendingReferenceWorker (backoff)      ──► reprocessa PENDING_REFERENCE pelo mesmo TransactionProcessor
```

- **Uma única implementação das regras** (`TransactionProcessor`), usada por HTTP, SQS e pelo worker de referências.
- Camadas: `domain` (sem Nest, sem ORM) → `application` (use cases e **portas**) → `infrastructure` / `http` (adaptadores). O domínio não importa nada de fora dele.
- Todas as instâncias são iguais e sem estado: cada uma roda HTTP, consumer, publisher e worker. Escalar é subir mais réplicas.

## 2. Modelo de domínio

| classe | papel | garantias |
|---|---|---|
| `Money` | valor imutável | `bigint` em centavos internamente; entrada/saída como string com 2 casas; rejeita `NaN`, `Infinity`, `1e5`, `""`, `10.001`, negativos (em contrato de entrada), moeda fora de ISO-4217; operação entre moedas diferentes → `CurrencyMismatchError`. **Nenhum `number` toca dinheiro.** |
| `Wallet` (aggregate root) | saldo + versão | só muda por `debit`/`credit`, que **devolvem a `WalletLedgerEntry`** daquela mudança, então saldo e ledger não têm como divergir em memória. `version` começa em 1 e sobe 1 por mudança de saldo. |
| `WagerTransaction` | máquina de estados | construtor privado; `create` (nasce `PENDING`, valida referência por kind, recusa `OPENING`), `createOpening` (interno), `rehydrate` (não revalida). Transições explícitas; terminal → erro de programação (`InvalidTransactionStateError`). |
| `WalletLedgerEntry` | fato contábil | `Object.freeze`, sem setters; `create` valida `balanceBefore ± money = balanceAfter`, valor > 0, saldo final ≥ 0. |
| `InboxMessage`, `OutboxMessage` | dedup / publicação | `OutboxMessage.scheduleRetry` faz backoff exponencial com jitter (500 ms → 60 s). |
| `IntegrationEvent<T>` | envelope abstrato | uma subclasse por evento, com `eventType` e `version` **no tipo**; `data` só carrega `MoneyProps` (string). |

### Máquina de estados de `WagerTransaction`

```
PENDING ──► PROCESSED            (terminal)
   │   ├──► REJECTED             (terminal, failureCode obrigatório)
   │   ├──► FAILED               (terminal, failureCode obrigatório)
   │   └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
   │                    └──► PENDING_REFERENCE   (nova tentativa: attempts++, nextCheckAt)
```

`PENDING` só existe em memória durante a avaliação: a transação é avaliada e gravada **já no estado final** dentro da mesma transação SQL. O banco reforça isso: o trigger `wager_tx_guard_update` recusa qualquer UPDATE em linha terminal e qualquer alteração dos campos de negócio.

## 3. Regras de negócio e interpretações

| operação | saldo | ledger | observação |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | sem saldo → `REJECTED / INSUFFICIENT_FUNDS` |
| `WIN` | crédito | 1 `CREDIT` | referência opcional; se vier, precisa ser `BET` válida da mesma rodada |
| `LOSS` | — | — | `PROCESSED` sem lançamento; emite `WagerTransactionProcessed` mas **não** `WalletBalanceChanged`; valor pode ser `0.00` |
| `REFUND` | crédito | 1 `CREDIT` | só referencia `BET` `PROCESSED`, valor igual |
| `ROLLBACK` | inverso | 1 entrada invertida | referencia `BET` (→ crédito), `WIN` (→ débito) ou `REFUND` (→ débito) |

**Interpretações adotadas (documentadas porque o enunciado deixa margem):**

1. **Uma referência só pode ser revertida uma vez *no total*** (REFUND **ou** ROLLBACK), e não "uma vez por tipo". Ler "por tipo" ao pé da letra permitiria `REFUND(bet)` e depois `ROLLBACK(bet)`, devolvendo o mesmo dinheiro duas vezes. Para desfazer um REFUND, o caminho é `ROLLBACK(refund)`. Garantia no banco: índice único parcial `wager_tx_single_reversal_uq (reference_transaction_id) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')`.
2. Uma referência que existe mas ainda está `PENDING_REFERENCE` (por exemplo, o ROLLBACK de um WIN que espera a BET) é tratada como **ainda não disponível**: a dependente também espera. Uma referência `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`.
3. **Wallet inexistente não vira transação `REJECTED` persistida.** A transação tem FK para a wallet e não existe wallet para auditar. HTTP responde `404` e SQS manda para a DLQ (`wallet_not_found`).
4. `playerId` diferente do dono da wallet → `REJECTED / WALLET_PLAYER_MISMATCH` (persistido e auditável).
5. O mesmo `(providerId, externalTransactionId)` com **outra** `Idempotency-Key` → `409 EXTERNAL_TRANSACTION_ID_CONFLICT`. A key é a fonte da verdade, mas um id do provedor não pode virar duas transações.
6. `resultBalance` (o "saldo observado") é o saldo da wallet logo depois de a transação chegar ao estado atual, inclusive em rejeições e `LOSS`. É exatamente o que o replay devolve.

### Taxonomia de `failureCode` (`src/domain/failure-codes.ts`)

| código | quando | o provedor pode reenviar? |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | sim, **com outra key**, depois de depósito |
| `REVERSAL_INSUFFICIENT_FUNDS` | REFUND/ROLLBACK que deixaria o saldo negativo (ex.: rollback de WIN já gasto) | não, exige operação manual |
| `CURRENCY_MISMATCH` | moeda da operação ≠ moeda da wallet | não, corrigir payload |
| `WALLET_PLAYER_MISMATCH` | wallet não pertence ao player | não |
| `REFERENCE_NOT_FOUND` | a referência não chegou dentro da janela de retry | não |
| `REFERENCE_MISMATCH` | referência de outro player/wallet/rodada/moeda | não |
| `REFERENCE_INVALID_KIND` | REFUND→não-BET, ROLLBACK→LOSS/ROLLBACK/OPENING | não |
| `REFERENCE_NOT_PROCESSED` | referência `REJECTED`/`FAILED` | não |
| `REFERENCE_ALREADY_REVERSED` | a referência já foi revertida | não (é o resultado correto) |
| `AMOUNT_MISMATCH` | valor ≠ valor da referência (reversão parcial fora de escopo) | não |
| `PERMANENT_INFRASTRUCTURE_FAILURE` | status `FAILED`: a mensagem esgotou as tentativas por erro de infraestrutura e foi para a DLQ | não com a mesma key (o replay devolve `FAILED`); exige conciliação/novo envio |

### Referências fora de ordem

- A transação fica `PENDING_REFERENCE` com `next_reference_check_at`, e o evento `WagerTransactionPendingReference` é emitido **uma vez** (na primeira vez que ela é estacionada).
- O worker reavalia com **backoff exponencial**: `1 s · 2^n`, teto 60 s, **10 tentativas** (≈ 5 min de janela). Na prática, provedores mandam o par fora de ordem com segundos de diferença. Cinco minutos cobrem atrasos de fila e reprocessamentos sem prender a resposta ao provedor indefinidamente. Tudo é configurável (`PENDING_REFERENCE_*`).
- **Atalho:** quando a referência é processada, a mesma transação SQL antecipa (`expediteDependents`) o `next_reference_check_at` das dependentes da mesma wallet, então a resolução sai no próximo tick (≤ 1 s) em vez de esperar o backoff.
- Esgotou → `REJECTED / REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.

## 4. Concorrência

**A unidade de concorrência é a wallet.** Estratégia: **lock pessimista na linha da wallet + update condicional por versão + constraints**.

1. Toda escrita financeira começa com `SELECT … FROM wallets WHERE id = $1 FOR UPDATE`. Escritores da mesma wallet fazem fila nesse ponto e wallets diferentes nunca se bloqueiam. **Não existe lock global** (restrição 6).
2. Depois do lock, a idempotência é relida. Em `READ COMMITTED` cada statement enxerga o último commit, então a segunda de duas requisições idênticas vê a primeira.
3. O saldo é gravado com `UPDATE wallets SET balance=$new, version=$v+1 WHERE id=$id AND version=$v`. Zero linhas afetadas → `ConcurrencyConflictError` → retry limitado (4×). Com o lock isso nunca deveria acontecer: é **defesa em profundidade** contra um caminho de código que esqueça o lock. Isso elimina o `read → calculate → update` sem controle (restrição 7).
4. O schema fecha o resto: `CHECK (balance >= 0)`, trigger de versão (+1 só quando o saldo muda), uniques de idempotência.

**Por que pessimista e não otimista puro?** Em iGaming a wallet "quente" (um jogador fazendo várias apostas por segundo, ou WIN + BET da próxima rodada chegando juntos) é o caso normal. No otimista puro, N disputas geram N−1 aborts e retries, com risco de starvation. No pessimista elas viram uma fila curta e ordenada, sem trabalho desperdiçado. O custo é a latência de fila na wallet quente, que o teste de carga mede (§10).

**Contra lock pendurado:** cada transação roda com `SET LOCAL lock_timeout = 5s` e `statement_timeout = 15s`. Estourou → `TransientInfrastructureError` → HTTP `503 + Retry-After` / SQS retry com backoff. Nada fica preso para sempre.

**Ordem de locks (sem deadlock):** sempre `wallet → linhas da transação`. O worker de referências lê candidatas **sem lock**, depois trava a wallet com `FOR UPDATE SKIP LOCKED` (wallet ocupada → pula, volta no próximo tick) e só então relê a transação. `expediteDependents` só toca transações **da mesma wallet** que já está travada.

**Duplicatas sem fila no lock:** se a idempotency key já existe em estado terminal, o replay é respondido **antes** de pedir o lock (transação terminal é imutável, então a leitura é segura). As 50 duplicatas paralelas do teste não ficam esperando na fila da wallet quente.

**FIFO do SQS é otimização, não garantia.** `MessageGroupId = walletId` reduz a contenção e mantém a ordem por wallet, mas a correção não depende disso: se a FIFO entregar fora de ordem, duplicar ou outra instância processar ao mesmo tempo, o lock e as constraints seguram (restrição 3).

## 5. Idempotência

- **Fonte da verdade:** header `Idempotency-Key` (HTTP) ou `data.idempotencyKey` (SQS), `UNIQUE` no banco (`wager_tx_idempotency_key_uq`). Também `UNIQUE (provider_id, external_transaction_id)`.
- **`payloadHash`** = `sha256_hex(canonicalJSON(subset))`, com:
  - `subset` = `{providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money:{amount, currency}, referenceExternalTransactionId?}`. O header, o `messageId`, o `occurredAt` e o `correlationId` **não** entram;
  - `money.amount` normalizado antes (`"10"` e `"10.00"` são o mesmo payload);
  - JSON canônico: chaves ordenadas lexicograficamente e de forma recursiva, sem espaços, membros `undefined` removidos (`src/domain/payload-hash.ts`).
- Mesma key + mesmo hash → resposta original, com `idempotentReplay: true`, inclusive o saldo da época e a rejeição, se houve.
- Mesma key + hash diferente → `409 IDEMPOTENCY_KEY_CONFLICT`, **nunca** replay.
- Corrida entre duas inserções da mesma key em wallets diferentes: o `UNIQUE` estoura (`IdempotencyRaceError`), o use case refaz a tentativa, encontra a linha e responde replay ou conflito.
- **Nada em memória:** nenhum cache participa da decisão (restrição 2).

## 6. Mensageria e falhas

### Consumer SQS (`src/infrastructure/messaging/wager-consumer.ts`)

| situação | ação |
|---|---|
| `PROCESSED` / `REJECTED` / `PENDING_REFERENCE` / replay | **ack após o commit** |
| JSON ou schema inválido, `VALIDATION_ERROR`, conflito de idempotência, wallet inexistente | **permanente** → DLQ na hora, com `dlqReason` |
| `TransientInfrastructureError` (DB fora, lock timeout, deadlock) ou erro inesperado | **transitório** → `ChangeMessageVisibility` com backoff `2 s · 2^(receiveCount−1)` (teto 300 s) |
| `ApproximateReceiveCount ≥ SQS_MAX_RECEIVE_COUNT` | grava a transação como **`FAILED / PERMANENT_INFRASTRUCTURE_FAILURE`** (+ evento `WagerTransactionFailed`) e manda para a DLQ (`max_receive_count`); a redrive policy da fila é o backstop para quando o processo morre antes de decidir |

**`FAILED` (`RecordPermanentFailureUseCase`):** numa transação SQL separada, trava a wallet e: transação já terminal → não mexe (ex.: o commit funcionou, mas o ack falhou); `PENDING_REFERENCE` → vira `FAILED`; inexistente → é inserida direto como `FAILED`, sem movimentar saldo e sem lançamento. Assim o provedor recebe um desfecho em vez de esperar para sempre, e um reenvio da mesma key devolve `FAILED` (nunca aplica depois). É *best effort*: se o que caiu foi o próprio banco, a gravação também falha e a mensagem na DLQ fica como trilha de auditoria.

- **Inbox persistente** `(consumer_name, message_id)`: inserida com `ON CONFLICT DO NOTHING` **na mesma transação SQL** do efeito. Ela é gravada junto com o efeito ou não é gravada: um crash antes do commit não deixa inbox "processada" sem efeito.
- Mensagens do mesmo `MessageGroupId` no batch rodam em sequência; grupos diferentes, em paralelo.
- **SIGTERM:** `enableShutdownHooks` → `beforeApplicationShutdown` → para de receber (aborta o long-poll), espera as mensagens em andamento e devolve as que nem começaram com `VisibilityTimeout=0`. A readiness passa a responder 503 durante o shutdown. No compose, `stop_grace_period: 40s`.

### Transactional Outbox

- O evento é gravado em `outbox_messages` **na mesma transação** da mudança financeira. Publicação antes do commit é impossível por construção (restrição 4).
- **Publishers concorrentes, com lease e ordem por wallet:**
  1. statement único: para cada wallet, olha a **cabeça** do seu fluxo não publicado (menor `sequence`). A wallet só é reivindicada se a cabeça está vencida e sem lease **e** se o statement ganha `pg_try_advisory_xact_lock(wallet)`. Assim dois publishers nunca pegam eventos da mesma wallet ao mesmo tempo, mas wallets diferentes são publicadas em paralelo. As linhas recebem `locked_by` e `locked_until`;
  2. publica **fora** de qualquer transação (nenhum lock fica preso durante I/O de rede), via `SendMessageBatch`, wallet a wallet em ordem de `sequence`;
  3. marca `published_at` em lote, com a condição `locked_by = eu` (quem perdeu o lease não sobrescreve). Se um evento falha, ele recebe backoff e **trava o resto do fluxo daquela wallet** até sair: os eventos de uma wallet chegam na fila na ordem do commit. Cada mensagem leva o atributo `sequence`.
- **Cenário do enunciado:** commit → processo morre antes de publicar → o lease expira (`OUTBOX_LEASE_MS`) → outra instância reivindica e publica. Testado em `messaging.test.ts` e no teste 8 de concorrência.
- **Entrega at-least-once**, segura para o consumidor: `eventId` = id da linha (estável entre republicações), enviado como `MessageDeduplicationId` (dedup de 5 min da FIFO) e no corpo, para o consumidor deduplicar. `WalletBalanceChanged` traz `walletVersion`, que dá ordem total por wallet.
- Falha de publicação → `attempts++`, `next_attempt_at` com backoff exponencial + jitter, `last_error`.
- O conteúdo do evento é imutável no banco (trigger `outbox_guard_update`).

### Retenção (limpeza)

Job periódico em todas as instâncias (`RetentionStore`), com deleção em lotes e `FOR UPDATE SKIP LOCKED` (instâncias concorrentes nunca apagam a mesma linha duas vezes):
- `outbox_messages` **já publicadas** há mais de `OUTBOX_RETENTION_HOURS` (padrão 7 dias). As pendentes nunca são apagadas;
- `inbox_messages` **já processadas** há mais de `INBOX_RETENTION_HOURS` (padrão **15 dias**). Esse valor precisa ser maior que a retenção máxima do SQS (14 dias): se a linha de dedup sumisse antes, uma redelivery atrasada poderia ser aplicada de novo;
- ledger, transações e wallets **nunca** são apagados: são a trilha de auditoria (e o banco recusa).

## 7. Schema (o que o PostgreSQL garante)

Migrations (em `src/infrastructure/persistence/migrations/`, todas com `down()`, testadas indo a zero e voltando):
- `Migration20261028000001_initial_schema`: tabelas, constraints e triggers abaixo;
- `Migration20261028000002_ordering_retention_result_currency`: coluna `result_currency` (com backfill e `CHECK` de que ela existe se e só se `result_balance` existe), índice `(aggregate_id, sequence)` das cabeças da outbox e índices parciais para a retenção.

| garantia | mecanismo |
|---|---|
| 1 wallet por `player_id + currency` | `UNIQUE (player_id, currency)` |
| saldo nunca negativo | `CHECK (balance >= 0)`, também em `balance_before/after` e `result_balance` |
| dinheiro exato | `numeric(20,2)` + `char(3)` para moeda; o `pg` devolve string, convertida para `Money` sem passar por float |
| versão só anda com o saldo, +1 | trigger `wallet_guard_update` |
| **saldo ⇔ ledger** | *constraint triggers* `DEFERRABLE INITIALLY DEFERRED` em `wallets` e `wallet_ledger_entries`: no **COMMIT** exige `wallets.balance = balance_after` do último lançamento. Mudar o saldo sem ledger (ou o contrário) aborta a transação |
| aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)` + `amount > 0` |
| encadeamento | trigger `ledger_check_chain`: `balance_before` = `balance_after` anterior da wallet |
| moeda do lançamento = moeda da wallet | FK composta `(wallet_id, currency) → wallets(id, currency)` |
| no máximo 1 lançamento por transação/wallet | `UNIQUE (wallet_id, transaction_id)` |
| ledger imutável | triggers que recusam `UPDATE`, `DELETE` e `TRUNCATE` |
| idempotência | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` |
| REFUND/ROLLBACK têm referência | `CHECK` |
| `failure_code` ⇔ `REJECTED/FAILED` | `CHECK` |
| reversão única | índice único parcial `wager_tx_single_reversal_uq` |
| estado terminal imutável; transações não são apagadas | triggers `wager_tx_guard_update` e `forbid_delete` |
| inbox | `PRIMARY KEY (consumer_name, message_id)` |

Índices para os caminhos quentes: parcial `(next_reference_check_at) WHERE status='PENDING_REFERENCE'`, parcial `(next_attempt_at, sequence) WHERE published_at IS NULL`, `(wallet_id, sequence)` para o ledger paginado. Os ids são **UUIDv7** (ordenados no tempo), o que deixa as inserções em B-tree praticamente append-only.

## 8. Persistência: por que MikroORM, e como

- **MikroORM** (preferência do enunciado) cuida de: pool de conexões, **Unit of Work transacional** (`em.fork().transactional()` com `IsolationLevel.READ_COMMITTED`, um fork novo por operação, sem Identity Map compartilhado), **migrations versionadas e reversíveis** (lista explícita, sem glob, para funcionar igual em Bun, Docker e testes) e **leituras + locks via `EntitySchema`** (`src/infrastructure/persistence/entities.ts`).
- **Lock pela API do ORM:** `em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE })` gera o `SELECT … FOR UPDATE`. No worker de referências, `LockMode.PESSIMISTIC_PARTIAL_WRITE` gera o `FOR UPDATE SKIP LOCKED`. Um teste de integração prova os dois comportamentos (bloqueia / pula).
- **Leituras** (`findOne`, `find`, `count`) usam as entidades com `disableIdentityMap: true`. Dentro de uma transação a mesma linha é lida antes e depois do lock da wallet, e a segunda leitura precisa ver o último commit, não a cópia em cache do Identity Map.
- **Escritas críticas continuam em SQL explícito** (`em.execute()` dentro da mesma transação do MikroORM): `UPDATE … WHERE version = ?` com checagem de linhas afetadas, `INSERT … ON CONFLICT DO NOTHING RETURNING`, CTE de claim da outbox com advisory lock. Motivos:
  - são exatamente os detalhes que o ORM esconderia, e aqui eles precisam ficar auditáveis linha a linha;
  - o flush implícito do Unit of Work decide a ordem das escritas, mas aqui a ordem importa (transação → wallet → ledger, por causa das FKs e dos constraint triggers);
  - o domínio continua 100% livre de decorators e tipos do ORM. As entidades são *registros de persistência*, e o mapeamento registro ↔ agregado fica em `repositories.ts` (factories `rehydrate`).
- **Mapeamento do `Money`:** duas colunas, `amount numeric(20,2)` (propriedade `decimal` → **string** no JS) e `currency char(3)`. Na leitura, `Money.parse({amount, currency})`. Na escrita, `money.amount` (string). Nenhum `number` participa. O saldo observado de uma transação tem a própria moeda (`result_currency`), porque numa rejeição por `CURRENCY_MISMATCH` ela difere da moeda da operação.

## 9. Observabilidade

- **Logs JSON (pino)** com `correlationId` (header `x-correlation-id` ou gerado), `messageId`, `transactionId`, `walletId`, `providerId`, `instanceId`, `status` e `failureCode`. **Nunca** valores, saldos ou payloads; há `redact` como rede de segurança.
- **Métricas Prometheus em `/metrics`:**

| métrica | cobre |
|---|---|
| `wagering_transactions_total{status,kind,source}` | transações por status |
| `wagering_duplicates_detected_total{kind}` | `idempotency_replay`, `inbox_message`, `idempotency_conflict` |
| `wagering_retries_total{operation,reason}` | retries do use case, do worker de referências |
| `wagering_sqs_dlq_messages_total{reason}` / `wagering_sqs_messages_total{outcome}` | DLQ e desfecho das mensagens |
| `wagering_wallet_lock_wait_seconds{mode}` | **quanto tempo cada escrita esperou o lock da wallet**: com lock pessimista, contenção aparece como espera, não como erro, então este é o sinal real de conflito |
| `wagering_lock_conflicts_total{reason}` | contenção que virou erro: `lock_timeout`, `deadlock`, `serialization_failure`, version mismatch, wallet ocupada (SKIP LOCKED) |
| `wagering_outbox_lag_seconds`, `wagering_outbox_pending` | outbox lag |
| `wagering_processing_latency_seconds{source}` | latência de processamento |
| `wagering_reconciliation_divergences_total` | divergências (com log `RECONCILIATION_DIVERGENCE`) |

- **Timeouts no cliente do banco:** `connectionTimeoutMillis`, `acquireTimeoutMillis` do pool e `query_timeout` no driver `pg`. Se o servidor congelar (partição de rede), o `statement_timeout` do lado do servidor não dispara; sem esses limites a requisição ficaria pendurada.
- **Swagger / OpenAPI:** `/docs` (UI interativa) e `/docs/openapi.json`, com cada código HTTP e o seu significado documentados.
- **Health:** `/health/live` (processo vivo) e `/health/ready` (`select 1` no PostgreSQL + `GetQueueAttributes` no SQS, com timeout de 2 s cada; 503 durante o shutdown). Ambos sem autenticação.

## 10. Testes e teste de carga

| nível | onde | o que prova |
|---|---|---|
| unidade (91) | `test/unit` | classificação de erros do banco (503 × 500); `Money` (escala, inválidos, arredondamento nunca silencioso), invariantes da `Wallet`, todas as regras por kind, conflito de moeda, payload divergente, máquina de estados, hash canônico |
| integração (30) | `test/integration` | migrations up/down; **cada constraint do schema testada com SQL direto**; atomicidade (falha na outbox desfaz tx + wallet + ledger + inbox); inbox + redelivery; crash antes do ack; DLQ permanente; retry + DLQ por `maxReceiveCount` com transação `FAILED`; 3 publishers concorrentes **mantendo a ordem por wallet**; cabeça com falha bloqueando o resto do fluxo; lease expirada; publicação com falha; retenção (só apaga o que pode, em lotes, concorrente); `LockMode` bloqueando / pulando |
| concorrência (10) | `test/concurrency` | **3 processos reais**: 50 duplicatas → 1 débito; 100/80/80 ×10; 20 wallets em paralelo; carga mista HTTP+SQS em wallets quentes; outbox com 3 publishers; REFUND/ROLLBACK antes da referência (HTTP e SQS); referência que nunca chega; **processo morto entre o commit e o ack** (`FAULT_INJECTION`, exit 137); **SIGKILL nas 3 instâncias no meio da carga + restart**; **queda real do PostgreSQL** (container parado com tráfego HTTP + SQS: 503 rápido, readiness 503, mensagens sem ir para a DLQ e, ao voltar, cada efeito aplicado exatamente uma vez) |
| shutdown (2) | `test/integration/graceful-shutdown` | SIGTERM: a mensagem em andamento termina e é confirmada, as não iniciadas voltam para a fila na hora; processo real recebendo SIGTERM drena e sai (só em POSIX/CI, porque no Windows o sinal mata na hora) |

**CI:** GitHub Actions (`.github/workflows/ci.yml`) roda typecheck + unidade e, com PostgreSQL e LocalStack via Docker Compose, integração e concorrência a cada push.

Todos terminam verificando `wallet.balance == Σ ledger` (+ encadeamento, + nenhuma entrada duplicada).

**Carga** (`bun run test:load`, resultado em [`test/load/RESULTS.md`](test/load/RESULTS.md)). Num notebook i7-4500U (2C/4T) com cliente, 3 instâncias, PostgreSQL e LocalStack disputando a mesma CPU, 64 clientes e 30% do tráfego numa única wallet quente: **55–74 req/s entre rodadas, 0% de erro, p50 ≈ 0,2–0,3 s, p99 ≈ 9–12 s, reconciliação consistente em todas as wallets, outbox esvaziando em ~0,1 s após a carga.** A rodada mais recente (com leituras via entidades MikroORM) ficou no limite inferior: o ORM adiciona um pouco de custo de hidratação por leitura, e a máquina é compartilhada com o banco e o cliente de carga. A cauda é dominada pela fila de lock da wallet quente, que é o custo esperado do lock pessimista. Os números absolutos são um piso por causa do hardware; o resultado relevante é zero erro e zero divergência sob contenção. Uma otimização encontrada pelo próprio teste: marcar os eventos publicados em lote derrubou o tempo para esvaziar a outbox de 22,9 s para 0,1 s.

## 11. Autenticação (não implementada, por decisão)

O enunciado dá zero pontos para auth e pede que ela não compita com o núcleo. **Ponto de extensão no código:** a porta `ProviderIdentityPort` (`src/application/ports.ts`), o adaptador `NoopProviderIdentity` e o `ProviderAuthGuard` (`src/http/auth.ts`), aplicados aos controllers de wallet e wagering. Health e métricas ficam abertos.

**Desenho que eu adotaria:**
- **Keycloak** no compose, um realm `wagering`, **um client confidencial por provedor** com fluxo *client credentials* (máquina-para-máquina, sem usuário) e um claim `provider_id` via mapper.
- Adaptador `OidcProviderIdentity`: valida o JWT (assinatura via JWKS em cache, `iss`, `aud`, `exp`) e devolve `provider_id`.
- O guard já faz o vínculo identidade ↔ payload: autenticado como `provider-a` e mandando `providerId: provider-b` → `403 PROVIDER_FORBIDDEN`. O mesmo vale para a consulta `/providers/:providerId/...`.
- SQS é canal interno confiável (IAM), mas o `providerId` da mensagem continua passando pelas mesmas validações de domínio.

## 12. Limitações conhecidas e próximos passos

1. **Wallet quente:** o throughput de uma única wallet é limitado por 1/(tempo de lock). Mitigações possíveis: lock mais curto (pré-validação fora do lock), ou partições de saldo/reservas para jogadores de altíssimo volume.
2. **Ordem dos eventos, caso de borda:** se, num mesmo `SendMessageBatch`, um evento falha e um posterior da mesma wallet é aceito, o posterior já saiu (não dá para "desenviar"). O consumidor ainda consegue reordenar pelo atributo `sequence` / `walletVersion`. Para eliminar o caso, bastaria enviar um evento por vez por wallet, ao custo de throughput.
3. **`FAILED` é best effort:** se o banco está fora, a transação não pode ser gravada como `FAILED` e só a mensagem na DLQ registra o ocorrido. Um job de redrive da DLQ poderia gravar o `FAILED` quando o banco voltar.
4. **Ledger de partidas dobradas** (diferencial opcional) não foi feito: hoje é um razão por wallet com saldo encadeado. O próximo passo seria contas de contrapartida por provedor/jogo. Também falta particionar o ledger por tempo para volumes grandes.
5. **LocalStack fixado em 4.4**, porque as versões mais novas exigem auth token. O MiniStack é uma alternativa compatível.
6. Sem OpenTelemetry/tracing distribuído. O `correlationId` atravessa HTTP → outbox → eventos, mas não SQS de entrada → spans.
