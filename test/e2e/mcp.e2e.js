// The Claude desktop app's side, end to end: the real MCP server (started the way the
// config written by mcp:install starts it) -> listener -> the running pet. Every tool and
// name, reactions while working, and the tray's Claude desktop items on a temp config.
// Run: npx electron test/e2e/mcp.e2e.js   (or npm test)
const {
  ROOT, t, check, section, wait, menuItem, waitFor, compress, step, start, fs, path,
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
const setState = (state) => () => tool('terra_state', { state });

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
  await step('done -> stars, then idle', setState('done'), ['standUp', 'happy', 'idle'], ['stars'], 'idle');
  await step('working', setState('working'), ['sitDown', 'work'], [], 'work');
  await step('idle: stands up', setState('idle'), ['standUp', 'idle'], [], 'idle');
  await step('waiting from idle', setState('waiting'), ['ask'], ['ask'], 'ask');
  await step('idle from waiting: emote removed', setState('idle'), ['idle'], [], 'idle');
  await step('done from idle', setState('done'), ['happy', 'idle'], ['stars'], 'idle');

  section('terra_react on the running pet (from idle)');
  const anims = { hi: 'wave', love: 'love', angry: 'angry', idea: 'idea', stars: 'happy' };
  for (const [reaction, anim] of Object.entries(anims)) {
    await step(reaction, react(reaction), [anim, 'idle'], [reaction], 'idle');
  }
  for (const reaction of ['talk', 'sad', 'ask']) {
    const from = t.states.length;
    await step(`${reaction} (loops, ends after 4 s)`, react(reaction), [reaction, 'idle'], [reaction], 'idle');
    const seen = t.states.slice(from);
    const ms = seen.find((s) => s.state === 'idle')?.t - seen.find((s) => s.state === reaction)?.t;
    check(`  ${reaction} lasted about 4 s`, ms > 3700 && ms < 4800, `${ms} ms`);
  }

  section('terra_react while working: back to work after');
  await step('working', setState('working'), ['sitDown', 'work'], [], 'work');
  await step('love while working', react('love'), ['standUp', 'love', 'sitDown', 'work'], ['love'], 'work');
  await step('talk while working (loop)', react('talk'), ['standUp', 'talk', 'sitDown', 'work'], ['talk'], 'work');
  {
    // A new command cancels a looping reaction's 4 s timer.
    const from = t.states.length;
    await tool('terra_react', { reaction: 'sad' });
    await waitFor('sad', 3000, from);
    await tool('terra_state', { state: 'waiting' });
    await waitFor('ask', 3000, from);
    await wait(4500);
    const seen = compress(t.states.slice(from));
    check('state after a loop reaction is kept', seen.join(' ') === 'standUp sad ask', seen.join(' -> '));
  }
  await step('done', setState('done'), ['happy', 'idle'], ['stars'], 'idle');

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
