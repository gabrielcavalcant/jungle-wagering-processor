/**
 * `bun run swagger:tour` — drives the real Swagger UI in a visible browser and exercises every
 * operation: expands it, fills the boxes, clicks "Execute", reads the response and checks it.
 * A banner on top of the page says what each step proves.
 *
 * Uses the OS default browser when it is Chromium-based (Chrome, Edge, Brave), else Chrome, then Edge —
 * through playwright-core, nothing to download.
 * Env: API_URL (default http://localhost:3001), TOUR_SLOWMO_MS (default 900), TOUR_PACE (1 = calm, 0.3 = fast),
 *      TOUR_BROWSER (chrome|msedge) to force one.
 */
import { chromium, type Locator, type Page } from 'playwright-core';

const API = process.env.API_URL ?? 'http://localhost:3001';
const SLOWMO = Number(process.env.TOUR_SLOWMO_MS ?? 900);
/** Seconds each step stays readable: banner before acting, response after. TOUR_PACE=1 is the default, 0.3 is fast. */
const PACE = Number(process.env.TOUR_PACE ?? 1);
const run = Date.now().toString(36);
const PROVIDER = 'swagger-tour';
const player = `jogador-tour-${run}`;
const c = { green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };
let passed = 0;
let failed = 0;

interface BrowserChoice {
  label: string;
  channel?: string;
  executablePath?: string;
}

const BRAVE_PATHS = [
  `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/brave-browser',
];

function sh(cmd: string[]): string {
  try {
    const res = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'ignore' });
    return res.stdout.toString();
  } catch {
    return '';
  }
}

/** The OS default web browser, when it is one Playwright can drive (Chromium family). */
function defaultBrowser(): BrowserChoice | { unsupported: string } | undefined {
  let id = '';
  if (process.platform === 'win32') {
    id = sh(['reg', 'query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']);
  } else if (process.platform === 'darwin') {
    const plist = sh(['defaults', 'read', `${process.env.HOME}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure`]);
    id = /LSHandlerRoleAll = "([^"]+)";\s*LSHandlerURLScheme = https/.exec(plist)?.[1] ?? '';
  } else {
    id = sh(['xdg-settings', 'get', 'default-web-browser']);
  }
  id = id.toLowerCase();
  if (!id.trim()) return undefined;
  if (/chrome/.test(id) && !/chromium/.test(id)) return { label: 'Google Chrome', channel: 'chrome' };
  if (/msedge|edge/.test(id)) return { label: 'Microsoft Edge', channel: 'msedge' };
  if (/brave/.test(id)) {
    const path = BRAVE_PATHS.find((p) => Bun.file(p).size > 0);
    return path ? { label: 'Brave', executablePath: path } : undefined;
  }
  if (/firefox/.test(id)) return { unsupported: 'Firefox' };
  if (/safari/.test(id)) return { unsupported: 'Safari' };
  return undefined;
}

/** TOUR_BROWSER > OS default browser > Chrome > Edge. */
async function launch() {
  const candidates: BrowserChoice[] = [];
  if (process.env.TOUR_BROWSER) {
    candidates.push({ label: `TOUR_BROWSER=${process.env.TOUR_BROWSER}`, channel: process.env.TOUR_BROWSER });
  } else {
    const detected = defaultBrowser();
    if (detected && 'unsupported' in detected) {
      console.log(`${c.dim}Navegador padrão é o ${detected.unsupported}, que a automação não controla; usando Chrome/Edge.${c.reset}`);
    } else if (detected) {
      candidates.push({ ...detected, label: `${detected.label} (navegador padrão do sistema)` });
    }
    candidates.push({ label: 'Google Chrome', channel: 'chrome' }, { label: 'Microsoft Edge', channel: 'msedge' });
  }
  for (const choice of candidates) {
    try {
      const browser = await chromium.launch({
        channel: choice.channel,
        executablePath: choice.executablePath,
        headless: false,
        slowMo: SLOWMO,
        args: ['--start-maximized'],
      });
      console.log(`${c.dim}Navegador: ${choice.label}${c.reset}`);
      return browser;
    } catch {
      /* not installed: try the next one */
    }
  }
  throw new Error('Nenhum navegador compatível encontrado (Chrome, Edge ou Brave). Defina TOUR_BROWSER=chrome|msedge.');
}

/** Banner fixed on top of Swagger UI narrating the current step. */
async function banner(page: Page, step: number, total: number, title: string, detail: string) {
  console.log(`\n${c.cyan}${c.bold}[${step}/${total}] ${title}${c.reset}\n${c.dim}      ${detail}${c.reset}`);
  await page.evaluate(
    ({ step, total, title, detail }) => {
      const doc = (globalThis as any).document;
      let el = doc.getElementById('tour-banner');
      if (!el) {
        el = doc.createElement('div');
        el.id = 'tour-banner';
        el.style.cssText =
          'position:fixed;top:0;left:0;right:0;z-index:99999;padding:12px 20px;background:#1f5f8b;color:#fff;' +
          'font:15px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35)';
        doc.body.appendChild(el);
        doc.body.style.paddingTop = '72px';
      }
      el.innerHTML = `<b>Passo ${step}/${total} · ${title}</b><br><span style="opacity:.85">${detail}</span>`;
    },
    { step, total, title, detail },
  );
  await page.waitForTimeout(2500 * PACE);
}

const op = (page: Page, tag: string, id: string) => page.locator(`#operations-${tag}-${id}`);

async function open(page: Page, block: Locator) {
  await block.scrollIntoViewIfNeeded();
  if (!(await block.locator('.opblock-body').isVisible().catch(() => false))) {
    await block.locator('.opblock-summary').first().click();
  }
  await block.locator('.opblock-body').waitFor();
  const tryIt = block.locator('button.try-out__btn:has-text("Try it out")');
  if (await tryIt.isVisible().catch(() => false)) await tryIt.click();
}

async function setParam(block: Locator, name: string, value: string) {
  await block.locator(`tr[data-param-name="${name}"] input`).fill(value);
}

async function setBody(block: Locator, body: unknown) {
  await block.locator('textarea.body-param__text').fill(JSON.stringify(body, null, 2));
}

/** Clicks Execute and returns the live response (status + parsed body). */
async function execute(block: Locator): Promise<{ status: number; body: any }> {
  const clear = block.locator('button.btn-clear');
  if (await clear.isVisible().catch(() => false)) await clear.click();
  await block.locator('button.execute').click();
  const statusCell = block.locator('.live-responses-table tbody .response-col_status').first();
  await statusCell.waitFor({ timeout: 30_000 });
  await statusCell.scrollIntoViewIfNeeded();
  await block.page().waitForTimeout(1500 * PACE);
  const status = Number((await statusCell.innerText()).trim());
  const raw = (await block.locator('.live-responses-table tbody .response-col_description pre').first().innerText().catch(() => '')).trim();
  let body: any = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* metrics is plain text */
  }
  return { status, body };
}

function check(ok: boolean, text: string, got?: string) {
  if (ok) passed++;
  else failed++;
  console.log(`      ${ok ? `${c.green}✓` : `${c.red}✗`} ${text}${got ? `${c.dim} (${got})` : ''}${c.reset}`);
}

const pause = (page: Page, ms = 3500) => page.waitForTimeout(ms * PACE);

async function main() {
  const browser = await launch();
  const page = await browser.newPage({ viewport: null });
  await page.goto(`${API}/docs`);
  await page.locator('#operations-Wallets-createWallet').waitFor({ timeout: 30_000 });
  console.log(`${c.bold}Tour automático do Swagger UI${c.reset}  ${c.dim}${API}/docs${c.reset}`);
  const TOTAL = 14;

  // 1 ---------------------------------------------------------------------------- create wallet
  await banner(page, 1, TOTAL, 'POST /wallets — criar carteira', 'Saldo inicial 100.00 BRL: vira uma transação OPENING + crédito no ledger, na mesma transação do banco.');
  const create = op(page, 'Wallets', 'createWallet');
  await open(page, create);
  await setBody(create, { playerId: player, initialBalance: { amount: '100.00', currency: 'BRL' } });
  const w = await execute(create);
  check(w.status === 201 && w.body.balance?.amount === '100.00', 'carteira criada com 100.00', `${w.status}`);
  const walletId: string = w.body.id;
  await pause(page);

  // 2 ---------------------------------------------------------------------------- get wallet
  await banner(page, 2, TOTAL, 'GET /wallets/{walletId} — consultar carteira', 'Saldo e versão (a versão sobe 1 a cada mudança de saldo).');
  const getWallet = op(page, 'Wallets', 'getWallet');
  await open(page, getWallet);
  await setParam(getWallet, 'walletId', walletId);
  const gw = await execute(getWallet);
  check(gw.status === 200 && gw.body.version === 1, 'saldo 100.00, versão 1', `${gw.status}`);
  await pause(page);

  // 3 ---------------------------------------------------------------------------- bet
  const submit = op(page, 'Wagering', 'submitTransaction');
  const bet = (ext: string, amount: string, extra: Record<string, unknown> = {}) => ({
    providerId: PROVIDER, externalTransactionId: `${ext}-${run}`, playerId: player, walletId,
    roundId: `round-${run}`, gameId: 'fortune-chimp', kind: 'BET', money: { amount, currency: 'BRL' }, ...extra,
  });
  await banner(page, 3, TOTAL, 'POST /wagering/transactions — aposta de 80.00', 'Header Idempotency-Key + corpo da aposta. Esperado: 201 PROCESSED, saldo 20.00.');
  await open(page, submit);
  await setParam(submit, 'Idempotency-Key', `${PROVIDER}:bet-a-${run}`);
  await setBody(submit, bet('bet-a', '80.00'));
  const b1 = await execute(submit);
  check(b1.status === 201 && b1.body.status === 'PROCESSED' && b1.body.balance?.amount === '20.00', 'PROCESSED, saldo 20.00', `${b1.status}`);
  const betTxId: string = b1.body.transactionId;
  await pause(page);

  // 4 ---------------------------------------------------------------------------- replay
  await banner(page, 4, TOTAL, 'Mesma aposta de novo (mesma Idempotency-Key)', 'Idempotência: devolve o resultado original, sem debitar outra vez. Esperado: 200, idempotentReplay=true.');
  const b2 = await execute(submit);
  check(b2.status === 200 && b2.body.idempotentReplay === true && b2.body.transactionId === betTxId, 'replay: mesma transação, nenhum débito novo', `${b2.status}`);
  await pause(page);

  // 5 ---------------------------------------------------------------------------- insufficient funds
  await banner(page, 5, TOTAL, 'Outra aposta de 80.00 com saldo 20.00', 'Regra de negócio: rejeitada com motivo. Esperado: 422 REJECTED · INSUFFICIENT_FUNDS.');
  await setParam(submit, 'Idempotency-Key', `${PROVIDER}:bet-b-${run}`);
  await setBody(submit, bet('bet-b', '80.00'));
  const b3 = await execute(submit);
  check(b3.status === 422 && b3.body.failureCode === 'INSUFFICIENT_FUNDS', 'rejeitada por saldo insuficiente', `${b3.status}`);
  await pause(page);

  // 6 ---------------------------------------------------------------------------- idempotency conflict
  await banner(page, 6, TOTAL, 'Mesma Idempotency-Key com valor diferente', 'Conteúdo diferente com a mesma key é conflito, nunca replay. Esperado: 409 IDEMPOTENCY_KEY_CONFLICT.');
  await setParam(submit, 'Idempotency-Key', `${PROVIDER}:bet-a-${run}`);
  await setBody(submit, bet('bet-a', '81.00'));
  const b4 = await execute(submit);
  check(b4.status === 409 && b4.body.error?.code === 'IDEMPOTENCY_KEY_CONFLICT', 'conflito de idempotência', `${b4.status}`);
  await pause(page);

  // 7 ---------------------------------------------------------------------------- invalid money
  await banner(page, 7, TOTAL, 'Valor inválido "1e5"', 'Dinheiro é texto com 2 casas; notação científica é recusada antes de tocar no banco. Esperado: 400.');
  await setParam(submit, 'Idempotency-Key', `${PROVIDER}:bad-${run}`);
  await setBody(submit, bet('bad', '1e5'));
  const b5 = await execute(submit);
  check(b5.status === 400 && b5.body.error?.code === 'VALIDATION_ERROR', 'payload inválido recusado', `${b5.status}`);
  await pause(page);

  // 8 ---------------------------------------------------------------------------- refund before bet
  await banner(page, 8, TOTAL, 'REFUND chegando antes da BET', 'Referência fora de ordem: fica PENDING_REFERENCE e um worker resolve depois. Esperado: 202.');
  await setParam(submit, 'Idempotency-Key', `${PROVIDER}:refund-${run}`);
  await setBody(submit, { ...bet('refund', '10.00'), kind: 'REFUND', referenceExternalTransactionId: `bet-late-${run}` });
  const r1 = await execute(submit);
  check(r1.status === 202 && r1.body.status === 'PENDING_REFERENCE', 'REFUND aguardando a referência', `${r1.status}`);
  const refundTxId: string = r1.body.transactionId;
  await pause(page);

  // 9 ---------------------------------------------------------------------------- the late bet
  await banner(page, 9, TOTAL, 'A BET referenciada chega', 'Aposta de 10.00 que o REFUND estava esperando. Esperado: 201, saldo 10.00.');
  await setParam(submit, 'Idempotency-Key', `${PROVIDER}:bet-late-${run}`);
  await setBody(submit, bet('bet-late', '10.00'));
  const b6 = await execute(submit);
  check(b6.status === 201 && b6.body.balance?.amount === '10.00', 'BET processada', `${b6.status}`);
  await pause(page, 2500); // the pending-reference worker resolves the REFUND

  // 10 --------------------------------------------------------------------------- get transaction
  await banner(page, 10, TOTAL, 'GET /wagering/transactions/{transactionId}', 'O REFUND que estava pendente: o worker resolveu sozinho. Esperado: PROCESSED.');
  const getTx = op(page, 'Wagering', 'getTransaction');
  await open(page, getTx);
  await setParam(getTx, 'transactionId', refundTxId);
  let t = await execute(getTx);
  for (let i = 0; i < 10 && t.body.status !== 'PROCESSED'; i++) {
    await pause(page, 1000);
    t = await execute(getTx);
  }
  check(t.status === 200 && t.body.status === 'PROCESSED', 'REFUND resolvido pelo worker', t.body.status);
  await pause(page);

  // 11 --------------------------------------------------------------------------- by provider id
  await banner(page, 11, TOTAL, 'GET /providers/{providerId}/wagering/transactions/{externalTransactionId}', 'Consulta pelo id do provedor (o mesmo que o provedor enviou).');
  const byExt = op(page, 'Wagering', 'getTransactionByExternalId');
  await open(page, byExt);
  await setParam(byExt, 'providerId', PROVIDER);
  await setParam(byExt, 'externalTransactionId', `bet-a-${run}`);
  const e1 = await execute(byExt);
  check(e1.status === 200 && e1.body.id === betTxId, 'achou a aposta pelo id do provedor', `${e1.status}`);
  await pause(page);

  // 12 --------------------------------------------------------------------------- ledger
  await banner(page, 12, TOTAL, 'GET /wallets/{walletId}/ledger — extrato', 'Livro-razão imutável: cada entrada tem saldo antes e depois.');
  const ledger = op(page, 'Wallets', 'getLedger');
  await open(page, ledger);
  await setParam(ledger, 'walletId', walletId);
  const l1 = await execute(ledger);
  const dirs = (l1.body.items ?? []).map((e: any) => e.direction).join(' → ');
  check(l1.status === 200 && l1.body.items?.length === 4, '4 lançamentos: abertura, aposta, aposta tardia, refund', dirs);
  await pause(page);

  // 13 --------------------------------------------------------------------------- reconciliation
  await banner(page, 13, TOTAL, 'POST /wallets/{walletId}/reconciliation', 'Refaz o saldo somando o ledger e compara com o saldo guardado. Esperado: consistent=true.');
  const recon = op(page, 'Wallets', 'reconcileWallet');
  await open(page, recon);
  await setParam(recon, 'walletId', walletId);
  const rc = await execute(recon);
  check(rc.status === 200 && rc.body.consistent === true && rc.body.storedBalance?.amount === '20.00', `saldo 20.00 == ledger (${rc.body.checkedEntries} entradas)`, `${rc.status}`);
  await pause(page);

  // 14 --------------------------------------------------------------------------- operations
  await banner(page, 14, TOTAL, 'Health checks e métricas', 'GET /health/live, /health/ready (Postgres + SQS) e /metrics (Prometheus).');
  for (const [id, expect] of [['healthLive', 200], ['healthReady', 200], ['metrics', 200]] as const) {
    const block = op(page, 'Operations', id);
    await open(page, block);
    const res = await execute(block);
    check(res.status === expect, `${id}`, `${res.status}`);
    await pause(page, 600);
  }

  const summary = `${passed} verificações OK${failed ? `, ${failed} falharam` : ''}`;
  await page.evaluate((text) => {
    const doc = (globalThis as any).document;
    const el = doc.getElementById('tour-banner');
    if (el) el.innerHTML = `<b>Tour concluído · ${text}</b><br><span style="opacity:.85">Todas as operações da API foram executadas pelo Swagger UI. Role a página para ver cada resposta.</span>`;
    (globalThis as any).scrollTo({ top: 0, behavior: 'smooth' });
  }, summary);
  console.log(`\n${c.bold}Resultado: ${failed ? c.red : c.green}${summary}${c.reset}`);
  console.log(`${c.dim}O navegador continua aberto para você explorar. Para encerrar, feche o navegador.${c.reset}\n`);
  if (process.env.TOUR_CLOSE === '1') {
    await browser.close();
  } else {
    // Ctrl+C is a normal way to stop: close the browser and exit with the tour's result, not as a crash.
    process.on('SIGINT', async () => {
      console.log(`\n${c.dim}Encerrando… (resultado do tour: ${summary})${c.reset}`);
      await browser.close().catch(() => undefined);
      process.exit(failed ? 1 : 0);
    });
    await new Promise<void>((resolve) => browser.on('disconnected', () => resolve()));
    console.log(`${c.dim}Navegador fechado. Tour encerrado.${c.reset}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`${c.red}${error instanceof Error ? error.message : String(error)}${c.reset}`);
  process.exit(1);
});
