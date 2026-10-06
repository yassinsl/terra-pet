// Claude Code events end to end: curl and the hook script -> listener -> pet states and
// emotes, the 10-minute safety timeout, and "Back to idle".
// Run: npx electron test/e2e/events.e2e.js   (or npm test)

// The test moves the main process clock forward instead of waiting 10 minutes,
// and grabs the periodic stuck check so it can run it right away.
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const intervals = [];
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms, ...args) => {
  intervals.push({ fn, ms });
  return realSetInterval(fn, ms, ...args);
};

const {
  ROOT, t, check, section, wait, js, current, menuItem, subItem, takeFrames, waitFor, compress, attempt, start, fs, path,
} = require('./lib.js');
const { PROMPT_MARK } = require('../lib.js');
const { spawn } = require('node:child_process');

const MIN = 60 * 1000;
let PORT;

function run(cmd, args, input) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.on('error', () => {});
    p.stdin.end(input === undefined ? '' : input);
  });
}
const post = (body) => run('curl', ['-q', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--noproxy', '*', '--max-time', '2',
  '-H', 'Content-Type: application/json', '--data-binary', '@-', `http://127.0.0.1:${PORT}/event`], JSON.stringify(body)).then((r) => r.out);
// Resolves to undefined when the hook exits 0 (as step() expects), else to a message.
const hook = (arg, input) => run('/bin/sh', arg ? [path.join(ROOT, 'hooks', 'terra-hook.sh'), arg] : [path.join(ROOT, 'hooks', 'terra-hook.sh')], JSON.stringify(input))
  .then((r) => (r.code === 0 && r.out === '' ? undefined : `hook exit ${r.code}, output ${r.out.length} bytes`));
const promptEvent = (text) => ({ event: 'prompt', prompt: `${text} ${PROMPT_MARK}` });

// Sends something, waits for the pet to settle, and checks the states and emotes seen.
async function step(label, send, want, emotes, settle) {
  const from = t.states.length;
  await takeFrames();
  const startRow = await js('clip && clip.row');
  const status = await send();
  if (settle) await waitFor(settle, 8000);
  await wait(settle ? 250 : 600);
  const seen = compress(t.states.slice(from));
  // Emotes drawn after the pet changed state (the old one shows until the event lands).
  const frames = await takeFrames();
  const changed = frames.findIndex((f) => f.row !== startRow);
  const after = want.length && changed >= 0 ? frames.slice(changed) : frames;
  const shown = [...new Set(after.filter((f) => f.emote).map((f) => f.emote.replace(/-\d+$/, '')))];
  const httpOk = status === undefined || status === '204';
  const ok = httpOk && seen.join(' ') === want.join(' ') && shown.join(' ') === emotes.join(' ');
  if (!ok) {
    console.log('DEBUG renderer:', JSON.stringify(await js('({ state, row: clip && clip.row, step, stepTime, playsDone, plays: clip && clip.plays, hasEnd: !!onClipEnd, emote: emote && { name: emote.name, step: emote.step, stepTime: emote.stepTime }, afterEmote, sinceLastTick: performance.now() - lastTick, pending, visibility: document.visibilityState, visibilityChanges: window.__visibility, msSinceLastFrame: Math.round(performance.now() - window.__lastFrame), stalls: window.__stalls.slice(-8).map(Math.round) })')));
    console.log('DEBUG frames in 1 s:', await js('new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); })'),
      '| window visible:', t.win.isVisible(), 'occluded-ish? focused:', t.win.isFocused(), 'bounds:', JSON.stringify(t.win.getBounds()));
  }
  check(label, ok, `${status ? `HTTP ${status}, ` : ''}${seen.join(' -> ') || '(no change)'}${shown.length ? `, emote ${shown.join(', ')}` : ''}${ok ? '' : `   want: ${want.join(' -> ') || '(no change)'}${emotes.length ? `, emote ${emotes.join(', ')}` : ''}`}`);
}

async function pausedIn(state) {
  await js('sleepClock -= 6 * 60 * 1000; nextPatrolAt = 0; nextBlinkAt = 0;');
  await wait(1000);
  const s = await js('[state, walk === null, routePending]');
  check(`  patrol + sleep paused in ${state}`, s[0] === state && s[1] && !s[2], `after forcing both timers due: still ${s[0]}`);
}

start(async () => {
  PORT = Number(fs.readFileSync(path.join(process.env.HOME, '.terra-pet', 'port'), 'utf8').trim());
  const status = t.trayMenu.items[0];
  check('tray status line', status.label === `Listening on 127.0.0.1:${PORT}` && !status.enabled, `"${status.label}"`);
  menuItem('Patrol').click(); // keep the pet still while testing
  await waitFor('idle', 4000);

  section('events over curl');
  await step('session-start', () => post({ event: 'session-start' }), ['wave', 'idle'], [], 'idle');
  await step('prompt "hi, please fix the build"', () => post(promptEvent('hi, please fix the build')), ['wave', 'sitDown', 'work'], ['hi'], 'work');
  await step('tool while in work (no change)', () => post({ event: 'tool' }), [], []);
  await pausedIn('work');
  await step('prompt without keyword while working', () => post(promptEvent('fix the failing tests')), ['standUp', 'sitDown', 'work'], [], 'work');
  await step('notify -> ask', () => post({ event: 'notify' }), ['standUp', 'ask'], ['ask'], 'ask');
  await pausedIn('ask');
  await step('tool from ask', () => post({ event: 'tool' }), ['sitDown', 'work'], [], 'work');
  await step('stop -> stars', () => post({ event: 'stop' }), ['standUp', 'happy', 'idle'], ['stars'], 'idle');
  await step('error -> dizzy, no emote', () => post({ event: 'error' }), ['dizzy', 'idle'], [], 'idle');
  await step('prompt "Thanks so much"', () => post(promptEvent('Thanks so much')), ['love', 'sitDown', 'work'], ['love'], 'work');
  await step('prompt "I have an idea" (from work)', () => post(promptEvent('I have an idea')), ['standUp', 'idea', 'sitDown', 'work'], ['idea'], 'work');
  await step('prompt "wtf, broken again" (from work)', () => post(promptEvent('wtf, BROKEN again')), ['standUp', 'angry', 'sitDown', 'work'], ['angry'], 'work');
  await step('stop', () => post({ event: 'stop' }), ['standUp', 'happy', 'idle'], ['stars'], 'idle');
  await attempt('tool during a prompt reaction waits for it', async () => {
    await post({ event: 'stop' });
    await waitFor('idle', 4000);
    const from = t.states.length;
    await post(promptEvent('hello there'));
    await wait(300);
    await post({ event: 'tool' }); // Claude starts a tool while the hi reaction plays
    await waitFor('work', 6000);
    const seen = t.states.slice(from);
    const waveAt = seen.find((s) => s.state === 'wave')?.t;
    const sitAt = seen.find((s) => s.state === 'sitDown')?.t;
    return { ok: compress(seen).join(' ') === 'wave sitDown work' && sitAt - waveAt >= 1880, line: `${compress(seen).join(' -> ')}; wave lasted ${sitAt - waveAt} ms (full wave 1920 ms)` };
  });
  await attempt('idea: pet waits for the longer emote', async () => {
    await post({ event: 'stop' });
    await waitFor('idle', 4000);
    const from = t.states.length;
    await post(promptEvent('a new idea'));
    await waitFor('work', 8000);
    const seen = t.states.slice(from);
    const ideaAt = seen.find((s) => s.state === 'idea')?.t;
    const sitAt = seen.find((s) => s.state === 'sitDown')?.t;
    return { ok: Math.abs(sitAt - ideaAt - 1580) < 80, line: `idea lasted ${sitAt - ideaAt} ms (pet animation 720 ms, emote 1580 ms)` };
  });

  section('hook script -> running app');
  const base = { session_id: 'abc123', transcript_path: '/Users/me/.claude/projects/x/abc123.jsonl', cwd: ROOT };
  await step('hook stop', () => hook('stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done' }), ['standUp', 'happy', 'idle'], ['stars'], 'idle');
  await step('hook prompt "hello"', () => hook('prompt', { ...base, permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: `hello Terra ${PROMPT_MARK}` }), ['wave', 'sitDown', 'work'], ['hi'], 'work');
  const failure = { ...base, hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: 'API Error: Rate limit reached' };
  await step('hook error (StopFailure, as installed)', () => hook('error', failure), ['standUp', 'dizzy', 'idle'], [], 'idle');
  await step('hook StopFailure, no argument', () => hook(null, failure), ['dizzy', 'idle'], [], 'idle');
  await step('hook notify', () => hook('notify', { ...base, hook_event_name: 'Notification', message: 'Claude needs your permission', notification_type: 'permission_prompt' }), ['ask'], ['ask'], 'ask');

  section('Back to idle (tray)');
  await step('from ask: emote removed', () => menuItem('Back to idle').click(), ['idle'], [], 'idle');
  await attempt('from work: stands up first', async () => {
    await post({ event: 'tool' });
    const inWork = await waitFor('work', 5000);
    const from = t.states.length;
    menuItem('Back to idle').click();
    await waitFor('idle', 3000);
    const seen = compress(t.states.slice(from));
    return { ok: inWork && seen.join(' ') === 'standUp idle', line: `${inWork ? 'work' : `still ${current()}`} -> ${seen.join(' -> ')}` };
  });
  subItem('Play animation', 'sleep').click();
  await waitFor('sleep', 1000);
  await step('from sleep', () => menuItem('Back to idle').click(), ['idle'], [], 'idle');

  section('safety timeout: 10 min with no event (test moves the clock)');
  const checks = intervals.filter((i) => i.ms === 15000);
  check('stuck check runs every 15 s', checks.length === 1, `${checks.length} interval(s) of 15 s`);
  const runCheck = () => checks[0].fn();
  const goIdle = async (label, enter, state) => {
    await enter();
    await waitFor(state, 3000);
    await wait(100);
    clockOffset += 10 * MIN - 30 * 1000;
    runCheck();
    await wait(400);
    const before = current();
    clockOffset += 31 * 1000;
    const from = t.states.length;
    runCheck();
    await waitFor('idle', 3000);
    await wait(100);
    const seen = compress(t.states.slice(from));
    check(`  ${label}`, before === state && current() === 'idle', `at 9:30 still ${before}; at 10:01 -> ${seen.join(' -> ')}`);
  };
  await goIdle('work -> idle (stands up)', () => post({ event: 'tool' }), 'work');
  await goIdle('ask -> idle', () => post({ event: 'notify' }), 'ask');
  await goIdle('wait (tray) -> idle', () => subItem('Play animation', 'wait').click(), 'wait');
  await goIdle('think (tray) -> idle', () => subItem('Play animation', 'think').click(), 'think');
  {
    await post({ event: 'tool' });
    await waitFor('work', 3000);
    clockOffset += 9 * MIN;
    runCheck();
    await wait(200);
    await post({ event: 'tool' }); // any event resets the timer
    clockOffset += 9 * MIN;
    runCheck();
    await wait(400);
    const at18 = current();
    clockOffset += 61 * 1000;
    runCheck();
    await waitFor('idle', 3000);
    check('  an event resets the timer', at18 === 'work' && current() === 'idle', `event at 9 min; at 18 min still ${at18}; at 19:01 ${current()}`);
  }
  {
    subItem('Play animation', 'talk').click();
    await waitFor('talk', 1000);
    clockOffset += 11 * MIN;
    runCheck();
    await wait(400);
    check('  talk is left alone', current() === 'talk', `after 11 min: ${current()}`);
  }
  {
    subItem('Play animation', 'idle').click();
    await waitFor('idle', 1000);
    clockOffset += 30 * MIN; // a long quiet spell...
    subItem('Play animation', 'think').click(); // ...then think from the tray
    await waitFor('think', 1000);
    runCheck();
    await wait(400);
    check("  entering after a quiet spell doesn't bounce", current() === 'think', `30 min without events, then think: still ${current()}`);
    subItem('Play animation', 'idle').click();
  }
});
