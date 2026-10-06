// "Show Terra": the three modes, with a fake "is Claude desktop running" (t.claudeRunning;
// the real app is never asked about). Also: hi when Claude opens, finishing the current
// animation before hiding, nothing idle running while hidden, hook events and MCP calls
// still handled while hidden, the tray staying put, and the choice being remembered.
// Run: npx electron test/e2e/visibility.e2e.js   (or npm test)

// The test moves the main process clock forward instead of waiting 10 minutes.
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

const { t, check, section, wait, js, menuItem, takeFrames, start, fs, path, ROOT } = require('./lib.js');
const { app } = require('electron');
const { spawn } = require('node:child_process');
const visibility = require(path.join(ROOT, 'visibility.js'));

fs.rmSync(t.prefsFile, { force: true }); // no choice made yet: the default mode
const loginCalls = [];
app.setLoginItemSettings = (s) => loginCalls.push(s); // must not be called by npm start anyway
const MIN = 60 * 1000;

const post = (route, body) => new Promise((resolve) => {
  const port = fs.readFileSync(path.join(process.env.HOME, '.terra-pet', 'port'), 'utf8').trim();
  const p = spawn('curl', ['-q', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--noproxy', '*', '--max-time', '2',
    '-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body), `http://127.0.0.1:${port}${route}`]);
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', () => resolve(out));
});
const shown = () => t.win.isVisible();
async function until(fn, timeout = 4000) {
  const end = realNow() + timeout;
  while (realNow() < end) {
    if (fn()) return true;
    await wait(25);
  }
  return fn();
}
const showMenu = () => menuItem('Show Terra').submenu.items;
const pick = (id) => showMenu().find((i) => i.label === visibility.MODES.find((m) => m.id === id).label).click();
const stateNames = (from) => t.states.slice(from).map((s) => s.state).filter((s, i, a) => i === 0 || s !== a[i - 1]);

start(async () => {
  section('the menu and the default');
  const labels = showMenu().map((i) => `${i.label}${i.checked ? ' *' : ''}`);
  check('Show Terra lists the three modes, the first checked', labels.join(' | ') === 'Only while Claude desktop is running * | While Claude desktop or a Claude Code session is active | Always', labels.join(' | '));
  check('Claude closed at start: window hidden, page running', !shown() && (await js('hidden')) === true && t.states.length > 0, `window ${shown() ? 'shown' : 'hidden'}, renderer hidden=${await js('hidden')}, state ${await js('state')}`);
  check('tray icon still in the menu bar', t.tray && !t.tray.isDestroyed(), t.tray ? 'Tray alive' : 'no Tray');
  check('npm start leaves login items alone', loginCalls.length === 0, `${loginCalls.length} calls`);

  section('while hidden');
  {
    await js("setState('idle')");
    await wait(200);
    await takeFrames();
    await js('nextPatrolAt = 0; nextBlinkAt = 0; sleepClock -= 6 * 60 * 1000;');
    await wait(1500);
    const rows = [...new Set((await takeFrames()).map((f) => f.row))];
    const s = await js('[state, walk === null]');
    check('  no patrol, blinking or sleeping', s[0] === 'idle' && s[1] && !rows.includes(8), `state ${s[0]}, walking ${!s[1]}, rows drawn ${rows.join(',')} (8 would be a blink)`);
    let from = t.states.length;
    const code = await post('/event', { event: 'tool' });
    await until(() => t.states.slice(from).some((x) => x.state === 'work'));
    check('  hook events still handled', code === '204' && stateNames(from).includes('work') && !shown(), `HTTP ${code}, ${stateNames(from).join(' -> ')}, window still ${shown() ? 'SHOWN' : 'hidden'}`);
    from = t.states.length;
    const mcp = await post('/mcp', { reaction: 'love' });
    await until(() => t.states.slice(from).some((x) => x.state === 'love'));
    check('  MCP tool calls still handled', mcp === '204' && stateNames(from).includes('love') && !shown(), `HTTP ${mcp}, ${stateNames(from).join(' -> ')}, window still ${shown() ? 'SHOWN' : 'hidden'}`);
    await post('/event', { event: 'stop' });
    await until(() => t.states[t.states.length - 1].state === 'idle', 5000);
  }

  section('mode 1: only while Claude desktop is running');
  {
    await takeFrames();
    const from = t.states.length;
    t.claudeRunning = true;
    const up = await until(shown);
    await wait(700);
    const emotes = [...new Set((await takeFrames()).filter((f) => f.emote).map((f) => f.emote.replace(/-\d+$/, '')))];
    check('  Claude opens: shown, says hi', up && stateNames(from).includes('wave') && emotes.includes('hi') && (await js('hidden')) === false,
      `window ${shown() ? 'shown' : 'hidden'}, ${stateNames(from).join(' -> ')}, emote ${emotes.join(',') || 'none'}`);
    await until(() => t.states[t.states.length - 1].state === 'idle', 4000);

    // Claude quits in the middle of a one-shot reaction: it plays to its end first.
    await js("playReaction('stars')"); // happy, 3 x 520 ms
    await wait(150);
    const quitAt = realNow();
    t.claudeRunning = false;
    await wait(500);
    const stillUp = shown();
    await until(() => !shown(), 4000);
    const hiddenAfter = realNow() - quitAt;
    check('  Claude quits mid-reaction: finishes it, then hides', stillUp && !shown() && hiddenAfter >= 1100 && hiddenAfter <= 2400,
      `still shown 0.5 s after quitting: ${stillUp}; hidden ${hiddenAfter} ms after (the reaction had ~1410 ms left)`);

    // Claude quits during the idle loop: hides at the end of the current cycle.
    t.claudeRunning = true;
    await until(shown);
    await until(() => t.states[t.states.length - 1].state === 'idle', 4000); // past the hi
    await js("setState('idle')");
    await wait(100);
    const quit2 = realNow();
    t.claudeRunning = false;
    await until(() => !shown(), 4000);
    const cycle = realNow() - quit2;
    check('  Claude quits during idle: hides at the end of the cycle', !shown() && cycle <= 1300, `hidden ${cycle} ms after (one idle cycle is 720 ms, plus up to 200 ms to notice)`);
  }

  section('mode 2: Claude desktop or a Claude Code session');
  {
    clockOffset += 11 * MIN; // the hook events sent while hidden were a session too; let it run out
    pick('claude-or-code');
    await wait(400);
    check('  picked; still hidden with no session', !shown() && showMenu()[1].checked, `window ${shown() ? 'shown' : 'hidden'}`);
    const from = t.states.length;
    await takeFrames();
    await post('/event', { event: 'session-start' }); // plays a plain wave, no emote
    const up = await until(shown);
    await wait(800);
    const emotes = [...new Set((await takeFrames()).filter((f) => f.emote).map((f) => f.emote.replace(/-\d+$/, '')))];
    check('  a hook event shows Terra (no hi: Claude desktop didn\'t open)', up && !emotes.includes('hi'),
      `window ${shown() ? 'shown' : 'hidden'}, ${stateNames(from).join(' -> ')}, emote ${emotes.join(',') || 'none'}`);
    await until(() => t.states[t.states.length - 1].state === 'idle', 4000);
    clockOffset += 9 * MIN;
    await wait(500);
    const at9 = shown();
    await post('/event', { event: 'tool' }); // another event at 9 minutes: the session runs on
    await post('/event', { event: 'stop' });
    clockOffset += 9.5 * MIN; // 18.5 minutes in, 9.5 since the last event
    await wait(500);
    const at18 = shown();
    clockOffset += 1 * MIN; // 10.5 minutes since the last event
    await until(() => !shown(), 6000);
    check('  session lasts until 10 min after its last event', at9 && at18 && !shown(), `9 min: ${at9 ? 'shown' : 'hidden'}; 9.5 min after the last event: ${at18 ? 'shown' : 'hidden'}; 10.5 min after: ${shown() ? 'shown' : 'hidden'}`);
    const from2 = t.states.length;
    t.claudeRunning = true;
    const up2 = await until(shown);
    await wait(500);
    check('  Claude desktop opening shows it too, with hi', up2 && stateNames(from2).includes('wave'), stateNames(from2).join(' -> '));
    t.claudeRunning = false;
    await until(() => !shown(), 4000);
  }

  section('mode 3: always');
  {
    pick('always');
    const up = await until(shown);
    t.claudeRunning = true;
    await wait(500);
    t.claudeRunning = false;
    await wait(1500);
    check('  shown, and stays shown when Claude quits', up && shown(), `window ${shown() ? 'shown' : 'hidden'}`);
    await js('nextBlinkAt = 0');
    await wait(400);
    check('  idle behaviour back on while shown', (await js('hidden')) === false, `renderer hidden=${await js('hidden')}`);
  }

  section('remembered');
  {
    const saved = JSON.parse(fs.readFileSync(t.prefsFile, 'utf8'));
    check('the choice is in preferences.json', saved.showWhen === 'always', JSON.stringify(saved));
    pick('claude');
    check('and changes with the menu', JSON.parse(fs.readFileSync(t.prefsFile, 'utf8')).showWhen === 'claude');
  }
});
