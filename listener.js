// Local HTTP listener. Bound to 127.0.0.1 only. Three routes:
//   POST /event  { "event": string, "prompt"?: string }  Claude Code hook events (hooks/terra-hook.sh)
//   POST /mcp    { "reaction": name } or { "state": name }, or { "state": "done", "mood": name }
//                the Claude desktop app (mcp/terra-mcp.js)
//   POST /server { "action": "hello"|"bye"|"ping", "id": string }  that MCP server coming and
//                going (answered with a small JSON status instead of 204)
// Prompt text is passed to onEvent and never written to disk or logged. /mcp takes
// nothing but names from the fixed lists in pet-commands.js.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { REACTIONS, STATES, MOODS } = require('./pet-commands.js');
const { SESSION_ID } = require('./open-with-claude.js');

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

// Checks a parsed /event body; returns the event for onEvent, or an error message.
function hookEvent(body) {
  const { event, prompt } = body;
  if (!EVENTS.has(event)) return { error: 'unknown event' };
  if (prompt !== undefined && typeof prompt !== 'string') return { error: 'prompt must be a string' };
  return { value: { event, prompt } };
}

const COMMANDS = new Map([['reaction', REACTIONS], ['state', STATES]]);

// Checks a parsed /mcp body: exactly one key, holding one of the known names, or
// "state": "done" with a "mood" from MOODS beside it. (A Map, so keys such as "__proto__"
// or "toString" find nothing.)
function petCommand(body) {
  const keys = Object.keys(body);
  if (keys.length === 2 && keys.includes('state') && keys.includes('mood')) {
    if (body.state !== 'done') return { error: 'a mood goes with "done" only' };
    if (!MOODS.includes(body.mood)) return { error: 'unknown mood' };
    return { value: { state: 'done', mood: body.mood } };
  }
  if (keys.length !== 1 || !COMMANDS.has(keys[0])) return { error: 'expected exactly one of "reaction" or "state" (and "mood" with "done")' };
  const [key] = keys;
  if (!COMMANDS.get(key).includes(body[key])) return { error: `unknown ${key}` };
  return { value: { [key]: body[key] } };
}

const SERVER_ACTIONS = ['hello', 'bye', 'ping'];

// Checks a parsed /server body: an action and the server's session id, nothing else.
function serverMessage(body) {
  const { action, id } = body;
  if (Object.keys(body).length !== 2 || !SERVER_ACTIONS.includes(action) || typeof id !== 'string' || !SESSION_ID.test(id)) {
    return { error: 'expected { "action": "hello" | "bye" | "ping", "id": <session id> }' };
  }
  return { value: { action, id } };
}

function createHandler(onEvent, onPetCommand, onServer) {
  const routes = { '/event': [hookEvent, onEvent], '/mcp': [petCommand, onPetCommand], '/server': [serverMessage, onServer] };
  return (req, res) => {
    const { port } = req.socket.address();
    const { pathname } = new URL(req.url, `http://${HOST}`);
    if (!Object.hasOwn(routes, pathname)) return reply(res, 404, 'not found');
    const [validate, handle] = routes[pathname];
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(res, 405, 'use POST');
    }
    // Browsers always send Origin on a POST; the hook (curl) and the MCP server never do.
    // Checking Host as well stops web pages from reaching the pet through DNS rebinding.
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
      const { value, error } = validate(body);
      if (error) return reply(res, 400, error);
      const answer = handle(value);
      if (answer && typeof answer === 'object') {
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify(answer));
        return;
      }
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
async function startListener(onEvent, onPetCommand = () => {}, onServer = () => ({})) {
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_TRIES; port++) {
    const server = http.createServer(createHandler(onEvent, onPetCommand, onServer));
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
