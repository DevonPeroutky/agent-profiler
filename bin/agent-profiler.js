#!/usr/bin/env node
// @ts-check
// Standalone production server for agent-profiler. Serves ui/dist/ statically,
// exposes /api/traces by importing lib/traces/store.js. No Vite at runtime.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';
import { exec } from 'node:child_process';
import { tracesHandler } from '../lib/traces/api-handler.js';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_ROOT = join(PKG_ROOT, 'ui', 'dist');

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

function args() {
  const a = process.argv.slice(2);
  const opts = { port: Number(process.env.AGENT_TRACE_PORT ?? 5173), open: true };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--port' || a[i] === '-p') opts.port = Number(a[++i]);
    else if (a[i] === '--no-open') opts.open = false;
    else if (a[i] === '--help' || a[i] === '-h') {
      console.log(
        'Usage: agent-profiler [--port N] [--no-open]\n' +
        '  Local trace viewer for Claude Code conversations.\n' +
        '  Reads ~/.claude/projects/*/*.jsonl and serves a UI at http://localhost:<port>/\n' +
        '\n' +
        'Options:\n' +
        '  -p, --port <n>     Port to listen on (default 5173, env AGENT_TRACE_PORT)\n' +
        '      --no-open      Do not open a browser tab\n' +
        '  -h, --help         Show this message\n' +
        '\n' +
        'Env:\n' +
        '  AGENT_TRACE_LIMIT  Cap on most-recent sessions to return (default 200)\n'
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(opts.port)) {
    console.error('agent-profiler: --port must be a number');
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
        'If you installed via npm/npx, please report this — the published tarball should ship the build.\n'
      );
    } else {
      res.writeHead(404).end('not found');
    }
  }
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32' ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, () => { /* best-effort; ignore failures */ });
}

const opts = args();
const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  if (url === '/api/traces' || url.startsWith('/api/traces?')) {
    tracesHandler(req, res);
    return;
  }
  await serveStatic(url, res);
});

server.on('error', (err) => {
  // @ts-ignore — Node attaches `code` to listen errors
  if (err && err.code === 'EADDRINUSE') {
    console.error(`agent-profiler: port ${opts.port} is already in use. Try --port <other>.`);
    process.exit(1);
  }
  console.error('agent-profiler: server error', err);
  process.exit(1);
});

server.listen(opts.port, () => {
  const url = `http://localhost:${opts.port}/`;
  console.log(`agent-profiler ready at ${url}`);
  if (opts.open) openBrowser(url);
});
