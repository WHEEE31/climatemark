import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { apiRouter } from './routes';
import { logger } from './logger';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load .env before anything else reads process.env.
 *
 * Node does not do this on its own — that behaviour comes from the dotenv
 * package. Node 20.12+ ships process.loadEnvFile, so we can do it with zero
 * dependencies. Values already set in the real environment win, which is what
 * we want: hosting platforms inject their own config and must not be
 * overridden by a stray .env in the image.
 */
function loadDotEnv(): void {
  // Check the working directory first (both `npm run dev` and `npm start` run
  // from the project root), then next to the bundle as a fallback.
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(here, '..', '.env'),
    path.resolve(here, '..', '..', '.env'),
  ];
  const envPath = candidates.find((p) => fs.existsSync(p));
  try {
    if (!envPath) return;
    const load = (process as NodeJS.Process & { loadEnvFile?: (p: string) => void })
      .loadEnvFile;
    if (typeof load === 'function') {
      load.call(process, envPath);
      return;
    }
    // Fallback for Node < 20.12: parse the simple KEY=VALUE form ourselves.
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // A malformed .env should never stop the server from booting.
  }
}

loadDotEnv();
const isProduction = process.env.NODE_ENV === 'production';

/**
 * Bind to 0.0.0.0 rather than localhost. Container-based hosts (Render,
 * Railway, Fly, Docker) route traffic to the container's external interface,
 * so a server listening only on 127.0.0.1 accepts no outside connections —
 * the health check fails and the deploy is marked unhealthy.
 */
const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = Number(process.env.PORT ?? 5000);

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
}

async function main(): Promise<void> {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // Platform health probes hit the root path.
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api', apiRouter);

  if (isProduction) {
    // Serve the compiled frontend from dist/client.
    const clientDir = path.resolve(here, '..', 'client');
    const indexHtml = path.join(clientDir, 'index.html');

    if (!fs.existsSync(indexHtml)) {
      throw new Error(
        `Frontend build not found at ${clientDir}. Run "npm run build" before "npm start".`,
      );
    }

    // Hashed asset filenames are safe to cache aggressively; index.html is not.
    app.use(
      express.static(clientDir, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );

    // SPA fallback: any non-API route renders the app shell.
    app.use((_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  } else {
    /**
     * In development, run Vite in middleware mode inside this same process.
     * That gives one command, one port, and one URL for both the API and the
     * frontend — so there is no proxy to misconfigure and no CORS to debug.
     * Vite is a devDependency and is only imported on this branch, so it is
     * never required in production.
     */
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: path.resolve(here, '..'),
      appType: 'spa',
      server: { middlewareMode: true },
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(PORT, HOST, () => {
    logger.info(
      {
        url: `http://localhost:${PORT}`,
        mode: isProduction ? 'production' : 'development',
        // Surfaced on purpose: a missing or placeholder value here is the most
        // common reason geocoding starts failing.
        geocoderUserAgent:
          process.env.NOMINATIM_USER_AGENT ?? '(default placeholder — set NOMINATIM_USER_AGENT)',
      },
      'ClimateMark is running',
    );
  });

  server.on('error', (err) => {
    logger.error({ err, port: PORT }, 'Failed to start server');
    process.exit(1);
  });

  // Containers send SIGTERM on shutdown; exit cleanly so deploys roll over fast.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, 'Shutting down');
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
