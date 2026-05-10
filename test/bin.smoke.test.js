// @ts-check
// Smoke test for bin/agent-profiler.js — proves the published binary starts,
// answers /api/health, and shuts down on SIGTERM. This is the single most
// valuable test for distribution confidence.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(REPO_ROOT, 'bin', 'agent-profiler.js');

/**
 * Spawn the CLI on a random port and resolve with { proc, port } once the
 * "ready at http://localhost:<port>/" line lands on stdout.
 * @param {string[]} extraArgs
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, port: number }>}
 */
function startCli(extraArgs = []) {
  const proc = spawn('node', [BIN, '--port', '0', '--no-open', ...extraArgs], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;
    /** @param {unknown} err */
    const fail = (err) => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(err);
    };
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/localhost:(\d+)\//);
      if (match && !settled) {
        settled = true;
        resolve({ proc, port: Number(match[1]) });
      }
    });
    proc.on('error', fail);
    proc.on('exit', (code) => {
      if (!settled) fail(new Error(`CLI exited with code ${code} before ready; stdout=${stdout}`));
    });
    setTimeout(() => fail(new Error(`CLI did not become ready within 5s; stdout=${stdout}`)), 5000);
  });
}

/**
 * Tiny GET helper using node:http (no external deps).
 * @param {string} url
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
async function get(url) {
  const { default: http } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error(`GET ${url} timed out`)));
  });
}

test('--version prints the package version and exits 0', async () => {
  const proc = spawn('node', [BIN, '--version'], { cwd: REPO_ROOT });
  let stdout = '';
  proc.stdout.on('data', (c) => {
    stdout += c.toString();
  });
  const [code] = await once(proc, 'exit');
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('--help prints usage and exits 0', async () => {
  const proc = spawn('node', [BIN, '--help'], { cwd: REPO_ROOT });
  let stdout = '';
  proc.stdout.on('data', (c) => {
    stdout += c.toString();
  });
  const [code] = await once(proc, 'exit');
  assert.equal(code, 0);
  assert.match(stdout, /Usage: agent-profiler/);
  assert.match(stdout, /--port/);
});

test('unknown argument exits with code 2', async () => {
  const proc = spawn('node', [BIN, '--no-such-flag'], { cwd: REPO_ROOT });
  const [code] = await once(proc, 'exit');
  assert.equal(code, 2);
});

test('boots, answers /api/health, shuts down cleanly on SIGTERM', async () => {
  const { proc, port } = await startCli();
  try {
    const { status, body } = await get(`http://localhost:${port}/api/health`);
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.equal(json.ok, true);
    assert.match(json.version, /^\d+\.\d+\.\d+/);
    assert.equal(typeof json.sessionCount, 'number');
    assert.equal(typeof json.uptimeSeconds, 'number');
  } finally {
    proc.kill('SIGTERM');
    const [code] = await once(proc, 'exit');
    assert.equal(code, 0, 'CLI should exit 0 on SIGTERM');
  }
});

test('serves index.html at /', async () => {
  const { proc, port } = await startCli();
  try {
    const { status, headers, body } = await get(`http://localhost:${port}/`);
    assert.equal(status, 200);
    assert.match(body, /<html/i);
    assert.match(
      String(headers['content-security-policy']),
      /connect-src 'self' https:\/\/formspree\.io/,
    );
  } finally {
    proc.kill('SIGTERM');
    await once(proc, 'exit');
  }
});

test('rejects path traversal attempts', async () => {
  const { proc, port } = await startCli();
  try {
    // node:http will normalize the URL path, so use a raw socket to send
    // bytes that bypass URL parsing. This proves serveStatic itself rejects
    // traversal even if a malformed path makes it through.
    const sock = createConnection(port, 'localhost');
    await once(sock, 'connect');
    sock.write('GET /../../etc/passwd HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString();
    });
    await once(sock, 'end');
    // Either a 200 serving index.html (SPA fallback) or a non-200, but
    // never the contents of /etc/passwd.
    assert.doesNotMatch(buf, /root:/);
  } finally {
    proc.kill('SIGTERM');
    await once(proc, 'exit');
  }
});
