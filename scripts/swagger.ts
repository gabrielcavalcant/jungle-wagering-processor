/**
 * `bun run swagger` — one command to see the API working:
 *   1. starts PostgreSQL + LocalStack (docker compose, waits until healthy);
 *   2. applies the migrations;
 *   3. starts one instance of the service on PORT (default 3000);
 *   4. opens Swagger UI at http://localhost:PORT/docs.
 * Ctrl+C stops the service (the containers keep running; `bun run infra:down` removes them).
 */
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const PORT = process.env.PORT ?? '3000';
const env = {
  ...process.env,
  PORT,
  DB_HOST: process.env.DB_HOST ?? 'localhost',
  DB_PORT: process.env.DB_PORT ?? '5433', // docker-compose maps Postgres to 5433 on the host
  SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  INSTANCE_ID: process.env.INSTANCE_ID ?? 'swagger',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
};

const step = (n: number, text: string) => console.log(`\n\x1b[36m[${n}/4]\x1b[0m ${text}`);

async function run(cmd: string[], label: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) {
    console.error(`\n\x1b[31m✗ ${label} falhou.\x1b[0m O Docker Desktop está aberto?`);
    process.exit(1);
  }
}

function openBrowser(url: string) {
  const cmd =
    process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : process.platform === 'darwin' ? ['open', url] : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    /* no browser available: the URL is printed anyway */
  }
}

step(1, 'Subindo PostgreSQL e LocalStack (SQS)…');
await run(['docker', 'compose', 'up', '-d', '--wait', 'postgres', 'localstack'], 'docker compose');

step(2, 'Aplicando migrations…');
await run([process.execPath, 'run', 'src/infrastructure/persistence/migrate.ts', 'up'], 'migrations');

step(3, `Iniciando a API na porta ${PORT}…`);
const app = Bun.spawn([process.execPath, 'run', 'src/main.ts'], { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' });
const stop = () => {
  app.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3_000);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const base = `http://localhost:${PORT}`;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  if (app.exitCode !== null) {
    console.error(`\n\x1b[31m✗ A API parou (código ${app.exitCode}). A porta ${PORT} está livre? Tente PORT=3010 bun run swagger\x1b[0m`);
    process.exit(1);
  }
  try {
    if ((await fetch(`${base}/health/ready`)).ok) break;
  } catch {
    /* still starting */
  }
  await Bun.sleep(500);
}

step(4, 'Pronto!');
console.log(`
  \x1b[32m●\x1b[0m Swagger (documentação interativa): \x1b[1m${base}/docs\x1b[0m
  \x1b[32m●\x1b[0m Saúde:                              ${base}/health/ready
  \x1b[32m●\x1b[0m Métricas:                           ${base}/metrics

  Em outro terminal, rode \x1b[1mbun run demo\x1b[0m para ver os cenários do desafio acontecendo.
  Ctrl+C para parar a API.
`);
openBrowser(`${base}/docs`);
await app.exited;
