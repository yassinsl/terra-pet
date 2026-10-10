// Terra's voice in the real app, with a fake say process (voice.spawnSay, in this main
// process) and a fake afplay: off by default, the Voice menu and its saved choices, the
// bubble's text read as written and given on stdin only, the bubble staying until the
// voice has finished while the pet talks and the talk blips keep quiet, a new bubble
// stopping the voice, a click stopping it, silence while hidden, done's line read after
// its stars, and Test voice.
// Run: npx electron test/e2e/voice.e2e.js   (or npm test)
const { EventEmitter } = require('node:events');
const {
  ROOT, t, check, section, wait, js, menuItem, waitFor, start, BrowserWindow, fs, path,
} = require('./lib.js');
const { PROMPT_MARK } = require('../lib.js');
const voice = require(path.join(ROOT, 'voice.js'));
const player = require(path.join(ROOT, 'sound-player.js'));
const { SOUNDS } = require(path.join(ROOT, 'renderer', 'sounds.js'));
const { layoutBubble, TIMING } = require(path.join(ROOT, 'bubble-layout.js'));

const json = (v) => JSON.stringify(v);

// The fake say: records its arguments and what it is told on stdin, "speaks" for sayMs.
let sayMs = 1000;
const says = [];
voice.spawnSay = (args) => {
  const p = new EventEmitter();
  Object.assign(p, { args, input: '', killed: false, at: Date.now() });
  p.stdin = { on() {}, end(text) { p.input += text; } };
  const timer = setTimeout(() => p.emit('exit', 0), sayMs);
  p.kill = () => {
    clearTimeout(timer);
    p.killed = true;
    setImmediate(() => p.emit('exit', null));
  };
  says.push(p);
  return p;
};
// The fake afplay, to see the talk blips.
const sounds = [];
player.play = (name, volume) => {
  sounds.push([Date.now(), name, volume]);
  return new Promise((resolve) => setTimeout(() => resolve(0), SOUNDS[name] || 0));
};

const voiceMenu = () => menuItem('Voice').submenu;
const voiceItem = (label) => voiceMenu().items.find((i) => i.label === label);
const radios = (label) => voiceItem(label).submenu.items;
const port = () => fs.readFileSync(path.join(process.env.HOME, '.terra-pet', 'port'), 'utf8').trim();
const post = (route, body) => fetch(`http://127.0.0.1:${port()}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const prefs = () => JSON.parse(fs.readFileSync(path.join(t.userData, 'preferences.json'), 'utf8'));

start(async () => {
  const bubbleWin = BrowserWindow.getAllWindows().find((w) => w !== t.win && /bubble\.html$/.test(w.webContents.getURL()));
  const bubbleGone = async (ms = 20000) => {
    const end = Date.now() + ms;
    while (bubbleWin.isVisible() && Date.now() < end) await wait(25);
    return Date.now();
  };
  menuItem('Patrol').click(); // keep the pet still while testing
  await waitFor('idle', 4000);
  for (let i = 0; i < 40 && radios('Choose voice').length < 2; i++) await wait(100); // say lists the voices
  // The friendly default among the voices say lists here (the test's own HOME can see fewer).
  const friendly = voice.defaultVoice(await voice.listVoices());

  section('off by default');
  {
    const labels = voiceMenu().items.filter((i) => i.type !== 'separator').map((i) => `${i.label}${i.checked ? '*' : ''}`).join(', ');
    const chosen = radios('Choose voice').filter((i) => i.checked).map((i) => i.label);
    const speeds = radios('Speed').map((i) => `${i.label}${i.checked ? '*' : ''}`).join(' ');
    check('tray: Voice > Speak bubbles (off), Choose voice, Speed, Test voice', labels === 'Speak bubbles, Choose voice, Speed, Test voice' && speeds === 'Slow Normal* Fast', `${labels}; speed ${speeds}`);
    check(`  the English voices, a friendly one chosen (${friendly})`, radios('Choose voice').length > 1 && voice.FRIENDLY.includes(friendly) && chosen.join() === friendly, `${radios('Choose voice').length} voices, chosen ${chosen.join()}`);
    says.length = 0;
    await post('/say', { text: 'Tokyo!' });
    await wait(300);
    const shown = bubbleWin.isVisible();
    await bubbleGone();
    check('  a bubble with the voice off: shown, not said', shown && says.length === 0, `${says.length} say processes`);
  }

  section('Speak bubbles on: the text as written, on stdin');
  menuItem('Sound').submenu.items.find((i) => i.label === 'Sound effects').click(); // to hear the blips
  voiceItem('Speak bubbles').click();
  await wait(200);
  check('turned on and saved', voiceItem('Speak bubbles').checked && prefs().speakBubbles === true, json({ speakBubbles: prefs().speakBubbles }));
  {
    await waitFor('idle', 6000);
    says.length = 0;
    sounds.length = 0;
    sayMs = 8000; // longer than the bubble's own 5.5 s
    const text = `Paris is the capital of France! ${PROMPT_MARK}`;
    const t0 = Date.now();
    await post('/say', { text });
    await wait(1500);
    const [p] = says;
    const during = await js('state');
    const gone = (await bubbleGone()) - t0;
    const hold = TIMING.popMs + layoutBubble(text).holdMs + TIMING.fadeMs;
    const blips = sounds.filter((s) => /^talk/.test(s[1])).length;
    check(`  said once, in the chosen voice at normal speed: "-v ${friendly} -r 190 -f -", nothing else`, says.length === 1 && json(p.args) === json(['-v', friendly, '-r', '190', '-f', '-']), p && p.args.join(' '));
    check('  the text as written (not the bubble\'s capitals), on stdin only', p.input === text && !p.args.some((a) => a.includes('Paris')), json(p.input.replace(PROMPT_MARK, '<mark>')));
    check(`  the bubble stays until the voice has finished (${sayMs} ms, longer than its own ${hold} ms), the pet talking meanwhile`, gone >= sayMs && gone < sayMs + 1500 && during === 'talk', `gone after ${gone} ms; pet ${during}`);
    check('  no talk blips over the voice (the pop still plays)', blips === 0 && sounds.some((s) => s[1] === 'pop'), `${blips} blips; ${sounds.map((s) => s[1]).join(', ')}`);
  }

  section('stopping');
  {
    await waitFor('idle', 6000);
    says.length = 0;
    sayMs = 20000;
    await post('/say', { text: 'This is the first long answer' });
    await wait(1000);
    await post('/say', { text: 'And here is the second one' });
    await wait(500);
    const [a, b] = says;
    check('  a new bubble stops the voice first, then says its own', says.length === 2 && a.killed && !b.killed && b.input === 'And here is the second one', `${says.length} processes, first stopped ${a && a.killed}, second ${b && b.input}`);
    const bounds = bubbleWin.getBounds();
    const x = Math.round(bounds.width / 2);
    const y = Math.round(bounds.height / 3);
    bubbleWin.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    bubbleWin.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    bubbleWin.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    const t0 = Date.now();
    const gone = (await bubbleGone(3000)) - t0;
    await waitFor('idle', 3000);
    check('  a click on the bubble stops the voice too', b.killed && gone < 600 && (await js('state')) === 'idle', `stopped ${b.killed}, bubble gone after ${gone} ms, pet ${await js('state')}`);
  }

  section("done's line: the mood first, then the pet talks while it is said");
  {
    await waitFor('idle', 6000);
    says.length = 0;
    sayMs = 4000;
    const from = t.states.length;
    await post('/mcp', { state: 'working' });
    await post('/mcp', { state: 'done', mood: 'happy', say: 'Happy to help!' });
    await waitFor('idle', 15000, from + 5);
    await bubbleGone();
    await wait(300);
    const seen = t.states.slice(from).map((s) => s.state).filter((s, i, a) => i === 0 || s !== a[i - 1]).join(' ');
    check('  working, done(happy, "Happy to help!"): stars, then talk until the voice ends, then idle', says.length === 1 && says[0].input === 'Happy to help!' && /happy talk idle$/.test(seen), seen);
  }

  section('silence while hidden');
  {
    await waitFor('idle', 6000);
    says.length = 0;
    t.claudeRunning = false; // Claude desktop "quits"
    menuItem('Show Terra').submenu.items.find((i) => i.label === 'Only while Claude desktop is running').click();
    for (let i = 0; i < 160 && t.win.isVisible(); i++) await wait(50);
    await post('/say', { text: 'Nobody can see me' });
    await post('/event', { event: 'stop', reply: 'All done here.' });
    await wait(1500);
    check('  hidden: nothing said', !t.win.isVisible() && says.length === 0, `window ${t.win.isVisible() ? 'shown' : 'hidden'}, ${says.length} say processes`);
    menuItem('Show Terra').submenu.items.find((i) => i.label === 'Always').click();
    for (let i = 0; i < 60 && !t.win.isVisible(); i++) await wait(50);
    await waitFor('idle', 6000);
  }

  section('choices: voice, speed, Test voice (saved)');
  {
    says.length = 0;
    sayMs = 500;
    radios('Choose voice').find((i) => i.label === 'Daniel').click();
    radios('Speed').find((i) => i.label === 'Fast').click();
    voiceItem('Speak bubbles').click(); // off: Test voice still speaks
    await wait(200);
    voiceItem('Test voice').click();
    await wait(300);
    const [p] = says;
    const saved = prefs();
    check('  Test voice: "Hi! I\'m Terra." in Daniel, fast (-r 230), even with Speak bubbles off', says.length === 1 && p.input === "Hi! I'm Terra." && json(p.args) === json(['-v', 'Daniel', '-r', '230', '-f', '-']), p && `${p.args.join(' ')} <- ${p.input}`);
    check('  saved in preferences.json', saved.voiceName === 'Daniel' && saved.voiceRate === 'fast' && saved.speakBubbles === false, json({ voiceName: saved.voiceName, voiceRate: saved.voiceRate, speakBubbles: saved.speakBubbles }));
  }
});
