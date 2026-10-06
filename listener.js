// Local HTTP listener for Claude Code hook events (see hooks/terra-hook.sh).
// Bound to 127.0.0.1 only. One route: POST /event with { "event": string, "prompt"?: string }.
// Prompt text is passed to onEvent and never written to disk or logged.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const HOST = '127.0.0.1';
const FIRST_PORT = 47800;
const PORT_TRIES = 10;
const MAX_BODY = 64 * 1024;
const EVENTS = new Set(['prompt', 'tool', 'notify', 'stop', 'error', 'session-start']);
const PORT_FILE = path.join(os.homedir(), '.terra-pet', 'port');

function reply(res, status, message) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
  res.end(message ? `${message}\n` : undefined);
}

function createHandler(onEvent) {
  return (req, res) => {
    const { port } = req.socket.address();
    const { pathname } = new URL(req.url, `http://${HOST}`);
    if (pathname !== '/event') return reply(res, 404, 'not found');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(res, 405, 'use POST');
    }
    // Browsers always send Origin on a POST; the hook (curl) never does. Checking Host
    // as well stops web pages from reaching the pet through DNS rebinding.
    const { host, origin } = req.headers;
    if (origin !== undefined || (host !== `${HOST}:${port}` && host !== `localhost:${port}`)) {
      return reply(res, 403, 'forbidden');
    }
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) {
      return reply(res, 415, 'expected Content-Type: application/json');
    }
    if (Number(req.headers['content-length']) > MAX_BODY) return reply(res, 413, 'body over 64 KB');

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) return reply(res, 413, 'body over 64 KB');
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(res, 400, 'body is not valid JSON');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(res, 400, 'expected a JSON object');
      const { event, prompt } = body;
      if (!EVENTS.has(event)) return reply(res, 400, 'unknown event');
      if (prompt !== undefined && typeof prompt !== 'string') return reply(res, 400, 'prompt must be a string');
      onEvent({ event, prompt });
      reply(res, 204);
    });
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

// Starts on the first free port from 47800 and writes it to ~/.terra-pet/port.
async function startListener(onEvent) {
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_TRIES; port++) {
    const server = http.createServer(createHandler(onEvent));
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    try {
      await listen(server, port);
    } catch (err) {
      if (err.code === 'EADDRINUSE') continue;
      throw err;
    }
    server.on('error', (err) => console.error('Terra listener error:', err.code || err.message));
    fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(PORT_FILE, `${port}\n`, { mode: 0o600 });
    return { server, port };
  }
  throw new Error(`ports ${FIRST_PORT}-${FIRST_PORT + PORT_TRIES - 1} are all in use`);
}

// Removes the port file, unless another Terra has written its own port there since.
function removePortFile(port) {
  try {
    if (fs.readFileSync(PORT_FILE, 'utf8').trim() === String(port)) fs.unlinkSync(PORT_FILE);
  } catch {
    // already gone
  }
}

module.exports = { HOST, startListener, removePortFile };
