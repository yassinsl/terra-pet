// scripts/install-mcp.js and uninstall-mcp.js on temporary copies of the Claude desktop
// config. Never touches the real one: every run passes --config, and HOME is a temp folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, check, section, summary } = require('../lib.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-mcp-installer-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
const mcp = require(path.join(ROOT, 'mcp-installer.js'));
const ELECTRON = require('electron'); // the binary the npm scripts point Claude at
const SCRIPT = path.join(ROOT, 'mcp', 'terra-mcp.js');
const WANT = { command: ELECTRON, args: [SCRIPT], env: { ELECTRON_RUN_AS_NODE: '1' } };

function run(script, file) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), '--config', file], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  return { code: r.status, out: (r.stdout + r.stderr).replaceAll(tmp, '<tmp>') };
}
const install = (f) => run('install-mcp.js', f);
const uninstall = (f) => run('uninstall-mcp.js', f);
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const backups = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.terra-backup-')).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const firstLine = (out, re) => out.split('\n').find((l) => re.test(l)) || out.split('\n')[0];

// Shaped like a real Claude desktop config (fake values), with other servers in it.
const FIXTURE = {
  mcpServers: {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/Desktop'] },
    weather: { command: 'node', args: ['/Users/me/weather/build/index.js'], env: { API_KEY: 'not-a-real-secret' } },
  },
  preferences: { sidebarMode: 'chat', quickEntryShortcut: 'off' },
  coworkUserFilesPath: '/Users/me/Claude',
};

section('install, install again, uninstall, uninstall again');
{
  const dir = path.join(tmp, 'plain');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'claude_desktop_config.json');
  const original = `${JSON.stringify(FIXTURE, null, 2)}\n`;
  fs.writeFileSync(file, original);

  let r = install(file);
  const after = read(file);
  check('install adds "terra"', r.code === 0 && same(after.mcpServers.terra, WANT) && /^Added:\n {2}terra: /m.test(r.out), JSON.stringify(after.mcpServers.terra).replaceAll(ROOT, '<repo>'));
  check('runs Terra\'s own Electron in Node mode', after.mcpServers.terra.env.ELECTRON_RUN_AS_NODE === '1' && fs.existsSync(after.mcpServers.terra.command) && path.isAbsolute(SCRIPT),
    'absolute paths, no PATH lookup');
  const { terra, ...otherServers } = after.mcpServers;
  check('other servers untouched, in order', same(otherServers, FIXTURE.mcpServers) && same(Object.keys(after.mcpServers), ['filesystem', 'weather', 'terra']),
    Object.keys(after.mcpServers).join(', '));
  const { mcpServers, ...rest } = after;
  const { mcpServers: _, ...fixtureRest } = FIXTURE;
  check('every other setting untouched', same(rest, fixtureRest));
  check('server env of others not printed', !r.out.includes('not-a-real-secret'));
  check('says to restart Claude desktop', /Quit the Claude desktop app \(Cmd\+Q\)/.test(r.out));
  check('status: installed', mcp.status(file, ELECTRON) === 'installed', mcp.status(file, ELECTRON));
  check('backup made first, with the old content', backups(dir).length === 1 && fs.readFileSync(path.join(dir, backups(dir)[0]), 'utf8') === original, backups(dir).join(', '));

  r = install(file);
  check('install again: no duplicate, no change', r.code === 0 && /already installed/.test(r.out) && Object.keys(read(file).mcpServers).length === 3 && backups(dir).length === 1,
    firstLine(r.out, /already/));

  r = uninstall(file);
  check('uninstall removes "terra"', r.code === 0 && /^Removed:\n {2}terra: /m.test(r.out) && !('terra' in read(file).mcpServers));
  check('status: not installed', mcp.status(file, ELECTRON) === 'not installed', mcp.status(file, ELECTRON));
  check('file is byte-for-byte the original again', fs.readFileSync(file, 'utf8') === original);
  r = uninstall(file);
  check('uninstall again: nothing to do', r.code === 0 && /not in the config/.test(r.out) && backups(dir).length === 2, firstLine(r.out, /not in/));
}

section('a config like a fresh Claude desktop install (no mcpServers yet)');
{
  const dir = path.join(tmp, 'fresh');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'claude_desktop_config.json');
  const original = '{\n  "preferences": {\n    "sidebarMode": "chat"\n  }\n}';
  fs.writeFileSync(file, original, { mode: 0o600 });
  let r = install(file);
  check('adds an "mcpServers" with only Terra', r.code === 0 && same(Object.keys(read(file).mcpServers), ['terra']) && read(file).preferences.sidebarMode === 'chat');
  check('file mode kept (600)', (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
  r = uninstall(file);
  check('uninstall drops "mcpServers" again', r.code === 0 && same(read(file), { preferences: { sidebarMode: 'chat' } }));
}

section('upgrades, duplicates and somebody else\'s "terra"');
{
  const dir = path.join(tmp, 'upgrade');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'claude_desktop_config.json');
  const old = { command: '/Applications/Terra.app/Contents/MacOS/Terra', args: ['/Applications/Terra.app/Contents/Resources/app.asar/mcp/terra-mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: { weather: FIXTURE.mcpServers.weather, terra: old } }, null, 2)}\n`);
  check('status, other copy of Terra: needs update', mcp.status(file, ELECTRON) === 'needs update', mcp.status(file, ELECTRON));
  let r = install(file);
  const s = read(file);
  check('other copy replaced in place, not duplicated', r.code === 0 && same(s.mcpServers.terra, WANT) && same(Object.keys(s.mcpServers), ['weather', 'terra']) && /Removed \(old Terra entries\):\n {2}terra: /.test(r.out),
    Object.keys(s.mcpServers).join(', '));

  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: { 'terra-pet': old, weather: FIXTURE.mcpServers.weather } }, null, 2)}\n`);
  check('status, Terra under another name: needs update', mcp.status(file, ELECTRON) === 'needs update', mcp.status(file, ELECTRON));
  r = install(file);
  check('Terra under another name: moved to "terra"', r.code === 0 && same(Object.keys(read(file).mcpServers), ['weather', 'terra']) && /terra-pet: /.test(r.out),
    Object.keys(read(file).mcpServers).join(', '));

  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: { terra: WANT, 'terra-old': old } }, null, 2)}\n`);
  check('status, two Terra entries: needs update', mcp.status(file, ELECTRON) === 'needs update', mcp.status(file, ELECTRON));
  r = install(file);
  check('two Terra entries: one left', r.code === 0 && same(Object.keys(read(file).mcpServers), ['terra']) && same(read(file).mcpServers.terra, WANT));
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: { terra: WANT, 'terra-old': old, weather: FIXTURE.mcpServers.weather } }, null, 2)}\n`);
  r = uninstall(file);
  check('uninstall removes every Terra entry, keeps the rest', r.code === 0 && same(Object.keys(read(file).mcpServers), ['weather']), Object.keys(read(file).mcpServers).join(', '));

  const theirs = { mcpServers: { terra: { command: 'python3', args: ['/Users/me/terraform-helper.py'], env: { TOKEN: 'not-a-real-secret' } } } };
  const theirsRaw = `${JSON.stringify(theirs, null, 2)}\n`;
  fs.writeFileSync(file, theirsRaw);
  const before = backups(dir).length;
  r = install(file);
  check('a "terra" that isn\'t Terra\'s: refused, untouched', r.code === 1 && /isn't Terra's/.test(r.out) && fs.readFileSync(file, 'utf8') === theirsRaw && backups(dir).length === before, firstLine(r.out, /Error/));
  check('  and its env not printed', !r.out.includes('not-a-real-secret'));
  r = uninstall(file);
  check('uninstall leaves that "terra" alone', r.code === 0 && fs.readFileSync(file, 'utf8') === theirsRaw && /not in the config/.test(r.out));
  check('status: not installed', mcp.status(file, ELECTRON) === 'not installed');
}

section('symlinked config, missing file, bad files');
{
  const dir = path.join(tmp, 'link');
  fs.mkdirSync(path.join(dir, 'dotfiles'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Claude'));
  const real = path.join(dir, 'dotfiles', 'claude_desktop_config.json');
  const raw = `${JSON.stringify(FIXTURE, null, 4)}\n`; // 4-space indent, kept
  fs.writeFileSync(real, raw);
  const link = path.join(dir, 'Claude', 'claude_desktop_config.json');
  fs.symlinkSync('../dotfiles/claude_desktop_config.json', link);
  let r = install(link);
  check('link stays a link, real file edited', fs.lstatSync(link).isSymbolicLink() && same(read(real).mcpServers.terra, WANT) && /symlink to/.test(r.out));
  check('indentation kept', /^ {4}"mcpServers"/m.test(fs.readFileSync(real, 'utf8')));
  check('backup sits next to the link', backups(path.join(dir, 'Claude')).length === 1, backups(path.join(dir, 'Claude')).join(', '));
  r = uninstall(link);
  check('uninstall: link intact, file as it was', fs.lstatSync(link).isSymbolicLink() && fs.readFileSync(real, 'utf8') === raw);

  const missing = path.join(tmp, 'none', 'Claude', 'claude_desktop_config.json');
  check('status, no config file: not installed', mcp.status(missing, ELECTRON) === 'not installed');
  r = install(missing);
  check('no config file: created with Terra only, mode 600', r.code === 0 && /new file/.test(r.out) && same(read(missing), { mcpServers: { terra: WANT } }) && (fs.statSync(missing).mode & 0o777) === 0o600,
    `mode ${(fs.statSync(missing).mode & 0o777).toString(8)}`);

  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{ "mcpServers": {}, }\n');
  r = install(bad);
  check('invalid JSON: refused, untouched, no backup', r.code === 1 && /not valid JSON/.test(r.out) && fs.readFileSync(bad, 'utf8') === '{ "mcpServers": {}, }\n' && backups(tmp).length === 0, firstLine(r.out, /Error/));
  check('status of invalid JSON: unreadable', mcp.status(bad, ELECTRON) === 'unreadable');
  const list = path.join(tmp, 'list.json');
  fs.writeFileSync(list, '{ "mcpServers": [] }\n');
  r = install(list);
  check('"mcpServers" not an object: refused', r.code === 1 && /"mcpServers" in .* is not an object/.test(r.out) && fs.readFileSync(list, 'utf8') === '{ "mcpServers": [] }\n', firstLine(r.out, /Error/));
  r = uninstall(list);
  check('  uninstall refuses too', r.code === 1 && fs.readFileSync(list, 'utf8') === '{ "mcpServers": [] }\n');
}

section('where Terra runs from');
{
  const file = path.join(tmp, 'where.json');
  fs.writeFileSync(file, '{}\n');
  const translocated = '/private/var/folders/ab/xyz/T/AppTranslocation/1234-5678/d/Terra.app/Contents/MacOS/Terra';
  let r = mcp.install(file, translocated);
  check('App Translocation copy: refused', r.code === 1 && /App Translocation/.test(r.text) && /Move Terra to Applications/.test(r.text) && fs.readFileSync(file, 'utf8') === '{}\n', r.text.split('\n')[0]);
  r = mcp.install(file, '/Volumes/Terra 0.1.0/Terra.app/Contents/MacOS/Terra');
  check('running from the disk image: refused', r.code === 1 && /disk image/.test(r.text) && fs.readFileSync(file, 'utf8') === '{}\n', r.text.split('\n')[0]);
  const app = '/Applications/Terra.app/Contents/MacOS/Terra';
  r = mcp.install(file, app);
  const entry = read(file).mcpServers.terra;
  check('packaged app: points at Terra.app in Node mode', r.code === 0 && entry.command === app && entry.args[0] === SCRIPT && entry.env.ELECTRON_RUN_AS_NODE === '1', JSON.stringify(entry).replaceAll(ROOT, '<repo>'));
  check('status for that app: installed; for npm start: needs update', mcp.status(file, app) === 'installed' && mcp.status(file, ELECTRON) === 'needs update');
}

fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = summary() ? 1 : 0;
