#!/usr/bin/env node
// @ts-check
// Standalone production server for agent-profiler. Serves ui/dist/ statically,
// exposes /api/traces, /api/transcript, /api/health by importing
// lib/traces/api-handler.js. No Vite at runtime.

import { exec } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tracesHandler, transcriptHandler } from '../lib/traces/api-handler.js';
import { listSessions } from '../lib/traces/sessions.js';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_ROOT = join(PKG_ROOT, 'ui', 'dist');
const PKG_JSON_PATH = join(PKG_ROOT, 'package.json');
const PKG = JSON.parse(await readFile(PKG_JSON_PATH, 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const HELP = `Usage: agent-profiler [options]

  Local trace viewer for Claude Code conversations.
  Reads ~/.claude/projects/*/*.jsonl and serves a UI at http://localhost:<port>/

Options:
  -p, --port <n>     Port to listen on (0 = pick a free one). Default 5173, env AGENT_TRACE_PORT
      --no-open      Do not open a browser tab
  -v, --verbose      Log every HTTP request to stderr
  -V, --version      Print version and exit
  -h, --help         Show this message

Endpoints:
  GET  /                Single-page UI
  POST /api/traces      Trace tree for every session under ~/.claude/projects
  GET  /api/transcript  Raw JSONL bundle for one session (?sessionId=…)
  GET  /api/health      { ok, version, sessionCount, uptimeSeconds }

Env:
  AGENT_TRACE_PORT   Default port (overridden by --port)
  AGENT_TRACE_LIMIT  Cap on most-recent sessions to return (default 200)
`;

function args() {
  const a = process.argv.slice(2);
  const opts = {
    port: Number(process.env.AGENT_TRACE_PORT ?? 5173),
    open: true,
    verbose: false,
  };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--port' || a[i] === '-p') opts.port = Number(a[++i]);
    else if (a[i] === '--no-open') opts.open = false;
    else if (a[i] === '--verbose' || a[i] === '-v') opts.verbose = true;
    else if (a[i] === '--version' || a[i] === '-V') {
      console.log(PKG.version);
      process.exit(0);
    } else if (a[i] === '--help' || a[i] === '-h') {
      console.log(HELP);
      process.exit(0);
    } else {
      console.error(`agent-profiler: unknown argument: ${a[i]}`);
      console.error('Run `agent-profiler --help` for usage.');
      process.exit(2);
    }
  }
  if (!Number.isFinite(opts.port) || opts.port < 0 || opts.port > 65535) {
    console.error('agent-profiler: --port must be a number between 0 and 65535');
    process.exit(2);
  }
  return opts;
}

function ext(path) {
  const i = path.lastIndexOf('.');
  return i < 0 ? '' : path.slice(i).toLowerCase();
}

async function serveStatic(urlPath, res) {
  // Strip query, decode, normalize, and re-anchor under DIST_ROOT to defeat
  // traversal. Fall back to index.html for unknown routes (SPA).
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
  const safe = normalize(cleanPath).replace(/^([./\\])+/, '');
  const candidate = safe === '' ? 'index.html' : safe;
  const full = join(DIST_ROOT, candidate);
  if (!full.startsWith(DIST_ROOT + sep) && full !== DIST_ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let target = full;
  try {
    const st = await stat(target);
    if (st.isDirectory()) target = join(target, 'index.html');
  } catch {
    target = join(DIST_ROOT, 'index.html');
  }
  try {
    const buf = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[ext(target)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch (e) {
    if (target.endsWith('index.html')) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        'agent-profiler: ui/dist/ is missing. Did you forget to run `npm run build`?\n' +
          'If you installed via npm/npx, please report this — the published tarball should ship the build.\n',
      );
    } else {
      res.writeHead(404).end('not found');
    }
  }
}

function healthHandler(res) {
  let sessionCount = 0;
  try {
    sessionCount = listSessions().length;
  } catch {
    // disk read can fail (e.g. ~/.claude/projects/ missing); report 0
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      ok: true,
      version: PKG.version,
      sessionCount,
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* best-effort; ignore failures */
  });
}

async function checkForUpdate() {
  if (process.env.AGENT_PROFILER_NO_UPDATE_CHECK) return;
  try {
    const { default: updateNotifier } = await import('update-notifier');
    updateNotifier({ pkg: PKG, updateCheckInterval: 1000 * 60 * 60 * 24 }).notify({
      defer: false,
      isGlobal: true,
    });
  } catch {
    // update-notifier is best-effort; never break the CLI over it
  }
}

const opts = args();
await checkForUpdate();

const server = createServer(async (req, res) => {
  const start = Date.now();
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  res.on('finish', () => {
    if (opts.verbose) {
      const ms = Date.now() - start;
      process.stderr.write(`${method} ${url} ${res.statusCode} ${ms}ms\n`);
    }
  });

  if (url === '/api/health') {
    healthHandler(res);
    return;
  }
  if (url === '/api/traces' || url.startsWith('/api/traces?')) {
    tracesHandler(req, res);
    return;
  }
  if (url === '/api/transcript' || url.startsWith('/api/transcript?')) {
    transcriptHandler(req, res);
    return;
  }
  await serveStatic(url, res);
});

server.on('error', (err) => {
  // @ts-ignore — Node attaches `code` to listen errors
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `agent-profiler: port ${opts.port} is already in use. Try --port <other> or set AGENT_TRACE_PORT.`,
    );
    process.exit(1);
  }
  console.error('agent-profiler: server error', err);
  process.exit(1);
});

function shutdown(signal) {
  if (opts.verbose) process.stderr.write(`agent-profiler: received ${signal}, shutting down\n`);
  server.close(() => process.exit(0));
  // Hard-exit if the server doesn't close within 5s (open keepalive sockets, etc.)
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

server.listen(opts.port, () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  const url = `http://localhost:${actualPort}/`;
  console.log(`agent-profiler ${PKG.version} ready at ${url}`);
  if (opts.open) openBrowser(url);
});
