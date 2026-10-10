// Sound effects in the real app, with a fake afplay (sound-player.js's play, in this main
// process): off by default, the Sound menu (and that it is saved), Test sound, the right
// sound for each Claude Code hook event and Claude desktop command, the bubble's pop and
// talk blips, volume, no sound while hidden or asleep, never the same sound over itself or
// more than 2 at once, and the real afplay (muted): exit 0, no focus, no Dock icon.
// Run: npx electron test/e2e/sound.e2e.js   (or npm test)
const {
  ROOT, t, check, section, wait, js, menuItem, waitFor, attempt, start, fs, path,
} = require('./lib.js');
const { app, BrowserWindow } = require('electron');
const { SOUNDS } = require(path.join(ROOT, 'renderer', 'sounds.js'));
const player = require(path.join(ROOT, 'sound-player.js'));

// The fake afplay: records each sound (main's clock) and "plays" for the sound's length.
const realPlay = player.play;
const recorded = [];
player.play = (name, volume) => {
  recorded.push([Date.now(), name, volume]);
  return new Promise((resolve) => setTimeout(() => resolve(0), SOUNDS[name] || 0));
};
const { layoutBubble, TIMING } = require(path.join(ROOT, 'bubble-layout.js'));

const json = (v) => JSON.stringify(v);
const all = []; // every sound played in the whole test: [ms, name, volume]
const soundMenu = () => menuItem('Sound').submenu;
const soundItem = (label) => soundMenu().items.find((i) => i.label === label);
const port = () => fs.readFileSync(path.join(process.env.HOME, '.terra-pet', 'port'), 'utf8').trim();
const post = (route, body) => fetch(`http://127.0.0.1:${port()}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const prefs = () => JSON.parse(fs.readFileSync(path.join(t.userData, 'preferences.json'), 'utf8'));

async function takeSounds() {
  const got = recorded.splice(0);
  all.push(...got);
  return got;
}

// Sends something, then collects the sounds of the next `ms`.
async function soundsOf(send, ms = 1200) {
  await takeSounds();
  await send();
  await wait(ms);
  return takeSounds();
}

const names = (list) => list.map((s) => s[1]);

start(async () => {
  // The fake player: records what the page asks for, plays nothing.
  menuItem('Patrol').click(); // keep the pet still while testing
  await waitFor('idle', 4000);

  section('off by default');
  {
    const labels = soundMenu().items.filter((i) => i.type !== 'separator').map((i) => `${i.label}${i.checked ? '*' : ''}${i.enabled ? '' : ' (off)'}`).join(', ');
    check('tray: Sound > Sound effects (off), Talk blips (on, greyed out), Volume Low, Test sound', labels === 'Sound effects, Talk blips* (off), Volume (off), Low*, Medium, High, Test sound', labels);
    const heard = await soundsOf(() => post('/mcp', { reaction: 'love' }), 2500);
    check('  a reaction with sound off: silence', heard.length === 0, json(heard));
    const test = await soundsOf(() => soundItem('Test sound').click(), 400);
    check('  Sound > Test sound: hi.wav at once, even with sound effects off', json(names(test)) === json(['hi']) && test[0][2] === 0.3, json(test));
  }

  section('turning it on (saved in preferences.json)');
  soundItem('Sound effects').click();
  await wait(200);
  check('Sound effects on, Talk blips now available', soundItem('Sound effects').checked && soundItem('Talk blips').enabled && prefs().soundEffects === true && prefs().talkBlips === true && prefs().volume === 'low',
    json({ soundEffects: prefs().soundEffects, talkBlips: prefs().talkBlips, volume: prefs().volume }));

  section('Claude Code hook events');
  for (const [label, body, want, settle] of [
    ['session start: wave', { event: 'session-start' }, 'hi', 'idle'],
    ['prompt: sits down', { event: 'prompt', prompt: 'please fix the build' }, 'sit', 'work'],
    ['needs you (notify): asks', { event: 'notify' }, 'ask', 'ask'],
    ['finishes (stop): stars', { event: 'stop' }, 'stars', 'idle'],
    ['API error: dizzy', { event: 'error' }, 'error', 'idle'],
  ]) {
    const heard = await soundsOf(() => post('/event', body), 1500);
    await waitFor(settle, 6000);
    check(`  ${label} -> ${want}`, names(heard)[0] === want && heard.every((s) => s[2] === 0.3), `${names(heard).join(', ') || 'silence'} at volume ${heard[0] && heard[0][2]}`);
  }

  section('Claude desktop tools');
  await waitFor('idle', 6000);
  for (const reaction of ['hi', 'love', 'angry', 'idea', 'stars', 'sad', 'ask']) {
    const heard = await soundsOf(() => post('/mcp', { reaction }), 1000);
    await waitFor('idle', 8000);
    check(`  terra_react("${reaction}") -> ${reaction}`, names(heard)[0] === reaction, names(heard).join(', ') || 'silence');
  }
  {
    const heard = await soundsOf(() => post('/mcp', { reaction: 'talk' }), 1000);
    await waitFor('idle', 8000);
    check('  terra_react("talk"): no sound (the bubble has its blips)', heard.length === 0, names(heard).join(', ') || 'silence');
  }
  for (const [label, body, want, settle] of [
    ['working: sits down', { state: 'working' }, 'sit', 'work'],
    ['waiting: asks', { state: 'waiting' }, 'ask', 'ask'],
    ['done, happy: stars', { state: 'done', mood: 'happy' }, 'stars', 'idle'],
    ['done, sad', { state: 'done', mood: 'sad' }, 'sad', 'idle'],
    ['done, angry', { state: 'done', mood: 'angry' }, 'angry', 'idle'],
    ['done, neutral: the short done sound', { state: 'done', mood: 'neutral' }, 'done', 'idle'],
  ]) {
    // A done waits for the asking before it to finish its cycle (the queue), so listen 3 s.
    const heard = await soundsOf(() => post('/mcp', body), 3000);
    await waitFor(settle, 8000);
    await wait(300);
    check(`  ${label} -> ${want}`, names(heard)[0] === want, names(heard).join(', ') || 'silence');
  }

  section('the speech bubble: pop, then talk blips while its text shows');
  const bubbleWin = BrowserWindow.getAllWindows().find((w) => w !== t.win && /bubble\.html$/.test(w.webContents.getURL()));
  const bubbleGone = async () => {
    for (let i = 0; i < 300 && bubbleWin.isVisible(); i++) await wait(50);
    await wait(400);
  };
  // Timing: retried if the page froze meanwhile (late timers bunch up, and the rule of 2
  // sounds at once then drops a blip).
  await attempt('  "Paris is the capital of France!": pop, then a blip every 2 or 3 characters while it is read', async () => {
    await waitFor('idle', 6000);
    const text = 'Paris is the capital of France!';
    const chars = layoutBubble(text).lines.join('').length; // 30
    await takeSounds();
    await post('/say', { text });
    await wait(300);
    await bubbleGone();
    const heard = await takeSounds();
    const [pop, ...rest] = heard;
    const blips = rest.filter((x) => /^talk-[1-4]$/.test(x[1]));
    const span = blips.length ? blips[blips.length - 1][0] - blips[0][0] : -1;
    const lastAt = blips.length ? blips[blips.length - 1][0] - pop[0] : -1;
    const reading = chars * TIMING.perCharMs;
    const ok = pop && pop[1] === 'pop' && blips.length >= Math.ceil(chars / 3) && blips.length <= Math.ceil(chars / 2) && blips.length === rest.length
      && span < reading && lastAt < TIMING.popMs + reading + 300 && blips.every((b, i) => i === 0 || b[1] !== blips[i - 1][1]);
    return { ok, line: `${pop && pop[1]}, ${blips.length} blips over ${span} ms (${chars} characters, read in ${reading} ms), the last ${lastAt} ms after the pop; ${[...new Set(blips.map((b) => b[1]))].join(' ')}` };
  });
  {
    // A click dismisses the bubble: the blips stop with it.
    await waitFor('idle', 8000);
    await takeSounds();
    await post('/say', { text: 'The quick brown fox jumps over the lazy dog' });
    await wait(400);
    const b = bubbleWin.getBounds();
    bubbleWin.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(b.width / 2), y: Math.round(b.height / 3) });
    bubbleWin.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(b.width / 2), y: Math.round(b.height / 3), button: 'left', clickCount: 1 });
    bubbleWin.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(b.width / 2), y: Math.round(b.height / 3), button: 'left', clickCount: 1 });
    const clickedAt = Date.now();
    await bubbleGone();
    await wait(1500);
    const heard = await takeSounds();
    const late = heard.filter((s) => /^talk/.test(s[1]) && s[0] > clickedAt + 50);
    check('  dismissed with a click: the blips stop', heard.some((s) => /^talk/.test(s[1])) && late.length === 0, `${heard.filter((s) => /^talk/.test(s[1])).length} blips before the click, ${late.length} after`);
  }
  {
    soundItem('Talk blips').click(); // off
    await waitFor('idle', 8000);
    const heard = await soundsOf(async () => { await post('/say', { text: 'Tokyo!' }); }, 800);
    await bubbleGone();
    check('  Talk blips off: the pop, no blips', json(names(heard)) === json(['pop']) && prefs().talkBlips === false, names(heard).join(', '));
    soundItem('Talk blips').click(); // on again
  }

  section('volume');
  for (const [label, want] of [['Medium', 0.6], ['High', 1], ['Low', 0.3]]) {
    soundItem(label).click();
    await wait(150);
    await waitFor('idle', 8000);
    const heard = await soundsOf(() => post('/mcp', { reaction: 'love' }), 800);
    check(`  ${label}: ${want}`, heard[0] && heard[0][2] === want && prefs().volume === label.toLowerCase(), `${heard[0] && heard[0][2]}, saved ${prefs().volume}`);
  }

  section('no sound while hidden or asleep');
  {
    await waitFor('idle', 8000);
    t.claudeRunning = false; // Claude desktop "quits"
    menuItem('Show Terra').submenu.items.find((i) => i.label === 'Only while Claude desktop is running').click();
    for (let i = 0; i < 160 && t.win.isVisible(); i++) await wait(50);
    const hidden = !t.win.isVisible();
    const heard = await soundsOf(async () => {
      await post('/event', { event: 'stop', reply: 'All done!' });
      await post('/mcp', { reaction: 'love' });
      await post('/event', { event: 'prompt', prompt: 'hello' });
    }, 2500);
    check('  hidden (Show Terra: only with Claude desktop, which is closed): silence', hidden && heard.length === 0, `window ${hidden ? 'hidden' : 'still shown'}; heard ${names(heard).join(', ') || 'nothing'}`);
    menuItem('Show Terra').submenu.items.find((i) => i.label === 'Always').click();
    for (let i = 0; i < 60 && !t.win.isVisible(); i++) await wait(50);
    await post('/event', { event: 'stop' });
    await waitFor('idle', 6000);
  }
  {
    await takeSounds();
    // Asleep, the page asks for sounds the way it always does; main.js must stay quiet.
    const asleep = await js("setState('sleep'); window.terra.soundCue('love'); window.terra.soundCue('pop'); state");
    await wait(400);
    const heard = await takeSounds();
    check('  asleep: silence', asleep === 'sleep' && heard.length === 0, `state ${asleep}, heard ${names(heard).join(', ') || 'nothing'}`);
    await js("setState('idle')");
  }

  section('the rules, over every sound of this test');
  {
    await takeSounds();
    const sorted = [...all].sort((a, b) => a[0] - b[0]);
    let selfOverlap = 0;
    let most = 0;
    for (const [at, name] of sorted) {
      const playing = sorted.filter(([t0, n]) => t0 <= at && t0 + SOUNDS[n] > at);
      most = Math.max(most, playing.length);
      if (playing.filter(([, n]) => n === name).length > 1) selfOverlap++;
    }
    check(`  never the same sound over itself, never more than 2 at once (${sorted.length} sounds)`, selfOverlap === 0 && most <= 2 && sorted.length >= 30, `at most ${most} at once, ${selfOverlap} overlapping themselves`);
  }

  section('the real afplay (muted: -v 0)');
  {
    const code = await realPlay('pop', 0);
    await wait(200);
    const dock = app.dock ? app.dock.isVisible() : false;
    check('  pop.wav: afplay starts and exits with 0, Terra not focused, no Dock icon', code === 0 && !dock && !t.win.isFocused() && BrowserWindow.getFocusedWindow() === null,
      `exit code ${code}, Dock icon ${dock}, focused window ${BrowserWindow.getFocusedWindow() ? 'yes' : 'none'}`);
  }
  {
    const logged = [];
    const realError = console.error;
    console.error = (...args) => {
      logged.push(args.join(' '));
      realError(...args);
    };
    const codes = await Promise.all([realPlay('no-such-sound', 0), realPlay('no-such-sound', 0)]);
    console.error = realError;
    const lines = logged.filter((l) => l.startsWith('Terra: a sound effect could not play'));
    check('  a file afplay cannot play: a non-zero exit, logged once (not twice)', codes.every((c) => c !== 0) && lines.length === 1, `exit codes ${codes.join(', ')}; logged: ${lines[0] || 'nothing'}`);
  }
});
