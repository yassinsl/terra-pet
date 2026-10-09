// The Claude desktop app's side, end to end: the real MCP server (started the way the
// config written by mcp:install starts it) -> listener -> the running pet. Every tool and
// name, reactions while working, calls close together (the queue), how "done" ends (its
// mood, or the reaction before it), and the tray's Claude desktop items on a temp config.
// Run: npx electron test/e2e/mcp.e2e.js   (or npm test)
const {
  ROOT, EMOTES, t, check, section, wait, js, menuItem, clipMs, takeFrames, waitFor, compress, attempt, step, start, fs, path,
} = require('./lib.js');
const { app, dialog } = require('electron');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const mcp = require(path.join(ROOT, 'mcp-installer.js'));

// The tray's install items show a dialog and bring Terra to the front; record instead.
const dialogs = [];
dialog.showMessageBox = async (options) => {
  dialogs.push(options);
  return { response: 0 };
};
app.focus = () => {};

let client;
// Resolves to undefined when the tool went through (as step() expects), else to its text.
async function tool(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join(' ');
  return r.isError || /isn't running|too old/.test(text) ? `tool said: ${text}` : undefined;
}
const react = (reaction) => () => tool('terra_react', { reaction });
const setState = (state, mood) => () => tool('terra_state', mood ? { state, mood } : { state });

// Calls the tools one after another as fast as they go, the way Claude does in a burst:
// 'state:working', 'state:done:happy' (with a mood) or a reaction name.
// Resolves to how long sending them all took (ms), or to what went wrong.
async function burst(...calls) {
  const t0 = Date.now();
  for (const call of calls) {
    const [, state, mood] = call.split(':');
    const [name, args] = call.startsWith('state:') ? ['terra_state', mood ? { state, mood } : { state }] : ['terra_react', { reaction: call }];
    const r = await tool(name, args);
    if (r) return r;
  }
  return Date.now() - t0;
}

// The states reported since `from`, repeats merged, each with how long it lasted (ms).
function timeline(from) {
  const list = t.states.slice(from).filter((s, i, a) => i === 0 || s.state !== a[i - 1].state);
  return list.map((s, i) => ({ state: s.state, ms: (list[i + 1] ? list[i + 1].t : Date.now()) - s.t }));
}
const showTimeline = (tl) => tl.map((s) => `${s.state} ${s.ms}`).join(' -> ');
// Emotes drawn since the last takeFrames(), in order, repeats merged.
const emotesDrawn = async () => (await takeFrames()).filter((f) => f.emote).map((f) => f.emote.replace(/-\d+$/, ''))
  .filter((e, i, a) => i === 0 || e !== a[i - 1]);

// A Claude Code hook event, the way the hook script sends it.
async function hookEvent(body) {
  const port = fs.readFileSync(path.join(process.env.HOME, '.terra-pet', 'port'), 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${port}/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return String(r.status);
}

start(async () => {
  const entry = mcp.terraEntry(); // Electron in Node mode, this repo's mcp/terra-mcp.js
  client = new Client({ name: 'terra-e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...entry.env, HOME: process.env.HOME } }));
  menuItem('Patrol').click(); // keep the pet still while testing
  await waitFor('idle', 4000);

  section('terra_state on the running pet');
  await step('working', setState('working'), ['sitDown', 'work'], [], 'work');
  await step('working again (no change)', setState('working'), [], []);
  await step('waiting -> ask', setState('waiting'), ['standUp', 'ask'], ['ask'], 'ask');
  await step('working from waiting', setState('working'), ['sitDown', 'work'], [], 'work');
  await step('done, no mood, no reaction: stands up, no stars', setState('done'), ['standUp', 'idle'], [], 'idle');
  await step('working', setState('working'), ['sitDown', 'work'], [], 'work');
  await step('idle: stands up', setState('idle'), ['standUp', 'idle'], [], 'idle');
  await step('waiting from idle', setState('waiting'), ['ask'], ['ask'], 'ask');
  await step('idle from waiting: emote removed', setState('idle'), ['idle'], [], 'idle');
  await step('done from idle, no mood: stays idle', setState('done'), ['idle'], [], 'idle');
  await step('done from idle, mood happy: stars', setState('done', 'happy'), ['happy', 'idle'], ['stars'], 'idle');

  section('terra_react on the running pet (from idle)');
  const anims = { hi: 'wave', love: 'love', angry: 'angry', idea: 'idea', stars: 'happy' };
  for (const [reaction, anim] of Object.entries(anims)) {
    await step(reaction, react(reaction), [anim, 'idle'], [reaction], 'idle');
  }
  for (const reaction of ['talk', 'sad', 'ask']) {
    const from = t.states.length;
    await step(`${reaction} (loops 4 s, then to the end of its cycle)`, react(reaction), [reaction, 'idle'], [reaction], 'idle');
    const seen = t.states.slice(from);
    const ms = seen.find((s) => s.state === 'idle')?.t - seen.find((s) => s.state === reaction)?.t;
    const cycle = clipMs(EMOTES[reaction]).reduce((a, b) => a + b, 0);
    const want = Math.ceil(4000 / cycle) * cycle;
    check(`  ${reaction} lasted ${want} ms (whole ${cycle} ms emote cycles, 4 s at least)`, Math.abs(ms - want) < 150, `${ms} ms`);
  }

  section('terra_react while working: back to work after');
  await step('working', setState('working'), ['sitDown', 'work'], [], 'work');
  await step('love while working', react('love'), ['standUp', 'love', 'sitDown', 'work'], ['love'], 'work');
  await step('talk while working (loop)', react('talk'), ['standUp', 'talk', 'sitDown', 'work'], ['talk'], 'work');
  {
    // A command waiting behind a looping reaction starts at the end of a cycle once the
    // reaction has shown 1.5 s, and the 4 s it would have looped alone no longer apply.
    const from = t.states.length;
    await tool('terra_react', { reaction: 'sad' });
    await waitFor('sad', 3000, from);
    await tool('terra_state', { state: 'waiting' });
    await waitFor('ask', 4000, from);
    await wait(4500);
    const tl = timeline(from);
    const sad = tl.find((s) => s.state === 'sad');
    check('state after a loop reaction is kept', tl.map((s) => s.state).join(' ') === 'standUp sad ask' && sad.ms >= 1500, showTimeline(tl));
  }
  await step('done after sad: no stars, just idle', setState('done'), ['idle'], [], 'idle');

  section('calls close together play in order (queue)');
  await attempt('working, sad, done within 100 ms: sad 1.5 s+, then idle, no stars', async () => {
    await waitFor('idle', 6000);
    await wait(300);
    await takeFrames();
    const from = t.states.length;
    const sent = await burst('state:working', 'sad', 'state:done');
    await waitFor('idle', 12000, from);
    await wait(400);
    const tl = timeline(from);
    const emotes = await emotesDrawn();
    const sad = tl.find((s) => s.state === 'sad');
    const ok = typeof sent === 'number' && sent < 100 && tl.map((s) => s.state).join(' ') === 'sitDown work standUp sad idle'
      && sad.ms >= 1500 && emotes.join(' ') === 'sad';
    return { ok, line: `sent in ${sent} ms; ${showTimeline(tl)} ms; emotes ${emotes.join(', ') || 'none'}` };
  });
  await attempt('working, love, done: love to its end, then stars', async () => {
    await waitFor('idle', 6000);
    await wait(300);
    await takeFrames();
    const from = t.states.length;
    const sent = await burst('state:working', 'love', 'state:done');
    await waitFor('idle', 12000, from);
    await wait(400);
    const tl = timeline(from);
    const emotes = await emotesDrawn();
    const love = tl.find((s) => s.state === 'love');
    const ok = typeof sent === 'number' && sent < 100 && tl.map((s) => s.state).join(' ') === 'sitDown work standUp love happy idle'
      && love.ms >= 1500 && emotes.join(' ') === 'love stars';
    return { ok, line: `sent in ${sent} ms; ${showTimeline(tl)} ms; emotes ${emotes.join(', ')}` };
  });
  await attempt('7 reactions at once: 5 wait, the oldest waiting one dropped, the playing one kept', async () => {
    await waitFor('idle', 6000);
    await wait(300);
    await takeFrames();
    const from = t.states.length;
    const sent = await burst('hi', 'love', 'angry', 'idea', 'talk', 'ask', 'sad');
    const right = await js("[playing && playing.name, queue.map((c) => c.reaction || c.state).join(' ')]");
    await waitFor('idle', 25000, from + 1);
    await wait(400);
    const tl = timeline(from);
    const emotes = await emotesDrawn();
    const wave = tl.find((s) => s.state === 'wave');
    const ok = typeof sent === 'number' && right[0] === 'hi' && right[1] === 'angry idea talk ask sad'
      && tl.map((s) => s.state).join(' ') === 'wave angry idea talk ask sad idle' && wave.ms >= 1900 && emotes.join(' ') === 'hi angry idea talk ask sad';
    return { ok, line: `sent in ${sent} ms; then playing ${right[0]}, waiting: ${right[1]}; ${showTimeline(tl)} ms; emotes ${emotes.join(', ')}` };
  });
  await attempt('a Claude Code hook still acts at once; the queue waits for it', async () => {
    await waitFor('idle', 6000);
    await wait(300);
    const from = t.states.length;
    await burst('state:working', 'sad', 'state:done');
    await waitFor('sad', 4000, from);
    await wait(300);
    const at = Date.now();
    const status = await hookEvent({ event: 'stop' }); // stars, then idle
    await waitFor('happy', 1000, from);
    const after = Date.now() - at;
    await waitFor('idle', 6000, from);
    await wait(2500); // the queued "done" (after sad: just idle) has come and gone
    const tl = timeline(from);
    const ok = status === '204' && after < 300 && tl.map((s) => s.state).join(' ') === 'sitDown work standUp sad happy idle' && (await js('queue.length + (playing ? 1 : 0)')) === 0;
    return { ok, line: `hook HTTP ${status}, stars ${after} ms after it; ${showTimeline(tl)} ms` };
  });

  section('"done" with a mood (after working, no reaction)');
  const moods = [
    ['happy', 'stars', 'standUp happy idle', ['stars'], 'happy'],
    ['sad', 'looks sad 1.5 s+, no stars', 'standUp sad idle', ['sad'], 'sad'],
    ['angry', 'looks angry, no stars', 'standUp angry idle', ['angry'], 'angry'],
    ['neutral', 'stands up and idles, no emote', 'standUp idle', [], null],
    [null, 'no mood: same as neutral', 'standUp idle', [], null],
  ];
  for (const [mood, what, want, wantEmotes, shownState] of moods) {
    await attempt(`  ${mood || '(none)'}: ${what}`, async () => {
      await waitFor('idle', 6000);
      await burst('state:working');
      await waitFor('work', 3000);
      await wait(200);
      await takeFrames();
      const from = t.states.length;
      const sent = await burst(mood ? `state:done:${mood}` : 'state:done');
      await waitFor('idle', 8000, from);
      await wait(400);
      const tl = timeline(from);
      const emotes = await emotesDrawn();
      const shown = shownState && tl.find((s) => s.state === shownState);
      const ok = typeof sent === 'number' && tl.map((s) => s.state).join(' ') === want && emotes.join(' ') === wantEmotes.join(' ') && (!shownState || shown.ms >= 1500);
      return { ok, line: `${showTimeline(tl)} ms; emotes ${emotes.join(', ') || 'none'}` };
    });
  }

  section('an explicit mood beats the reaction before it');
  for (const [reaction, mood, want, wantEmotes] of [
    ['love', 'angry', 'sitDown work standUp love angry idle', ['love', 'angry']],
    ['sad', 'happy', 'sitDown work standUp sad happy idle', ['sad', 'stars']],
    ['love', 'neutral', 'sitDown work standUp love idle', ['love']],
  ]) {
    await attempt(`  working, ${reaction}, done (${mood}): ${wantEmotes.join(' then ')}`, async () => {
      await waitFor('idle', 6000);
      await wait(300);
      await takeFrames();
      const from = t.states.length;
      const sent = await burst('state:working', reaction, `state:done:${mood}`);
      await waitFor('idle', 12000, from);
      await wait(400);
      const tl = timeline(from);
      const emotes = await emotesDrawn();
      const ok = typeof sent === 'number' && tl.map((s) => s.state).join(' ') === want && emotes.join(' ') === wantEmotes.join(' ')
        && tl.filter((s, i) => i >= 3 && i < tl.length - 1).every((s) => s.ms >= 1500);
      return { ok, line: `sent in ${sent} ms; ${showTimeline(tl)} ms; emotes ${emotes.join(', ')}` };
    });
  }

  section('tray: Claude desktop (temp HOME, so a temp config)');
  const config = mcp.defaultConfigPath();
  const label = () => t.trayMenu.items.find((i) => /^Claude desktop:/.test(i.label));
  check('config path is inside the temp HOME', config.startsWith(process.env.HOME) && !fs.existsSync(config), config.replace(process.env.HOME, '<tmp home>'));
  check('status line: not installed', label().label === 'Claude desktop: not installed' && !label().enabled, label().label);
  check('Uninstall disabled while not installed', menuItem('Uninstall from Claude desktop').enabled === false && menuItem('Install in Claude desktop').enabled === true);
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const other = { mcpServers: { weather: { command: 'node', args: ['/Users/me/weather.js'] } }, preferences: { sidebarMode: 'chat' } };
  fs.writeFileSync(config, `${JSON.stringify(other, null, 2)}\n`);
  menuItem('Install in Claude desktop').click();
  let c = JSON.parse(fs.readFileSync(config, 'utf8'));
  check('Install: adds "terra", keeps the rest', JSON.stringify(c.mcpServers.terra) === JSON.stringify(entry) && c.mcpServers.weather.command === 'node' && c.preferences.sidebarMode === 'chat',
    Object.keys(c.mcpServers).join(', '));
  const backups = () => fs.readdirSync(path.dirname(config)).filter((n) => n.includes('.terra-backup-'));
  check('  backup made', backups().length === 1, backups().join(', '));
  check('  dialog says so, with restart note', dialogs.length === 1 && dialogs[0].message === 'Terra was added to Claude desktop' && /Cmd\+Q/.test(dialogs[0].detail), dialogs[0] && dialogs[0].message);
  check('  status line: installed, Install disabled', label().label === 'Claude desktop: installed' && menuItem('Install in Claude desktop').enabled === false, label().label);
  menuItem('Uninstall from Claude desktop').click();
  c = JSON.parse(fs.readFileSync(config, 'utf8'));
  check('Uninstall: back to the original', JSON.stringify(c) === JSON.stringify(other) && dialogs[1].message === 'Terra was removed from Claude desktop', dialogs[1] && dialogs[1].message);
  check('  status line: not installed', label().label === 'Claude desktop: not installed', label().label);
  mcp.install(config); // as `npm run mcp:install` would, behind Terra's back
  const t0 = Date.now();
  while (Date.now() - t0 < 6000 && label().label !== 'Claude desktop: installed') await wait(100);
  check('status line follows changes made elsewhere', label().label === 'Claude desktop: installed', `${label().label} after ${Date.now() - t0} ms`);
  fs.writeFileSync(config, '{ broken');
  const t1 = Date.now();
  while (Date.now() - t1 < 6000 && !/can't read/.test(label().label)) await wait(100);
  menuItem('Install in Claude desktop').click();
  check('broken config: status says so, Install refuses', /can't read/.test(label().label) && dialogs[2].type === 'warning' && /not valid JSON/.test(dialogs[2].detail) && fs.readFileSync(config, 'utf8') === '{ broken',
    `${label().label}; dialog "${dialogs[2] && dialogs[2].message}"`);

  await client.close();
});
