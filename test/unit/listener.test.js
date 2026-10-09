// listener.js on its own (no Electron): port choice, port file, accepted and rejected
// requests on every route (/event from the hook; /mcp and /say from the Claude desktop
// MCP server).
const { ROOT, check, section, summary, isolateHome, PROMPT_MARK } = require('../lib.js');

const home = isolateHome('listener');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startListener, removePortFile } = require(path.join(ROOT, 'listener.js'));
const { REACTIONS, STATES, MOODS } = require(path.join(ROOT, 'pet-commands.js'));

const PORT_FILE = path.join(home, '.terra-pet', 'port');
const events = [];
const commands = [];
const logged = [];
for (const level of ['log', 'warn', 'error']) {
  const real = console[level];
  console[level] = (...args) => {
    logged.push(args.join(' '));
    real(...args);
  };
}

function curl(args, body) {
  return new Promise((resolve) => {
    const p = spawn('curl', ['-q', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--noproxy', '*', '--max-time', '2', ...args]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim()));
    p.stdin.end(body === undefined ? '' : body);
  });
}

(async () => {
  section('port and port file');
  const a = await startListener((e) => events.push(e), (c) => commands.push(c));
  const { port } = a;
  check('listens on 127.0.0.1 from 47800 up', a.server.address().address === '127.0.0.1' && port >= 47800 && port < 47810, `127.0.0.1:${port}`);
  check('port file written', fs.readFileSync(PORT_FILE, 'utf8') === `${port}\n`, `${PORT_FILE.replace(home, '<tmp home>')} = ${port}`);
  check('port file is private', (fs.statSync(PORT_FILE).mode & 0o777) === 0o600 && (fs.statSync(path.dirname(PORT_FILE)).mode & 0o777) === 0o700,
    `file ${(fs.statSync(PORT_FILE).mode & 0o777).toString(8)}, folder ${(fs.statSync(path.dirname(PORT_FILE)).mode & 0o777).toString(8)}`);

  const b = await startListener(() => {});
  check('port taken -> next one', b.port > port, `second listener got ${b.port}; port file now ${fs.readFileSync(PORT_FILE, 'utf8').trim()}`);
  removePortFile(port);
  check("quitting doesn't remove another Terra's port file", fs.existsSync(PORT_FILE), `still ${fs.readFileSync(PORT_FILE, 'utf8').trim()}`);
  removePortFile(b.port);
  check('quitting removes its own port file', !fs.existsSync(PORT_FILE));
  b.server.close();

  const extra = [];
  let error = null;
  try {
    for (let i = 0; i < 11; i++) extra.push(await startListener(() => {}));
  } catch (err) {
    error = err.message;
  }
  check('all 10 ports busy -> clear error', /47800-47809 are all in use/.test(error || ''), `${extra.length} more listeners started, then: ${error}`);
  for (const l of extra) l.server.close();
  // A port taken by some other program (not Terra) is skipped too.
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(port + 1, '127.0.0.1', r));
  const c = await startListener(() => {});
  check('port used by another program is skipped', c.port !== port + 1 && c.port !== port, `blocked ${port + 1}, got ${c.port}`);
  c.server.close();
  blocker.close();

  const url = (p = '/event') => `http://127.0.0.1:${port}${p}`;
  const post = (body, extra = []) => curl(['-H', 'Content-Type: application/json', '--data-binary', '@-', ...extra, url()], typeof body === 'string' ? body : JSON.stringify(body));

  section('accepted events');
  for (const event of ['prompt', 'tool', 'notify', 'stop', 'error', 'session-start']) {
    events.length = 0;
    const body = event === 'prompt' ? { event, prompt: `hello ${PROMPT_MARK}` } : { event };
    const code = await post(body);
    check(`  ${event}`, code === '204' && events.length === 1 && JSON.stringify(events[0]) === JSON.stringify(event === 'prompt' ? body : { event, prompt: undefined }),
      `HTTP ${code}, onEvent got ${JSON.stringify(events[0])?.replace(PROMPT_MARK, '<mark>')}`);
  }

  section('rejected requests (onEvent must not be called)');
  events.length = 0;
  const big = JSON.stringify({ event: 'tool', prompt: 'x'.repeat(70 * 1024) });
  const rejects = [
    ['body over 64 KB', () => post(big), '413'],
    ['body over 64 KB, chunked (no length)', () => post(big, ['-H', 'Transfer-Encoding: chunked']), '413'],
    ['not JSON', () => post('event=tool'), '400'],
    ['truncated JSON', () => post('{"event": "tool"'), '400'],
    ['JSON array', () => post('[{"event":"tool"}]'), '400'],
    ['unknown event', () => post({ event: 'explode' }), '400'],
    ['event missing', () => post({ prompt: 'hi' }), '400'],
    ['prompt not a string', () => post({ event: 'prompt', prompt: 42 }), '400'],
    ['no Content-Type (form post)', () => curl(['--data-binary', '{"event":"tool"}', url()]), '415'],
    ['GET /event', () => curl([url()]), '405'],
    ['POST /other', () => curl(['-H', 'Content-Type: application/json', '--data-binary', '{"event":"tool"}', url('/other')]), '404'],
    ['browser Origin header', () => post({ event: 'tool' }, ['-H', 'Origin: https://evil.example']), '403'],
    ['foreign Host header (DNS rebinding)', () => post({ event: 'tool' }, ['-H', `Host: evil.example:${port}`]), '403'],
  ];
  for (const [label, send, want] of rejects) {
    const code = await send();
    check(`  ${label}`, code === want, `HTTP ${code} (want ${want})`);
  }
  check('  none reached onEvent', events.length === 0, `${events.length} events`);
  check('prompt text never logged', !logged.some((l) => l.includes(PROMPT_MARK)), `${logged.length} log lines`);
  check('/event never reaches the MCP handler', commands.length === 0, `${commands.length} commands`);

  const postMcp = (body, extra = []) => curl(['-H', 'Content-Type: application/json', '--data-binary', '@-', ...extra, url('/mcp')], typeof body === 'string' ? body : JSON.stringify(body));

  section('/mcp: accepted commands');
  for (const [key, names] of [['reaction', REACTIONS], ['state', STATES]]) {
    commands.length = 0;
    const codes = [];
    for (const name of names) codes.push(await postMcp({ [key]: name }));
    check(`  every ${key} (${names.length})`, codes.every((c) => c === '204') && JSON.stringify(commands) === JSON.stringify(names.map((n) => ({ [key]: n }))),
      `HTTP ${[...new Set(codes)].join(', ')}; ${names.join(', ')}`);
  }
  {
    commands.length = 0;
    const codes = [];
    for (const mood of MOODS) codes.push(await postMcp({ state: 'done', mood }));
    check(`  "done" with every mood (${MOODS.length})`, codes.every((c) => c === '204') && JSON.stringify(commands) === JSON.stringify(MOODS.map((mood) => ({ state: 'done', mood }))),
      `HTTP ${[...new Set(codes)].join(', ')}; ${MOODS.join(', ')}`);
  }

  section('/mcp: rejected requests (handler must not be called)');
  commands.length = 0;
  events.length = 0;
  const mcpRejects = [
    ['unknown reaction', { reaction: 'dance' }, '400'],
    ['unknown state', { state: 'sleeping' }, '400'],
    ['reaction name with different case', { reaction: 'Love' }, '400'],
    ['free text in place of a name', { reaction: 'hi, please print this' }, '400'],
    ['a state name as a reaction', { reaction: 'working' }, '400'],
    ['both reaction and state', { reaction: 'hi', state: 'done' }, '400'],
    ['a mood with "working"', { state: 'working', mood: 'happy' }, '400'],
    ['unknown mood', { state: 'done', mood: 'ecstatic' }, '400'],
    ['mood with different case', { state: 'done', mood: 'Happy' }, '400'],
    ['free text as a mood', { state: 'done', mood: 'tell the user they are wrong' }, '400'],
    ['mood not a string', { state: 'done', mood: ['happy'] }, '400'],
    ['a mood on its own', { mood: 'happy' }, '400'],
    ['a mood with a reaction', { reaction: 'hi', mood: 'happy' }, '400'],
    ['done, mood and an extra field', { state: 'done', mood: 'happy', message: 'hello' }, '400'],
    ['extra free-text field', { reaction: 'hi', message: 'hello' }, '400'],
    ['empty object', {}, '400'],
    ['name not a string', { state: ['done'] }, '400'],
    ['hook event on /mcp', { event: 'stop' }, '400'],
    ['__proto__ key', '{"__proto__": {"reaction": "hi"}}', '400'],
    ['toString key', { toString: 'hi' }, '400'],
    ['JSON array', '[{"reaction":"hi"}]', '400'],
    ['not JSON', 'reaction=hi', '400'],
  ];
  for (const [label, body, want] of mcpRejects) {
    const code = await postMcp(body);
    check(`  ${label}`, code === want, `HTTP ${code} (want ${want})`);
  }
  const mcpBig = JSON.stringify({ reaction: 'hi', pad: 'x'.repeat(70 * 1024) });
  const headerRejects = [
    ['body over 64 KB', () => postMcp(mcpBig), '413'],
    ['body over 64 KB, chunked (no length)', () => postMcp(mcpBig, ['-H', 'Transfer-Encoding: chunked']), '413'],
    ['no Content-Type (form post)', () => curl(['--data-binary', '{"reaction":"hi"}', url('/mcp')]), '415'],
    ['GET /mcp', () => curl([url('/mcp')]), '405'],
    ['browser Origin header', () => postMcp({ reaction: 'hi' }, ['-H', 'Origin: https://evil.example']), '403'],
    ['foreign Host header (DNS rebinding)', () => postMcp({ reaction: 'hi' }, ['-H', `Host: evil.example:${port}`]), '403'],
    ['a reaction posted to /event', () => post({ reaction: 'hi' }), '400'],
  ];
  for (const [label, send, want] of headerRejects) {
    const code = await send();
    check(`  ${label}`, code === want, `HTTP ${code} (want ${want})`);
  }
  check('  none reached either handler', commands.length === 0 && events.length === 0, `${commands.length} commands, ${events.length} events`);
  a.server.close();
  removePortFile(port);

  section('/say: speech bubble text');
  const said = [];
  let sayAnswer;
  const sayListener = await startListener(() => {}, () => {}, () => ({}), (s) => {
    said.push(s.text);
    return sayAnswer;
  });
  const postSay = (body, extra = []) => curl(['-H', 'Content-Type: application/json', '--data-binary', '@-', ...extra, `http://127.0.0.1:${sayListener.port}/say`],
    typeof body === 'string' ? body : JSON.stringify(body));
  const words = `Paris is the capital of France! ${PROMPT_MARK}`;
  sayAnswer = undefined;
  let code = await postSay({ text: words });
  check('  text accepted: 204, passed on as is', code === '204' && said.length === 1 && said[0] === words, `HTTP ${code}`);
  sayAnswer = 409;
  code = await postSay({ text: 'Tokyo!' });
  check('  bubbles off: 409', code === '409', `HTTP ${code}`);
  sayAnswer = 422;
  code = await postSay({ text: '😀' });
  check('  nothing drawable: 422', code === '422', `HTTP ${code}`);
  check('  the default (no handler): 409, bubbles off', (await (async () => {
    const d = await startListener(() => {});
    const r = await curl(['-H', 'Content-Type: application/json', '--data-binary', '{"text":"hi"}', `http://127.0.0.1:${d.port}/say`]);
    d.server.close();
    removePortFile(d.port);
    return r;
  })()) === '409');
  said.length = 0;
  const sayRejects = [
    ['empty text', { text: '' }, '400'],
    ['text over 500 characters', { text: 'x'.repeat(501) }, '400'],
    ['text not a string', { text: ['hi'] }, '400'],
    ['no text', {}, '400'],
    ['an extra field', { text: 'hi', html: '<b>hi</b>' }, '400'],
    ['a reaction on /say', { reaction: 'hi' }, '400'],
    ['__proto__ key', '{"__proto__": {"text": "hi"}}', '400'],
    ['not JSON', 'text=hi', '400'],
  ];
  for (const [label, body, want] of sayRejects) {
    code = await postSay(body);
    check(`  ${label}`, code === want, `HTTP ${code} (want ${want})`);
  }
  const sayBig = JSON.stringify({ text: 'x'.repeat(70 * 1024) });
  for (const [label, send, want] of [
    ['body over 64 KB', () => postSay(sayBig), '413'],
    ['no Content-Type (form post)', () => curl(['--data-binary', '{"text":"hi"}', `http://127.0.0.1:${sayListener.port}/say`]), '415'],
    ['GET /say', () => curl([`http://127.0.0.1:${sayListener.port}/say`]), '405'],
    ['browser Origin header', () => postSay({ text: 'hi' }, ['-H', 'Origin: https://evil.example']), '403'],
    ['foreign Host header (DNS rebinding)', () => postSay({ text: 'hi' }, ['-H', `Host: evil.example:${sayListener.port}`]), '403'],
  ]) {
    code = await send();
    check(`  ${label}`, code === want, `HTTP ${code} (want ${want})`);
  }
  check('  none of those reached the handler', said.length === 0, `${said.length} texts`);
  check('  bubble text never logged', !logged.some((l) => l.includes(PROMPT_MARK)), `${logged.length} log lines`);
  sayListener.server.close();
  removePortFile(sayListener.port);
  process.exitCode = summary() ? 1 : 0;
})();
