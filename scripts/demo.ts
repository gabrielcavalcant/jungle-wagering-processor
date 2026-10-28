/**
 * `bun run demo` — walks through the challenge scenarios against a running API
 * (start it with `bun run swagger`) and prints, step by step, what happened.
 * API_URL defaults to http://localhost:3000.
 */
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const API = process.env.API_URL ?? 'http://localhost:3000';
const PROVIDER = 'demo-provider';
const run = Date.now().toString(36);

const c = { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m' };
let passed = 0;
let failed = 0;

function title(n: number, text: string, why: string) {
  console.log(`\n${c.cyan}${c.bold}━━ ${n}. ${text}${c.reset}`);
  console.log(`${c.dim}   ${why}${c.reset}`);
}
function show(label: string, value: string) {
  console.log(`   ${label.padEnd(34)} ${value}`);
}
function check(ok: boolean, text: string) {
  if (ok) passed++;
  else failed++;
  console.log(`   ${ok ? `${c.green}✓` : `${c.red}✗`} ${text}${c.reset}`);
}
const fmtStatus = (s: number) => (s < 300 ? c.green : s < 500 ? c.yellow : c.red) + s + c.reset;

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function newWallet(amount: string, tag: string) {
  const playerId = `jogador-${tag}-${run}`;
  const r = await http('POST', '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  return { walletId: r.body.id as string, playerId, res: r };
}

function wager(w: { walletId: string; playerId: string }, ext: string, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  return { providerId: PROVIDER, externalTransactionId: `${ext}-${run}`, playerId: w.playerId, walletId: w.walletId, roundId: `rodada-${run}`, gameId: 'fortune-chimp', kind, money: { amount, currency: 'BRL' }, ...extra };
}
const submit = (p: ReturnType<typeof wager>, key = `${p.providerId}:${p.externalTransactionId}`) =>
  http('POST', '/wagering/transactions', p, { 'Idempotency-Key': key });
const balance = async (walletId: string) => (await http('GET', `/wallets/${walletId}`)).body.balance.amount as string;
const ledger = async (walletId: string) => (await http('GET', `/wallets/${walletId}/ledger?limit=200`)).body.items as any[];

async function main() {
  try {
    await fetch(`${API}/health/ready`);
  } catch {
    console.error(`${c.red}A API não está respondendo em ${API}. Rode antes: bun run swagger${c.reset}`);
    process.exit(1);
  }
  console.log(`${c.bold}Demonstração do Wagering Processor${c.reset}  ${c.dim}(${API})${c.reset}`);

  // 1 ---------------------------------------------------------------------------------------
  title(1, 'Criar carteira com saldo inicial', 'O saldo inicial vira uma transação OPENING e um crédito no ledger, na mesma transação do banco.');
  const w = await newWallet('100.00', 'principal');
  show('POST /wallets', `${fmtStatus(w.res.status)}  saldo ${w.res.body.balance.amount} BRL, versão ${w.res.body.version}`);
  check(w.res.status === 201 && w.res.body.balance.amount === '100.00', 'carteira criada com 100.00');
  const dup = await http('POST', '/wallets', { playerId: w.playerId, initialBalance: { amount: '5.00', currency: 'BRL' } });
  show('mesma carteira de novo', `${fmtStatus(dup.status)}  ${dup.body.error.code}`);
  check(dup.status === 409, 'carteira duplicada é conflito (409)');

  // 2 ---------------------------------------------------------------------------------------
  title(2, 'Cenário obrigatório: duas apostas de 80.00 ao mesmo tempo', 'Saldo 100.00. As duas são enviadas em paralelo: o lock da carteira deixa passar só uma.');
  const [a, b] = await Promise.all([submit(wager(w, 'aposta-A', 'BET', '80.00')), submit(wager(w, 'aposta-B', 'BET', '80.00'))]);
  show('aposta A', `${fmtStatus(a.status)}  ${a.body.status}${a.body.failureCode ? ' · ' + a.body.failureCode : ''}`);
  show('aposta B', `${fmtStatus(b.status)}  ${b.body.status}${b.body.failureCode ? ' · ' + b.body.failureCode : ''}`);
  const statuses = [a.body.status, b.body.status].sort();
  check(statuses[0] === 'PROCESSED' && statuses[1] === 'REJECTED', 'exatamente uma PROCESSED e uma REJECTED');
  check([a, b].some((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS'), 'a rejeitada traz o motivo INSUFFICIENT_FUNDS');
  show('saldo final', `${await balance(w.walletId)} BRL`);
  check((await balance(w.walletId)) === '20.00', 'saldo final 20.00');
  check((await ledger(w.walletId)).filter((e) => e.direction === 'DEBIT').length === 1, 'exatamente 1 débito no ledger');

  // 3 ---------------------------------------------------------------------------------------
  title(3, 'Idempotência', 'Mesma Idempotency-Key e mesmo conteúdo devolvem a resposta original. Conteúdo diferente é conflito.');
  const replay = await submit(wager(w, 'aposta-A', 'BET', '80.00'));
  show('reenviar a aposta A', `${fmtStatus(replay.status)}  idempotentReplay=${replay.body.idempotentReplay}`);
  check(replay.body.idempotentReplay === true || replay.body.status === 'REJECTED', 'reenvio devolve o resultado original, sem debitar de novo');
  const conflict = await submit(wager(w, 'aposta-A', 'BET', '81.00'));
  show('mesma key, valor 81.00', `${fmtStatus(conflict.status)}  ${conflict.body.error?.code}`);
  check(conflict.status === 409, 'payload diferente com a mesma key é conflito (409)');

  // 4 ---------------------------------------------------------------------------------------
  title(4, 'A mesma aposta enviada 50 vezes em paralelo', 'Simula um provedor reenviando sem parar. Tem que debitar uma única vez.');
  const w4 = await newWallet('100.00', 'duplicatas');
  const p4 = wager(w4, 'aposta-repetida', 'BET', '10.00');
  const started = performance.now();
  const many = await Promise.all(Array.from({ length: 50 }, () => submit(p4)));
  show('50 requisições', `${Math.round(performance.now() - started)} ms`);
  show('respostas', `${many.filter((r) => r.body.idempotentReplay === false).length} nova, ${many.filter((r) => r.body.idempotentReplay === true).length} replays`);
  check(new Set(many.map((r) => r.body.transactionId)).size === 1, 'todas apontam para a mesma transação');
  check((await balance(w4.walletId)) === '90.00', 'saldo 90.00 (um único débito)');

  // 5 ---------------------------------------------------------------------------------------
  title(5, 'WIN e LOSS', 'WIN credita. LOSS registra o resultado sem mexer no saldo e sem lançamento no ledger.');
  const w5 = await newWallet('50.00', 'win-loss');
  await submit(wager(w5, 'bet-1', 'BET', '10.00'));
  const win = await submit(wager(w5, 'win-1', 'WIN', '35.00', { referenceExternalTransactionId: `bet-1-${run}` }));
  show('WIN 35.00', `${fmtStatus(win.status)}  saldo ${win.body.balance.amount}`);
  const entriesBefore = (await ledger(w5.walletId)).length;
  const loss = await submit(wager(w5, 'loss-1', 'LOSS', '0.00'));
  show('LOSS', `${fmtStatus(loss.status)}  saldo ${loss.body.balance.amount}`);
  check(win.body.balance.amount === '75.00', 'WIN creditou: 50 − 10 + 35 = 75.00');
  check(loss.body.status === 'PROCESSED' && (await ledger(w5.walletId)).length === entriesBefore, 'LOSS processada sem lançamento no ledger');

  // 6 ---------------------------------------------------------------------------------------
  title(6, 'Referência fora de ordem: REFUND chega antes da BET', 'O REFUND fica PENDING_REFERENCE; quando a BET chega, um worker resolve sozinho.');
  const w6 = await newWallet('100.00', 'fora-de-ordem');
  const refund = await submit(wager(w6, 'refund-1', 'REFUND', '30.00', { referenceExternalTransactionId: `bet-x-${run}` }));
  show('REFUND (antes da BET)', `${fmtStatus(refund.status)}  ${refund.body.status}`);
  check(refund.status === 202 && refund.body.status === 'PENDING_REFERENCE', 'aceito e aguardando a referência (202)');
  const bet6 = await submit(wager(w6, 'bet-x', 'BET', '30.00'));
  show('BET chega depois', `${fmtStatus(bet6.status)}  saldo ${bet6.body.balance.amount}`);
  let final = refund.body.status;
  for (let i = 0; i < 30 && final !== 'PROCESSED'; i++) {
    await Bun.sleep(500);
    final = (await http('GET', `/wagering/transactions/${refund.body.transactionId}`)).body.status;
  }
  show('REFUND depois do worker', final);
  check(final === 'PROCESSED', 'REFUND resolvido automaticamente');
  check((await balance(w6.walletId)) === '100.00', 'saldo voltou a 100.00');
  const again = await submit(wager(w6, 'refund-2', 'REFUND', '30.00', { referenceExternalTransactionId: `bet-x-${run}` }));
  show('segundo REFUND da mesma BET', `${fmtStatus(again.status)}  ${again.body.failureCode}`);
  check(again.body.failureCode === 'REFERENCE_ALREADY_REVERSED', 'não dá para reverter duas vezes');

  // 7 ---------------------------------------------------------------------------------------
  title(7, 'Reversão que deixaria o saldo negativo', 'ROLLBACK de um WIN que o jogador já gastou: rejeitado com um motivo diferente de "sem saldo".');
  const w7 = await newWallet('10.00', 'rollback');
  await submit(wager(w7, 'win-7', 'WIN', '50.00'));
  await submit(wager(w7, 'bet-7', 'BET', '55.00'));
  const rb = await submit(wager(w7, 'rb-7', 'ROLLBACK', '50.00', { referenceExternalTransactionId: `win-7-${run}` }));
  show('ROLLBACK do WIN', `${fmtStatus(rb.status)}  ${rb.body.failureCode}`);
  check(rb.body.failureCode === 'REVERSAL_INSUFFICIENT_FUNDS', 'motivo REVERSAL_INSUFFICIENT_FUNDS (≠ INSUFFICIENT_FUNDS)');
  check((await balance(w7.walletId)) === '5.00', 'saldo nunca fica negativo (5.00)');

  // 8 ---------------------------------------------------------------------------------------
  title(8, 'Validação de dinheiro e moeda', 'Dinheiro é texto com 2 casas. Notação científica, 3 casas ou outra moeda não passam.');
  for (const amount of ['1e5', '10.001', '-5.00']) {
    const r = await submit(wager(w7, `inv-${amount}`, 'BET', amount));
    show(`valor "${amount}"`, `${fmtStatus(r.status)}  ${r.body.error?.code}`);
    check(r.status === 400, `"${amount}" rejeitado com 400`);
  }
  const usd = await submit({ ...wager(w7, 'usd', 'BET', '1.00'), money: { amount: '1.00', currency: 'USD' } });
  show('aposta em USD numa carteira BRL', `${fmtStatus(usd.status)}  ${usd.body.failureCode}`);
  check(usd.body.failureCode === 'CURRENCY_MISMATCH', 'moeda diferente é rejeitada (CURRENCY_MISMATCH)');

  // 9 ---------------------------------------------------------------------------------------
  title(9, 'Pela fila SQS, com a mesma mensagem 3 vezes', 'Entrega "pelo menos uma vez": a inbox no banco garante que só um efeito acontece.');
  const sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566', region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const w9 = await newWallet('100.00', 'sqs');
  const queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }))).QueueUrl!;
  const data = { ...wager(w9, 'sqs-bet', 'BET', '25.00'), idempotencyKey: `${PROVIDER}:sqs-bet-${run}` };
  const body = JSON.stringify({ messageId: `msg-${run}`, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data });
  for (let i = 0; i < 3; i++) {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body, MessageGroupId: w9.walletId, MessageDeduplicationId: `${run}-${i}` }));
  }
  show('mensagens enviadas', '3 cópias da mesma aposta de 25.00');
  let b9 = '100.00';
  for (let i = 0; i < 40 && b9 === '100.00'; i++) {
    await Bun.sleep(500);
    b9 = await balance(w9.walletId);
  }
  await Bun.sleep(3_000); // tempo para as cópias serem processadas também
  b9 = await balance(w9.walletId);
  show('saldo depois', `${b9} BRL`);
  check(b9 === '75.00', 'debitou uma única vez (75.00)');

  // 10 --------------------------------------------------------------------------------------
  title(10, 'Extrato e reconciliação', 'O ledger é o extrato imutável. A reconciliação refaz o saldo somando o ledger.');
  const items = await ledger(w5.walletId);
  console.log(`   ${c.dim}seq  tipo     valor     antes     depois${c.reset}`);
  items.forEach((e, i) =>
    console.log(`   ${String(i + 1).padEnd(4)} ${(e.direction === 'CREDIT' ? c.green : c.red) + e.direction.padEnd(7) + c.reset} ${e.money.amount.padStart(7)}  ${e.balanceBefore.amount.padStart(8)}  ${e.balanceAfter.amount.padStart(8)}`),
  );
  for (const wid of [w.walletId, w4.walletId, w5.walletId, w6.walletId, w7.walletId, w9.walletId]) {
    const r = await http('POST', `/wallets/${wid}/reconciliation`);
    if (!r.body.consistent) check(false, `carteira ${wid} inconsistente`);
  }
  check(true, 'todas as carteiras da demo: saldo == soma do ledger');

  // 11 --------------------------------------------------------------------------------------
  title(11, 'Métricas que a API expõe', 'Trecho de GET /metrics (formato Prometheus).');
  const metrics = await (await fetch(`${API}/metrics`)).text();
  metrics
    .split('\n')
    .filter((l) => /^wagering_(transactions_total|duplicates_detected_total|sqs_messages_total|outbox_lag_seconds|outbox_pending)/.test(l))
    .slice(0, 14)
    .forEach((l) => console.log(`   ${c.dim}${l}${c.reset}`));

  console.log(`\n${c.bold}Resultado: ${c.green}${passed} verificações OK${c.reset}${failed ? `, ${c.red}${failed} falharam${c.reset}` : ''}`);
  console.log(`${c.dim}Explore à vontade no Swagger: ${API}/docs${c.reset}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
