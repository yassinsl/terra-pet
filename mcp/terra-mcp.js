// Terra's MCP server for the Claude desktop app (stdio). Three tools: terra_react and
// terra_state pass names from pet-commands.js to the running pet through its local
// listener (POST http://127.0.0.1:<port>/mcp), and terra_say a speech bubble's short text
// (POST /say; only what the bubble font can draw, never logged). The port is read from
// ~/.terra-pet/port on every call, so it doesn't matter whether Terra or Claude starts first.
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
const { REACTIONS, STATES, MOODS } = require('../pet-commands.js');
const { MAX_INPUT, SIGNS, cleanText, layoutBubble } = require('../bubble-layout.js');

// What the bubble's font can write, from the font itself.
const CHARACTERS = `A-Z, 0-9 and ${SIGNS.join(' ')}`;
const WRITES = `Terra writes in capital letters with ${CHARACTERS}; letters lose their accents (é is E) and any other character shows as a space.`;
const { version } = require('../package.json');
const launcher = require('./pet-launcher.js');
const openWithClaude = require('../open-with-claude.js');

const HOST = '127.0.0.1';
const TIMEOUT = 2000;
const portFile = () => path.join(os.homedir(), '.terra-pet', 'port');

const INSTRUCTIONS = `Terra is a small pixel-art robot that lives on the user's desktop. These tools only
animate it; they change nothing else. Use terra_state to show what you are doing (working
before a long answer or task, done when it is finished, waiting when you need the user) and
terra_react now and then to show how the conversation feels. Always give "done" a mood that
matches how the conversation went, so Terra ends the right way: happy when it went well or
the user was kind (they thanked you), sad for bad news or a failure, angry when the user
insulted you or is fed up, neutral for an ordinary answer (most replies). For example:
thanks -> happy, an insult -> angry, bad news -> sad, a normal answer -> neutral. "done"
also always needs "say": one short line, about 40 characters, that Terra shows in its
speech bubble: for a short answer the answer itself ("Tokyo!", "42!"), for a long answer a
short summary ("Facebook: Meta's social network!"), for thanks or greetings something
friendly ("Happy to help!"); never code or private details. terra_say is only for an extra
line during a reply (at most once; never for code, lists, long explanations or anything
sensitive); the answer itself goes in done's say. There is no need to mention the tools or
their results to the user unless they ask about Terra.`;

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
Calls made close together don't cut each other off: Terra plays them one after another, each reaction to its end. After the reaction Terra goes back to what it was doing (still working, if it was).`;

const STATE_DESCRIPTION = `Set what Terra, the user's desktop pet, is doing, so the user can glance at it to see your status.
- working: call it before a long answer or a multi-step task (research, writing code, several tool calls). Terra sits at its computer until you set another state.
- done: call it when you have finished that work, always with a mood and a say line (below). Terra stands up, shows the mood with your line in its speech bubble, then idles.
- waiting: call it when you stop to wait for the user's answer, decision or approval. Terra keeps asking until you set another state.
- idle: puts Terra back to rest, for example when you stop without finishing.
The mood (only with done) is how the conversation went:
- happy: it went well or the user was kind (they thanked you, the tests pass). Terra celebrates with stars.
- sad: bad news or a failure (it still doesn't work, you couldn't do it). Terra looks sad.
- angry: the user insulted you or is fed up. Terra looks angry.
- neutral: an ordinary answer, nothing special (most replies). Terra just stands up and idles.
Examples: thanks -> happy, an insult -> angry, bad news -> sad, a normal answer -> neutral.
The say line (required with done) is one short line, about 40 characters, for Terra's speech bubble:
- a short answer: the answer itself ("Tokyo!", "42!")
- a long answer: a short summary ("Facebook: Meta's social network!")
- thanks or greetings: something friendly ("Happy to help!")
Never code or private details. 2 lines of about 20 characters show; longer is cut with "...".
For example: terra_state("working") before a long answer and terra_state("done", mood "neutral", say "Tokyo!") after it. Skip it for short, quick replies. Terra gives up on working or waiting by itself after 10 minutes.`;

const SAY_DESCRIPTION = `Show a short line of text in a speech bubble next to Terra, the user's desktop pet, while it talks. The user sees it on their screen for a few seconds.
Use it for short, simple answers and friendly remarks, for example "Paris is the capital of France!" or "Happy to help!", as an extra line during a reply: the answer itself goes in terra_state("done")'s say. At most once per reply.
Do not use it for code, lists, long explanations or anything sensitive (passwords, personal or private details).
It fits 2 lines of about 20 characters each; longer text is cut with "...". ${WRITES}`;

const STATE_DONE = {
  working: 'Terra is working at its computer. Call terra_state("done") with a mood when you finish.',
  waiting: 'Terra is waiting for the user.',
  done: 'Terra stands up and idles (or ends the way your last reaction in this reply suggests). Next time give done a mood too: happy, sad, angry or neutral.',
  idle: 'Terra is back to idle.',
};
const DONE_MOOD = {
  happy: 'Terra celebrates with stars, then idles.',
  sad: 'Terra looks sad for a moment, then idles.',
  angry: 'Terra looks angry for a moment, then idles.',
  neutral: 'Terra stands up and idles.',
};

// Resolves to { status } from the listener, or { down: true } when nothing answers.
function post(body, route = '/mcp') {
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
      path: route,
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

const DOWN = "Terra (the desktop pet) isn't running, so there was nothing to show. That's fine: carry on, no need to retry.";

async function send(body, okMessage) {
  let { status, down } = await post(body);
  // A Terra from before moods and done's bubble turns them away; it still takes plain "done".
  if (status === 400 && (body.mood || body.say)) {
    ({ status, down } = await post({ state: body.state }));
    okMessage = 'This copy of Terra is too old for moods and done\'s speech bubble, so it ended its own way. No need to retry.';
  }
  if (down) return text(DOWN);
  if (status === 204) return text(okMessage);
  if (status === 404) return text('This copy of Terra is too old to take commands from Claude desktop, so nothing was shown. No need to retry.');
  return text(`Terra didn't accept the command (HTTP ${status}).`, true);
}

const SAY_REQUIRED = 'done needs "say": resend terra_state with state "done", your mood and say, a short answer or summary for Terra\'s speech bubble (about 40 characters), for example "Tokyo!" or "Happy to help!".';

// "done" with its mood and say line: sends the line as the font will draw it (or none, when
// nothing in it can be drawn), and tells Claude what Terra shows.
function done(mood, line) {
  const layout = layoutBubble(line);
  const body = { state: 'done', ...(mood ? { mood } : {}), ...(layout ? { say: cleanText(line).slice(0, MAX_INPUT) } : {}) };
  const ending = mood ? DONE_MOOD[mood] : STATE_DONE.done;
  return send(body, layout ? `${ending} Its bubble says: "${layout.lines.join(' / ')}"${layout.trimmed ? ' (cut to fit: keep it shorter next time)' : ''}.` : ending);
}

// terra_say: sends Terra the text the font can draw (nothing else), and tells Claude what
// will show. The text is never logged.
async function say(raw) {
  const layout = layoutBubble(raw);
  if (!layout) return text(`Nothing to show: Terra's font has only ${CHARACTERS}. No need to retry.`);
  const { status, down } = await post({ text: cleanText(raw).slice(0, MAX_INPUT) }, '/say');
  if (down) return text(DOWN);
  if (status === 409) return text("The user has turned Terra's speech bubbles off, so nothing was shown. Don't use terra_say again in this conversation.");
  if (status === 404) return text('This copy of Terra is too old for speech bubbles, so nothing was shown. No need to retry.');
  if (status !== 204) return text(`Terra didn't accept the text (HTTP ${status}).`, true);
  const shown = layout.lines.join(' / ');
  return text(`Terra says: "${shown}"${layout.trimmed ? ' (cut to fit: keep it shorter next time)' : ''}.`);
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
      mood: z.enum(MOODS).optional().describe('Only with done, and always with done: how the conversation went. happy, sad, angry or neutral.'),
      say: z.string().optional().describe(`Required with done (ignored otherwise): one short line, about 40 characters, for Terra's speech bubble. A short answer: the answer itself ("Tokyo!", "42!"). A long answer: a short summary ("Facebook: Meta's social network!"). Thanks or greetings: something friendly ("Happy to help!"). Never code or private details. ${WRITES}`),
    }).superRefine(({ state, say: line }, ctx) => {
      if (state === 'done' && !(typeof line === 'string' && line.trim())) ctx.addIssue({ code: 'custom', path: ['say'], message: SAY_REQUIRED });
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ state, mood, say: line }) => (state === 'done' ? done(mood, line) : send({ state }, STATE_DONE[state])));

  server.registerTool('terra_say', {
    title: 'Terra: say',
    description: SAY_DESCRIPTION,
    inputSchema: z.object({
      text: z.string().min(1).describe('The words to show, as plain text: a short answer or remark, about 40 characters at most.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ text: words }) => say(words));

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
