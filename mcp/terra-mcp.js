// Terra's MCP server for the Claude desktop app (stdio). Two tools, terra_react and
// terra_state, each passing one name from pet-commands.js to the running pet through
// its local listener: POST http://127.0.0.1:<port>/mcp, port read from ~/.terra-pet/port
// on every call, so it doesn't matter whether Terra or Claude starts first.
//
// Claude desktop runs it with Terra's own binary in Node mode (see mcp-installer.js):
//   ELECTRON_RUN_AS_NODE=1 <Terra or Electron binary> <this file>
// stdout carries the protocol, so nothing else may be written there; logs go to stderr.
//
// It also opens the pet when Claude desktop starts and the pet isn't running, and tells
// the pet when it goes, so a pet it opened can close with Claude (see pet-launcher.js).
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/server');
const { serveStdio } = require('@modelcontextprotocol/server/stdio');
const { z } = require('zod');
const { REACTIONS, STATES } = require('../pet-commands.js');
const { version } = require('../package.json');
const launcher = require('./pet-launcher.js');
const openWithClaude = require('../open-with-claude.js');

const HOST = '127.0.0.1';
const TIMEOUT = 2000;
const portFile = () => path.join(os.homedir(), '.terra-pet', 'port');

const INSTRUCTIONS = `Terra is a small pixel-art robot that lives on the user's desktop. These tools only
animate it; they change nothing else. Use terra_state to show what you are doing (working
before a long answer or task, done when it is finished, waiting when you need the user) and
terra_react now and then to show how the conversation feels. There is no need to mention
the tools or their results to the user unless they ask about Terra.`;

const REACT_DESCRIPTION = `Play a short reaction on Terra, the user's desktop pet (a small pixel-art robot on their screen). Purely cosmetic: the user just sees the pet react.
Use it when a moment clearly has a feeling, at most once or twice per reply:
- hi: the user greets you or a conversation starts
- love: the user thanks you, compliments you or shares good news
- idea: you are about to suggest a plan, a fix or a new approach
- stars: celebrating a success (tests pass, a problem is solved)
- sad: something failed, or the news is bad
- angry: playful frustration, when the user is clearly fed up with a bug
- talk: you are about to give a long explanation
- ask: you are asking the user a quick question
After the reaction Terra goes back to what it was doing (still working, if it was).`;

const STATE_DESCRIPTION = `Set what Terra, the user's desktop pet, is doing, so the user can glance at it to see your status.
- working: call it before a long answer or a multi-step task (research, writing code, several tool calls). Terra sits at its computer until you set another state.
- done: call it when you have finished that work. Terra celebrates, then idles.
- waiting: call it when you stop to wait for the user's answer, decision or approval. Terra keeps asking until you set another state.
- idle: puts Terra back to rest, for example when you stop without finishing.
For example: terra_state("working") before a long answer and terra_state("done") after it. Skip it for short, quick replies. Terra gives up on working or waiting by itself after 10 minutes.`;

const STATE_DONE = {
  working: 'Terra is working at its computer. Call terra_state("done") when you finish.',
  waiting: 'Terra is waiting for the user.',
  done: 'Terra is celebrating, then goes back to idle.',
  idle: 'Terra is back to idle.',
};

// Resolves to { status } from the listener, or { down: true } when nothing answers.
function post(body) {
  let port;
  try {
    port = Number(fs.readFileSync(portFile(), 'utf8').trim());
  } catch {
    return Promise.resolve({ down: true }); // no port file: Terra isn't running
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve({ down: true });
  const data = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request({
      host: HOST,
      port,
      path: '/mcp',
      method: 'POST',
      agent: false,
      timeout: TIMEOUT,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    // Refused (a port file left behind) or no answer in time: treat both as not running.
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', () => resolve({ down: true }));
    req.end(data);
  });
}

const text = (message, isError = false) => ({ content: [{ type: 'text', text: message }], ...(isError ? { isError } : {}) });

async function send(body, okMessage) {
  const { status, down } = await post(body);
  if (down) return text("Terra (the desktop pet) isn't running, so there was nothing to show. That's fine: carry on, no need to retry.");
  if (status === 204) return text(okMessage);
  if (status === 404) return text('This copy of Terra is too old to take commands from Claude desktop, so nothing was shown. No need to retry.');
  return text(`Terra didn't accept the command (HTTP ${status}).`, true);
}

function createServer() {
  const server = new McpServer({ name: 'terra', version }, { instructions: INSTRUCTIONS });

  server.registerTool('terra_react', {
    title: 'Terra: react',
    description: REACT_DESCRIPTION,
    inputSchema: z.object({
      reaction: z.enum(REACTIONS).describe('The reaction to play: hi, love, angry, sad, idea, stars, talk or ask.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ reaction }) => send({ reaction }, `Terra played "${reaction}".`));

  server.registerTool('terra_state', {
    title: 'Terra: set state',
    description: STATE_DESCRIPTION,
    inputSchema: z.object({
      state: z.enum(STATES).describe('What you are doing now: working, waiting, done or idle.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ state }) => send({ state }, STATE_DONE[state]));

  return server;
}

serveStdio(createServer, { onerror: (err) => console.error('Terra MCP server error:', err.message) });
console.error(`Terra MCP server ${version} running on stdio`);

// ---- Opening the pet with Claude, and letting it know when Claude goes ----

const session = randomUUID();
let saidHello = false;
let closing = false;

async function hello() {
  const { state } = await launcher.tellPet('hello', session);
  saidHello = saidHello || state === 'up';
}

async function arrive() {
  await hello();
  if (saidHello || closing) return;
  const outcome = await launcher.ensurePet({ isEnabled: openWithClaude.isEnabled, stopped: () => closing });
  console.error(`Terra MCP server: pet ${outcome}`);
  if (!closing) await hello();
}

// Claude desktop closes stdin (or sends a signal) when it quits or restarts the server.
// Only a server that said hello says goodbye, so the short-lived first of Claude's two
// starts leaves no trace.
async function leave() {
  if (closing) return;
  closing = true;
  if (saidHello) await launcher.tellPet('bye', session, 500);
  process.exit(0);
}

process.stdin.on('end', leave);
process.stdin.on('close', leave);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, leave);
arrive().catch((err) => console.error('Terra MCP server: could not open the pet:', err.message));
