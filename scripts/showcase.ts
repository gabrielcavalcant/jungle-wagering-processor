/**
 * `bun run tudo` — the whole challenge, end to end, in one command:
 *   1. Docker Compose: PostgreSQL + LocalStack + migrations + 3 app instances (waits until healthy)
 *   2. typecheck (TypeScript strict)
 *   3. unit tests · 4. integration tests · 5. concurrency tests (real PostgreSQL/SQS, real processes)
 *   6. scenario demo against the Docker instances
 *   7. logs of the 3 instances · 8. summary
 *   9. opens Swagger UI and streams the instances' logs live (Ctrl+C to stop following).
 * Flags: --sem-testes (skip 3–5) · --rapido (skip only the slow concurrency suite)
 */
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const args = new Set(process.argv.slice(2));
const API = 'http://localhost:3001';
const c = { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m', reset: '\x1b[0m' };

interface Result { name: string; ok: boolean | 'skipped'; seconds: number }
const results: Result[] = [];

function banner(n: number, total: number, name: string, section: string, what: string) {
  const line = '═'.repeat(78);
  console.log(`\n${c.cyan}${line}${c.reset}`);
  console.log(`${c.cyan}${c.bold} ETAPA ${n}/${total} · ${name}${c.reset}  ${c.magenta}${section}${c.reset}`);
  console.log(`${c.dim} ${what}${c.reset}`);
  console.log(`${c.cyan}${line}${c.reset}\n`);
}

async function exec(cmd: string[], env: Record<string, string> = {}): Promise<boolean> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '1', ...env }, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
  return (await proc.exited) === 0;
}

async function step(name: string, fn: () => Promise<boolean>, skip = false) {
  if (skip) {
    results.push({ name, ok: 'skipped', seconds: 0 });
    console.log(`${c.yellow}  (pulado)${c.reset}`);
    return;
  }
  const started = performance.now();
  const ok = await fn().catch((e) => {
    console.error(e);
    return false;
  });
  const seconds = (performance.now() - started) / 1000;
  results.push({ name, ok, seconds });
  console.log(`\n${ok ? c.green + '  ✓ OK' : c.red + '  ✗ FALHOU'}${c.reset} ${c.dim}(${seconds.toFixed(1)} s)${c.reset}`);
}

function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : process.platform === 'darwin' ? ['open', url] : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    /* URL is printed anyway */
  }
}

const TOTAL = 9;
const bun = process.execPath;
const skipTests = args.has('--sem-testes');

console.log(`${c.bold}
  Distributed Wagering Processor — execução completa do desafio
${c.reset}${c.dim}  Cada etapa mostra qual parte do enunciado está sendo provada.
  Flags: --rapido (pula concorrência) · --sem-testes (só sobe, demonstra e abre o Swagger)${c.reset}`);

banner(1, TOTAL, 'Infraestrutura com Docker Compose', '§4 Stack · §8 múltiplas instâncias',
  'PostgreSQL, LocalStack (SQS com DLQ), migrations e 3 instâncias da aplicação (portas 3001, 3002, 3003).');
await step('Docker Compose (Postgres + SQS + 3 instâncias)', async () => {
  const ok = await exec(['docker', 'compose', 'up', '-d', '--build', '--wait']);
  await exec(['docker', 'compose', 'ps', '--format', 'table {{.Service}}\t{{.Status}}\t{{.Ports}}']);
  return ok;
});

banner(2, TOTAL, 'TypeScript em modo estrito', '§4 Stack obrigatória', 'tsc --noEmit com strict, noUncheckedIndexedAccess etc. Nenhum `number` para dinheiro.');
await step('Typecheck', () => exec([bun, 'run', 'typecheck']), skipTests);

banner(3, TOTAL, 'Testes de unidade', '§13 Unidade · §6 Modelo · §7 Regras',
  'Money (escala, entradas inválidas, moedas), Wallet, BET/WIN/LOSS/REFUND/ROLLBACK, máquina de estados, idempotência com payload divergente.');
await step('Testes de unidade', () => exec([bun, 'test', 'test/unit']), skipTests);

banner(4, TOTAL, 'Testes de integração (PostgreSQL e LocalStack reais)', '§13 Integração · §5 Restrições · §10 SQS · §11 Outbox',
  'Migrations up/down, cada constraint do banco, atomicidade, inbox e redelivery, retry e DLQ, FAILED, outbox com publishers concorrentes, retenção, SIGTERM.');
await step('Testes de integração', () => exec([bun, 'test', 'test/integration', '--timeout', '120000']), skipTests);

banner(5, TOTAL, 'Testes de concorrência (processos reais)', '§13 Concorrência 1–8 · §8 Cenário obrigatório',
  '50 duplicatas → 1 débito · 100/80/80 · carteiras em paralelo · 3 instâncias · crash entre commit e ack · fora de ordem · restart · queda do Postgres.');
await step('Testes de concorrência', () => exec([bun, 'test', 'test/concurrency', '--timeout', '240000']), skipTests || args.has('--rapido'));

banner(6, TOTAL, 'Demonstração dos cenários na aplicação rodando no Docker', '§7 Regras · §8 · §9 API · §10 SQS',
  `Chamadas reais na instância app-1 (${API}); a mensagem SQS é consumida por qualquer uma das 3 instâncias.`);
await step('Demonstração', async () => {
  // The outage test restarts PostgreSQL: make sure the instances are serving again before the demo.
  await exec(['docker', 'compose', 'up', '-d', '--wait', 'postgres', 'app-1', 'app-2', 'app-3']);
  return exec([bun, 'run', 'scripts/demo.ts'], { API_URL: API });
});

banner(7, TOTAL, 'Logs estruturados das 3 instâncias', '§12 Observabilidade',
  'JSON com correlationId, messageId, transactionId, walletId, providerId — sem valores nem saldos.');
await step('Logs', async () => {
  await exec(['docker', 'compose', 'logs', '--no-log-prefix', '--tail', '6', 'app-1', 'app-2', 'app-3']);
  console.log(`\n${c.dim}  Métricas (GET ${API}/metrics):${c.reset}`);
  const metrics = await (await fetch(`${API}/metrics`)).text();
  metrics.split('\n').filter((l) => /^wagering_(transactions_total|duplicates|outbox_lag|wallet_lock_wait_seconds_count|sqs_messages)/.test(l)).slice(0, 12)
    .forEach((l) => console.log(`  ${c.dim}${l}${c.reset}`));
  return true;
});

banner(8, TOTAL, 'Resumo', 'tudo que o enunciado pede, executado agora', '');
for (const r of results) {
  const mark = r.ok === 'skipped' ? `${c.yellow}–  pulado ` : r.ok ? `${c.green}✓  OK     ` : `${c.red}✗  FALHOU `;
  console.log(`  ${mark}${c.reset} ${r.name.padEnd(48)} ${c.dim}${r.ok === 'skipped' ? '' : r.seconds.toFixed(1) + ' s'}${c.reset}`);
}
const failed = results.filter((r) => r.ok === false).length;
console.log(`\n  ${failed ? `${c.red}${failed} etapa(s) falharam` : `${c.green}${c.bold}Tudo certo.`}${c.reset}`);

banner(9, TOTAL, 'Swagger UI + logs ao vivo', '§9 API',
  'O Swagger abre no navegador com as caixas já editáveis e preenchidas com exemplos. Abaixo, os logs das 3 instâncias em tempo real.');
console.log(`  ${c.green}●${c.reset} Swagger:  ${c.bold}${API}/docs${c.reset}   (também em :3002 e :3003)`);
console.log(`  ${c.green}●${c.reset} Health:   ${API}/health/ready`);
console.log(`  ${c.green}●${c.reset} Métricas: ${API}/metrics`);
console.log(`\n  ${c.dim}Ctrl+C para parar de acompanhar os logs (as instâncias continuam no ar; \`docker compose down\` derruba tudo).${c.reset}\n`);
openBrowser(`${API}/docs`);
await exec(['docker', 'compose', 'logs', '-f', '--tail', '0', 'app-1', 'app-2', 'app-3']);
process.exit(failed ? 1 : 0);
