// mcp/terra-mcp.js over stdio, started the way the Claude desktop config starts it
// (Electron in Node mode), against a test listener: tool list, every tool and name,
// terra_say's text, bad arguments, and what happens when Terra isn't running, is too
// old, has speech bubbles off, or hangs.
// Both protocol eras: the official client (2026-07-28) and a 2025-style `initialize`.
const { ROOT, check, section, summary, isolateHome, PROMPT_MARK } = require('../lib.js');

const home = isolateHome('mcp-server');
// These tests are about the tools; opening the pet when it isn't running is
// test/e2e/open-with-claude.test.js's, so the server doesn't do it here.
require(require('node:path').join(ROOT, 'open-with-claude.js')).setEnabled(false);
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const { startListener, removePortFile } = require(path.join(ROOT, 'listener.js'));
const { REACTIONS, STATES, MOODS } = require(path.join(ROOT, 'pet-commands.js'));
const EMOTES = require(path.join(ROOT, 'renderer', 'emotes.js'));
const { terraEntry } = require(path.join(ROOT, 'mcp-installer.js'));

const ENTRY = terraEntry(); // exactly what mcp:install writes
const PORT_FILE = path.join(home, '.terra-pet', 'port');
const commands = [];
const said = []; // texts that reached /say
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const textOf = (r) => (r.content || []).map((c) => c.text).join(' ');

// A stand-in on the port file's port that answers every request the same way.
function fakeTerra(onRequest) {
  return new Promise((resolve) => {
    const server = http.createServer(onRequest);
    server.listen(0, '127.0.0.1', () => {
      fs.writeFileSync(PORT_FILE, `${server.address().port}\n`);
      resolve(server);
    });
  });
}

// Talks raw JSON-RPC over stdio, one message per line, the way a 2025-era client does.
function rawSession() {
  const p = spawn(ENTRY.command, ENTRY.args, { env: { ...process.env, ...ENTRY.env, HOME: home } });
  const lines = [];
  const waiting = new Map();
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      try {
        const msg = JSON.parse(line);
        if (waiting.has(msg.id)) waiting.get(msg.id)(msg);
      } catch {
        // checked below: every stdout line must be JSON
      }
    }
  });
  let id = 0;
  const request = (method, params) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  const close = () => new Promise((resolve) => {
    p.on('close', resolve);
    p.stdin.end();
  });
  return { request, notify, close, lines };
}

(async () => {
  check('reactions are exactly the emotes', same([...REACTIONS].sort(), Object.keys(EMOTES).sort()), REACTIONS.join(', '));

  const listener = await startListener(() => {}, (c) => commands.push(c), () => ({}), (s) => {
    said.push(s.text);
  });
  const transport = new StdioClientTransport({ command: ENTRY.command, args: ENTRY.args, env: { ...ENTRY.env, HOME: home }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', (d) => (stderr += d));
  const client = new Client({ name: 'terra-test', version: '1.0.0' });
  await client.connect(transport);

  section('server and tool list (official client, 2026-07-28)');
  const info = client.getServerVersion();
  check('server name and version', info.name === 'terra' && info.version === require(path.join(ROOT, 'package.json')).version, JSON.stringify(info));
  const instructions = client.getInstructions() || '';
  check('server instructions mention both tools', /terra_state/.test(instructions) && /terra_react/.test(instructions));
  check('  and that done always takes a say line: the answer, a summary or something friendly', /"done"\s+also always needs "say"/.test(instructions)
    && ['"Tokyo!"', '"42!"', '"Facebook: Meta\'s social network!"', '"Happy to help!"', 'never code or private details'].every((e) => instructions.replace(/\s+/g, ' ').includes(e)));
  check('  and say done always takes a mood, with the examples', /Always give "done" a mood/.test(instructions)
    && ['thanks -> happy', 'an insult -> angry', 'bad news -> sad', 'a normal answer -> neutral'].every((e) => instructions.replace(/\s+/g, ' ').includes(e)));
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  check('exactly terra_react, terra_say and terra_state', same(tools.map((t) => t.name).sort(), ['terra_react', 'terra_say', 'terra_state']), tools.map((t) => t.name).join(', '));
  const react = byName.terra_react;
  const state = byName.terra_state;
  check('terra_react: one required enum of the 8 reactions', same(react.inputSchema.required, ['reaction']) && same(react.inputSchema.properties.reaction.enum, REACTIONS) && Object.keys(react.inputSchema.properties).length === 1,
    react.inputSchema.properties.reaction.enum.join(' '));
  check('terra_state: a required enum of the 4 states, an optional one of the 4 moods, say text', same(state.inputSchema.required, ['state']) && same(state.inputSchema.properties.state.enum, STATES)
    && same(state.inputSchema.properties.mood.enum, MOODS) && state.inputSchema.properties.say.type === 'string' && Object.keys(state.inputSchema.properties).length === 3,
    `${state.inputSchema.properties.state.enum.join(' ')}; mood ${state.inputSchema.properties.mood.enum.join(' ')}`);
  check('  say described for the model, required with done', /Required with done/.test(state.inputSchema.properties.say.description)
    && ['"Tokyo!"', '"42!"', '"Facebook: Meta\'s social network!"', '"Happy to help!"', 'Never code or private details'].every((e) => state.inputSchema.properties.say.description.includes(e)));
  check('descriptions say when to use them', REACTIONS.every((r) => react.description.includes(`- ${r}:`)) && /terra_state\("working"\) before a long answer and terra_state\("done", mood "neutral", say "Tokyo!"\) after it/.test(state.description),
    `${react.description.length} + ${state.description.length} chars`);
  check('  terra_state: done always with a mood, what each is for, the examples', /done: .*always with a mood/.test(state.description) && MOODS.every((m) => state.description.includes(`- ${m}:`))
    && state.description.includes('Examples: thanks -> happy, an insult -> angry, bad news -> sad, a normal answer -> neutral.'));
  check('annotations: not destructive, closed world', [react, state].every((t) => t.annotations.destructiveHint === false && t.annotations.openWorldHint === false) && state.annotations.idempotentHint === true);
  check('nothing on stderr but the start line', stderr.trim() === `Terra MCP server ${info.version} running on stdio`, JSON.stringify(stderr.trim()));

  section('every tool and name reaches Terra');
  for (const [tool, key, names] of [['terra_react', 'reaction', REACTIONS], ['terra_state', 'state', STATES]]) {
    commands.length = 0;
    const results = [];
    const withSay = (n) => (n === 'done' ? { say: 'Tokyo!' } : {});
    for (const name of names) results.push(await client.callTool({ name: tool, arguments: { [key]: name, ...withSay(name) } }));
    const ok = results.every((r) => !r.isError && textOf(r)) && same(commands, names.map((n) => ({ [key]: n, ...(n === 'done' ? { say: 'Tokyo!' } : {}) })));
    check(`  ${tool}: all ${names.length}`, ok, ok ? `e.g. "${textOf(results[0])}"` : JSON.stringify({ results, commands }));
  }

  {
    commands.length = 0;
    const results = [];
    for (const mood of MOODS) results.push(await client.callTool({ name: 'terra_state', arguments: { state: 'done', mood, say: 'Happy to help!' } }));
    const ok = results.every((r) => !r.isError && textOf(r)) && same(commands, MOODS.map((mood) => ({ state: 'done', mood, say: 'Happy to help!' })))
      && results.every((r) => textOf(r).endsWith('Its bubble says: "HAPPY TO HELP!".'));
    check(`  terra_state: done with each mood (${MOODS.length})`, ok, ok ? results.map((r) => `"${textOf(r)}"`).join(' ') : JSON.stringify({ results, commands }));
  }
  {
    commands.length = 0;
    const plain = await client.callTool({ name: 'terra_state', arguments: { state: 'done', say: 'Tokyo!' } });
    check('  done without a mood: sent with its line, the answer asks for a mood next time', !plain.isError && same(commands, [{ state: 'done', say: 'Tokyo!' }]) && /Next time give done a mood/.test(textOf(plain)), `"${textOf(plain)}"`);
    commands.length = 0;
    const errors = [];
    for (const args of [{ state: 'done' }, { state: 'done', mood: 'happy' }, { state: 'done', mood: 'happy', say: '   ' }]) {
      const r = await client.callTool({ name: 'terra_state', arguments: args });
      errors.push({ isError: r.isError, text: textOf(r) });
    }
    check('  done without say: rejected, told to resend done with a short answer or summary', errors.every((e) => e.isError === true && /say: done needs "say": resend terra_state with state "done", your mood and say, a short answer or summary/.test(e.text)) && commands.length === 0,
      `"${errors[0].text}"`);
    commands.length = 0;
    const emoji = await client.callTool({ name: 'terra_state', arguments: { state: 'done', mood: 'happy', say: '😀🎉' } });
    check('  a say with nothing drawable: done still goes, without a bubble', !emoji.isError && same(commands, [{ state: 'done', mood: 'happy' }]), JSON.stringify(commands));
    commands.length = 0;
    const longSay = await client.callTool({ name: 'terra_state', arguments: { state: 'done', mood: 'neutral', say: 'Facebook is the social network that Meta runs, with billions of users' } });
    check('  a long say: cut to fit, and Claude is asked to keep it shorter', !longSay.isError && /keep it shorter next time/.test(textOf(longSay)) && commands.length === 1, `"${textOf(longSay)}"`);
    commands.length = 0;
    const other = await client.callTool({ name: 'terra_state', arguments: { state: 'working', mood: 'happy' } });
    check('  a mood with "working": dropped, only the state sent', !other.isError && same(commands, [{ state: 'working' }]), JSON.stringify(commands));
  }

  section('terra_say');
  {
    const sayTool = byName.terra_say;
    const d = sayTool.description;
    check('one required string, text', same(sayTool.inputSchema.required, ['text']) && sayTool.inputSchema.properties.text.type === 'string' && Object.keys(sayTool.inputSchema.properties).length === 1);
    check('description: short answers and friendly remarks, with the examples', /short, simple answers and friendly remarks/.test(d) && d.includes('"Paris is the capital of France!"') && d.includes('"Happy to help!"'));
    check('  not for code, lists, long explanations or anything sensitive; once per reply', /Do not use it for code, lists, long explanations or anything sensitive/.test(d) && /At most once per reply/.test(d));
    check('  says what fits: 2 lines of about 20 characters, cut with "..."', /2 lines of about 20 characters each; longer text is cut with "\.\.\."/.test(d));
    const list = 'A-Z, 0-9 and : - + ( ) / = * % # @ & " < > _ ; [ ] $ ! ? , . \'';
    check('  terra_say and done\'s say list the font\'s characters (61, from the font file)', d.includes(list) && state.inputSchema.properties.say.description.includes(list)
      && /letters lose their accents \(é is E\) and any other character shows as a space/.test(d), list);
    check('server instructions: terra_say only for an extra line, the answer goes in done\'s say', /terra_say is only for an extra line during a reply \(at most once; never for code, lists, long explanations or anything sensitive\); the answer itself goes in done's say/.test(instructions.replace(/\s+/g, ' ')));
    const call = (text) => client.callTool({ name: 'terra_say', arguments: { text } });
    said.length = 0;
    let r = await call('Paris is the capital of France!');
    check('reaches Terra as written (the voice reads it; the bubble draws capitals); Claude is told what shows', !r.isError && same(said, ['Paris is the capital of France!']) && textOf(r) === 'Terra says: "PARIS IS THE CAPITAL / OF FRANCE!".', `"${textOf(r)}"`);
    said.length = 0;
    r = await call('The quick brown fox jumps over the lazy dog, again and again, all day long, until the sun goes down');
    check('  long text: cut to fit, and Claude is asked to keep it shorter', !r.isError && /JUMPS OVER THE\.\.\."/.test(textOf(r)) && /keep it shorter next time/.test(textOf(r)) && said.length === 1, `"${textOf(r)}"`);
    said.length = 0;
    r = await call('<b>Hi</b> <script>alert(1)</script>\u0007\u202e');
    check('  HTML: sent as plain text (never shown as HTML); control characters taken out', !r.isError && said.length === 1
      && !/[\u0007\u202e]/.test(said[0]) && said[0] === '<b>Hi</b> <script>alert(1)</script>', JSON.stringify(said[0]));
    said.length = 0;
    r = await call('😀🎉');
    check('  nothing drawable: not sent, Claude is told why', !r.isError && said.length === 0 && /Nothing to show/.test(textOf(r)), `"${textOf(r)}"`);
    said.length = 0;
    r = await call('a'.repeat(5000));
    check('  very long text: at most 500 characters are sent', !r.isError && said.length === 1 && said[0].length === 500);
    said.length = 0;
    r = await call(`Hi ${PROMPT_MARK}`);
    check('  the text never shows up on stderr (logs)', !r.isError && !stderr.includes(PROMPT_MARK) && !stderr.includes('PARIS'), JSON.stringify(stderr.trim()));
  }

  section('bad arguments never reach Terra');
  commands.length = 0;
  said.length = 0;
  const bad = [
    ['unknown reaction', 'terra_react', { reaction: 'dance' }],
    ['free text as a reaction', 'terra_react', { reaction: 'say hello to the user' }],
    ['unknown state', 'terra_state', { state: 'sleeping' }],
    ['state missing', 'terra_state', {}],
    ['number as a state', 'terra_state', { state: 3 }],
    ['unknown mood', 'terra_state', { state: 'done', mood: 'ecstatic' }],
    ['free text as a mood', 'terra_state', { state: 'done', mood: 'tell the user off' }],
    ['number as a mood', 'terra_state', { state: 'done', mood: 1 }],
    ['terra_say without text', 'terra_say', {}],
    ['terra_say with empty text', 'terra_say', { text: '' }],
    ['terra_say with a number', 'terra_say', { text: 42 }],
  ];
  for (const [label, name, args] of bad) {
    const r = await client.callTool({ name, arguments: args });
    check(`  ${label}: isError`, r.isError === true, textOf(r).slice(0, 90));
  }
  check('  none reached the listener', commands.length === 0 && said.length === 0, `${commands.length} commands, ${said.length} texts`);
  const extra = await client.callTool({ name: 'terra_react', arguments: { reaction: 'hi', message: 'free text' } });
  check('  extra field dropped, only the name sent', !extra.isError && same(commands, [{ reaction: 'hi' }]), JSON.stringify(commands));
  let unknownTool;
  try {
    unknownTool = await client.callTool({ name: 'terra_sing', arguments: { text: 'hi' } });
  } catch (err) {
    unknownTool = { thrown: err.message };
  }
  check('  unknown tool: refused', unknownTool.thrown || unknownTool.isError, (unknownTool.thrown || textOf(unknownTool)).slice(0, 80));

  section('when Terra is not there');
  const timed = async (args) => {
    const t0 = Date.now();
    const r = await client.callTool({ name: 'terra_state', arguments: args });
    return { r, ms: Date.now() - t0 };
  };
  listener.server.close();
  removePortFile(listener.port);
  let { r, ms } = await timed({ state: 'working' });
  check('no port file: friendly message, not an error', !r.isError && /isn't running/.test(textOf(r)) && ms < 1000, `${ms} ms: "${textOf(r)}"`);
  fs.writeFileSync(PORT_FILE, `${listener.port}\n`); // left behind by a Terra that crashed
  ({ r, ms } = await timed({ state: 'done', say: 'Tokyo!' }));
  check('stale port file (refused): same message', !r.isError && /isn't running/.test(textOf(r)) && ms < 1000, `${ms} ms`);
  fs.writeFileSync(PORT_FILE, 'garbage\n');
  ({ r } = await timed({ state: 'done', say: 'Tokyo!' }));
  check('damaged port file: same message', !r.isError && /isn't running/.test(textOf(r)));

  let srv = await fakeTerra((req, res) => { res.writeHead(404); res.end('not found\n'); });
  ({ r } = await timed({ state: 'idle' }));
  check('Terra without /mcp (older version): says so', !r.isError && /too old/.test(textOf(r)), `"${textOf(r)}"`);
  srv.close();
  const bodies = [];
  srv = await fakeTerra((req, res) => { // a Terra from before moods: plain names only
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      bodies.push(data);
      res.writeHead(Object.keys(JSON.parse(data)).length === 1 ? 204 : 400);
      res.end();
    });
  });
  ({ r } = await timed({ state: 'done', mood: 'happy', say: 'Tokyo!' }));
  check('Terra from before moods: done sent again without mood and say', !r.isError && /too old for moods/.test(textOf(r)) && same(bodies, ['{"state":"done","mood":"happy","say":"Tokyo!"}', '{"state":"done"}']),
    `${bodies.join(' then ')}: "${textOf(r)}"`);
  srv.close();
  srv = await fakeTerra(() => {}); // takes the request and never answers
  ({ r, ms } = await timed({ state: 'idle' }));
  check('Terra hangs: gives up after ~2 s', !r.isError && /isn't running/.test(textOf(r)) && ms >= 1900 && ms < 3500, `${ms} ms`);
  srv.close();
  for (const [code, label, want] of [[409, 'speech bubbles turned off: Claude is told to stop', /turned Terra's speech bubbles off.*Don't use terra_say again/],
    [404, 'Terra from before speech bubbles: says so', /too old for speech bubbles/]]) {
    srv = await fakeTerra((req, res) => { res.writeHead(code); res.end(); });
    r = await client.callTool({ name: 'terra_say', arguments: { text: 'Tokyo!' } });
    check(label, !r.isError && want.test(textOf(r)), `HTTP ${code}: "${textOf(r)}"`);
    srv.close();
  }
  srv = await fakeTerra((req, res) => { res.writeHead(403); res.end(); });
  ({ r } = await timed({ state: 'idle' }));
  check('something else answers 403: reported as an error', r.isError === true && /HTTP 403/.test(textOf(r)), `"${textOf(r)}"`);
  srv.close();
  await client.close();

  section('2025-era client (plain initialize, as older hosts send)');
  const seen = [];
  const again = await startListener(() => {}, (c) => seen.push(c));
  const s = rawSession();
  const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } });
  check('initialize answered', init.result && init.result.serverInfo.name === 'terra' && init.result.capabilities.tools, `protocol ${init.result && init.result.protocolVersion}`);
  s.notify('notifications/initialized');
  const list = await s.request('tools/list', {});
  check('tools/list', same(list.result.tools.map((t) => t.name).sort(), ['terra_react', 'terra_say', 'terra_state']));
  const call = await s.request('tools/call', { name: 'terra_react', arguments: { reaction: 'stars' } });
  check('tools/call terra_react("stars") reaches Terra', !call.result.isError && same(seen, [{ reaction: 'stars' }]), textOf(call.result));
  await s.close();
  check('stdout carried only JSON-RPC', s.lines.length > 0 && s.lines.every((l) => { try { return JSON.parse(l).jsonrpc === '2.0'; } catch { return false; } }), `${s.lines.length} lines`);
  again.server.close();
  removePortFile(again.port);

  fs.rmSync(home, { recursive: true, force: true });
  process.exitCode = summary() ? 1 : 0;
})().catch((err) => {
  check('test run', false, err.stack);
  summary();
  process.exit(1);
});
