// listener.js on its own (no Electron): port choice, port file, accepted and rejected requests.
const { ROOT, check, section, summary, isolateHome, PROMPT_MARK } = require('../lib.js');

const home = isolateHome('listener');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startListener, removePortFile } = require(path.join(ROOT, 'listener.js'));

const PORT_FILE = path.join(home, '.terra-pet', 'port');
const events = [];
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
  const a = await startListener((e) => events.push(e));
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

  a.server.close();
  removePortFile(port);
  process.exitCode = summary() ? 1 : 0;
})();
