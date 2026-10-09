// hooks/terra-hook.sh against the real listener (no Electron), fed hook JSON shaped
// like the examples in the Claude Code hooks docs.
const { ROOT, check, section, summary, wait, isolateHome, PROMPT_MARK } = require('../lib.js');

const home = isolateHome('hook');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startListener, removePortFile } = require(path.join(ROOT, 'listener.js'));

const HOOK = path.join(ROOT, 'hooks', 'terra-hook.sh');
const PORT_FILE = path.join(home, '.terra-pet', 'port');
const received = [];
const runs = [];

function hook(arg, input) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('/bin/sh', arg ? [HOOK, arg] : [HOOK], { env: { ...process.env, HOME: home } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      const run = { code, out, err, ms: Date.now() - t0 };
      runs.push(run);
      resolve(run);
    });
    p.stdin.on('error', () => {});
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

const base = { session_id: 'abc123', transcript_path: '/Users/me/.claude/projects/x/abc123.jsonl', cwd: '/Users/me/project' };
const S = {
  prompt: (prompt) => ({ ...base, permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt }),
  tool: { ...base, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run test suite', timeout: 120000, run_in_background: false }, tool_use_id: 'toolu_01ABC123' },
  notify: { ...base, hook_event_name: 'Notification', message: 'Claude needs your permission', title: 'Permission needed', notification_type: 'permission_prompt' },
  stop: { ...base, permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: `Done ${PROMPT_MARK}`, background_tasks: [], session_crons: [] },
  start: { ...base, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' },
  stopFailure: { ...base, hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: 'API Error: Rate limit reached' },
  toolFailure: { ...base, permission_mode: 'default', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_01ABC123', error: 'Exit code 1', is_interrupt: false },
};

// Runs the hook and returns what the listener received (as JSON, prompt marker masked).
async function sent(arg, input) {
  received.length = 0;
  const run = await hook(arg, input);
  await wait(50);
  return { run, got: received.map((e) => JSON.stringify(e).replace(PROMPT_MARK, '<mark>')).join(' ') || '(nothing)' };
}

(async () => {
  const listener = await startListener((e) => received.push(e));

  section('hook -> listener, with the event as argument (as installed)');
  const cases = [
    ['prompt', S.prompt(`hello Terra "quoted"\nline 2 é 🙂 ${PROMPT_MARK}`), `{"event":"prompt","prompt":"hello Terra \\"quoted\\"\\nline 2 é 🙂 <mark>"}`],
    ['tool', S.tool, '{"event":"tool"}'],
    ['notify', S.notify, '{"event":"notify"}'],
    ['stop', S.stop, '{"event":"stop","reply":"Done <mark>"}'],
    ['session-start', S.start, '{"event":"session-start"}'],
    ['error', S.stopFailure, '{"event":"error"}'],
  ];
  for (const [arg, input, want] of cases) {
    const { got } = await sent(arg, input);
    check(`  ${arg}`, got === want, got);
  }

  section('hook works out the event from hook_event_name when no argument');
  const detect = [
    [S.prompt(`thanks ${PROMPT_MARK}`), `{"event":"prompt","prompt":"thanks <mark>"}`],
    [S.tool, '{"event":"tool"}'], [S.notify, '{"event":"notify"}'], [S.stop, '{"event":"stop","reply":"Done <mark>"}'],
    [S.start, '{"event":"session-start"}'], [S.stopFailure, '{"event":"error"}'], [S.toolFailure, '{"event":"error"}'],
  ];
  for (const [input, want] of detect) {
    const { got } = await sent(null, input);
    check(`  ${input.hook_event_name}`, got === want, got);
  }

  section('prompt edge cases');
  let r = await sent('prompt', S.prompt(`<pasted_content id="p1">\nhi hello hey\n</pasted_content id="p1">\nreview this ${PROMPT_MARK}`));
  check('  pasted blocks are left out', r.got === `{"event":"prompt","prompt":" \\nreview this <mark>"}`, r.got);
  r = await sent('prompt', S.prompt(`hello ${PROMPT_MARK} ${'y'.repeat(20000)}`));
  check('  20,000 chars: sent without the text', r.got === '{"event":"prompt"}', r.got);
  r = await sent('prompt', 'this is not json');
  check('  stdin not JSON: still sends the event', r.got === '{"event":"prompt"}', r.got);
  section('stop: Claude\'s reply for the speech bubble (last_assistant_message)');
  r = await sent('stop', { ...S.stop, last_assistant_message: `\`\`\`js\nconst a = "q";\n\`\`\`\nAll done! ${PROMPT_MARK} ${'z'.repeat(5000)}` });
  const reply = JSON.parse(r.got.replace('<mark>', PROMPT_MARK)).reply || '';
  check('  sent as it is, cut to 4,000 characters (the pet takes the first sentence)', reply.length === 4000 && reply.startsWith('```js\nconst a = "q";') && reply.includes(PROMPT_MARK), `${reply.length} characters`);
  r = await sent('stop', { ...S.stop, last_assistant_message: '' });
  check('  empty reply: the event alone', r.got === '{"event":"stop"}', r.got);
  r = await sent('stop', { ...S.stop, last_assistant_message: undefined });
  check('  no last_assistant_message (older Claude Code): the event alone', r.got === '{"event":"stop"}', r.got);
  r = await sent('stop', { ...S.stop, last_assistant_message: { text: 'odd' } });
  check('  not a string: the event alone', r.got === '{"event":"stop"}', r.got);
  r = await sent('bogus', S.tool);
  check('  unknown argument: sends nothing', r.got === '(nothing)', r.got);

  const quiet = runs.every((x) => x.code === 0 && x.out === '' && x.err === '');
  const ms = runs.map((x) => x.ms).sort((a, b) => a - b);
  check('every run: exit 0, no output, under 1 s', quiet && ms[ms.length - 1] < 1000,
    `${runs.length} runs, slowest ${ms[ms.length - 1]} ms, median ${ms[ms.length >> 1]} ms`);

  section('pet not running or stuck (must exit 0 quickly and quietly)');
  listener.server.close();
  removePortFile(listener.port);
  const expectQuick = async (label, maxMs) => {
    const x = await hook('prompt', S.prompt('hello'));
    check(`  ${label}`, x.code === 0 && x.out === '' && x.err === '' && x.ms < maxMs, `exit ${x.code}, ${x.ms} ms`);
  };
  await expectQuick('no port file', 300);
  fs.writeFileSync(PORT_FILE, '47809\n');
  await expectQuick('stale port file (nothing listening)', 300);
  fs.writeFileSync(PORT_FILE, 'not-a-port\n');
  await expectQuick('garbage in port file', 300);
  const hang = net.createServer(() => {}); // accepts, never answers
  await new Promise((res) => hang.listen(0, '127.0.0.1', res));
  fs.writeFileSync(PORT_FILE, `${hang.address().port}\n`);
  const x = await hook('prompt', S.prompt('hello'));
  check('  listener never answers: gives up at ~1 s', x.code === 0 && x.out === '' && x.ms >= 900 && x.ms < 1500, `exit ${x.code}, ${x.ms} ms`);
  hang.close();
  fs.rmSync(PORT_FILE, { force: true });

  process.exitCode = summary() ? 1 : 0;
})();
