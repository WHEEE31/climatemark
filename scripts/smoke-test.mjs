/**
 * Boots the production build and verifies it actually serves traffic.
 *
 * Checks:
 *   1. the server binds a port and answers /healthz
 *   2. the built frontend is served at /
 *   3. the API validates input and returns a real assessment
 *
 * Run with: npm run smoke
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.SMOKE_PORT ?? '5099';
const BASE = `http://127.0.0.1:${PORT}`;
const SKIP_NETWORK = process.env.SMOKE_SKIP_NETWORK === '1';

const server = spawn(
  process.execPath,
  ['--enable-source-maps', 'dist/server/index.js'],
  { env: { ...process.env, NODE_ENV: 'production', PORT }, stdio: 'inherit' },
);

let failed = false;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
};

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  return false;
}

try {
  const up = await waitForServer();
  check('server starts and answers /healthz', up);
  if (!up) throw new Error('server never became healthy');

  const page = await fetch(BASE);
  const html = await page.text();
  check(
    'frontend is served at /',
    page.ok && html.includes('<div id="root">'),
    `status ${page.status}`,
  );

  const bad = await fetch(`${BASE}/api/assess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: 'x' }),
  });
  check('API rejects an invalid address with 400', bad.status === 400);

  if (SKIP_NETWORK) {
    console.log('SKIP  live assessment (SMOKE_SKIP_NETWORK=1)');
  } else {
    const good = await fetch(`${BASE}/api/assess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: '1600 Pennsylvania Ave NW, Washington, DC' }),
    });
    const body = await good.json().catch(() => null);
    check(
      'API returns a full assessment',
      good.ok &&
        Array.isArray(body?.hazards) &&
        body.hazards.length > 0 &&
        typeof body?.dominantHazard?.id === 'string' &&
        typeof body?.dataQuality === 'number',
      good.ok
        ? `dominant ${body?.dominantHazard?.id}, quality ${body?.dataQuality}`
        : `status ${good.status}`,
    );

    check(
      'every hazard carries a confidence tier',
      good.ok &&
        Array.isArray(body?.hazards) &&
        body.hazards.every((h) =>
          ['measured', 'modeled', 'estimated'].includes(h.confidence),
        ),
    );
  }
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  server.kill('SIGTERM');
  await sleep(500);
  server.kill('SIGKILL');
}

console.log(failed ? '\nSmoke test FAILED' : '\nSmoke test passed');
process.exit(failed ? 1 : 0);
