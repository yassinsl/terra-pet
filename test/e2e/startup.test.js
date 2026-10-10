// Launches the real app several times: where it opens with and without a saved spot,
// and the --install-hooks / --uninstall-hooks / --install-mcp / --uninstall-mcp flags
// the packaged app uses.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, check, section, summary, isolateHome } = require('../lib.js');

const ELECTRON = require('electron');
const home = isolateHome('e2e-startup');
const ws = require(path.join(ROOT, 'window-state.js'));

// Launches Terra once. `saved` goes into window-state.json first (unless undefined);
// `pick` is a Size menu label to choose through the tray before quitting the normal way.
// Pass `userData` to keep the folder for another launch.
// `prefs` goes into preferences.json; `claude: true` fakes the Claude desktop app being open;
// `packaged: true` runs as the packaged app with login item calls recorded, not made.
function launch(saved, { pick, userData, prefs, claude, packaged } = {}) {
  const dir = userData || fs.mkdtempSync(path.join(os.tmpdir(), 'terra-e2e-userdata-'));
  if (saved !== undefined) fs.writeFileSync(path.join(dir, 'window-state.json'), typeof saved === 'string' ? saved : JSON.stringify(saved));
  if (prefs !== undefined) fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify(prefs));
  const env = {
    ...process.env, HOME: home, TERRA_TEST_USERDATA: dir, TERRA_TEST_CLAUDE: claude ? 'running' : 'not running',
    ...(pick ? { TERRA_TEST_PICK: pick } : {}), ...(packaged ? { TERRA_TEST_PACKAGED: '1' } : {}),
  };
  const r = spawnSync(ELECTRON, [path.join(__dirname, 'startup-app.js')], { encoding: 'utf8', env, timeout: 30000 });
  const line = (tag) => (r.stdout || '').split('\n').find((l) => l.startsWith(`${tag} `));
  const result = line('RESULT') ? JSON.parse(line('RESULT').slice(7)) : { error: r.stderr || `exit ${r.status}` };
  if (line('PICKED')) result.picked = JSON.parse(line('PICKED').slice(7));
  result.savedFile = ws.load(path.join(dir, 'window-state.json'));
  result.prefsFile = ws.load(path.join(dir, 'preferences.json'));
  if (!userData) fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

const v2 = (state) => ({ version: ws.VERSION, ...state }); // a state file as this version writes it
const label = (s) => (s === 2.25 ? 'Match small (2.25x)' : `${s}x`);
const feetOf = (r) => JSON.stringify(ws.feetOf(r.bounds));

// The primary screen's work area, from a launch with nothing saved.
section('where the window opens');
const first = launch();
const g0 = ws.geometry(ws.DEFAULT_SCALE);
const workRight = first.bounds.x + g0.pet.x + g0.pet.width + 24;
const workBottom = first.bounds.y + first.bounds.height + 24;
// The canvas fills the window and has one pixel of its own per device pixel.
const canvasFits = (r) => r.canvas.join() === `${r.bounds.width},${r.bounds.height}`
  && r.backing.join() === `${Math.round(r.bounds.width * r.dpr)},${Math.round(r.bounds.height * r.dpr)}`;
const canvasLine = (r) => `canvas ${r.canvas.join('x')}, ${r.backing.join('x')} device pixels at pixel ratio ${r.dpr}`;
check('nothing saved (fresh start): Match small 2.25x, bottom-right', first.scale === 2.25 && first.bounds.width === 144 && first.bounds.height === 180
  && canvasFits(first) && first.checked.join() === 'Match small (2.25x)',
  `${JSON.stringify(first.bounds)}, page scale ${first.scale}, menu checks ${first.checked}, ${canvasLine(first)}`);

const feet = { x: workRight - 600, y: workBottom - 300 };
let r = launch(v2({ feet, scale: 2 }));
check('saved spot at 2x: restored', r.scale === 2 && r.canvas.join() === '128,160' && canvasFits(r) && feetOf(r) === JSON.stringify(feet),
  `feet ${feetOf(r)} (saved ${JSON.stringify(feet)}), window ${r.bounds.width}x${r.bounds.height}, ${canvasLine(r)}`);
r = launch(v2({ feet, scale: 1.5 }));
check('saved spot at 1.5x: restored', r.scale === 1.5 && r.canvas.join() === '96,120' && canvasFits(r) && feetOf(r) === JSON.stringify(feet),
  `feet ${feetOf(r)} (saved ${JSON.stringify(feet)}), window ${r.bounds.width}x${r.bounds.height}, ${canvasLine(r)}`);
r = launch(v2({ feet: { x: -4000, y: 300 }, scale: 3 }));
const want3 = { x: workRight - 24 - (48 * 3) / 2, y: workBottom - 24 };
check('saved spot off-screen (monitor gone): default spot', r.scale === 3 && feetOf(r) === JSON.stringify(want3),
  `opened with feet at ${feetOf(r)}, 3x kept`);
r = launch(v2({ feet: { x: -4000, y: 300 }, scale: 1 }));
const want1 = { x: workRight - 24 - 48 / 2, y: workBottom - 24 };
check('  same at 1x', r.scale === 1 && r.canvas.join() === '64,80' && canvasFits(r) && feetOf(r) === JSON.stringify(want1),
  `opened with feet at ${feetOf(r)}, 1x kept, ${canvasLine(r)}`);
r = launch('{ not json');
check('damaged state file: default spot at 2.25x', r.scale === 2.25 && JSON.stringify(r.bounds) === JSON.stringify(first.bounds), JSON.stringify(r.bounds));
// What an older Terra wrote: no version, and a size it saved even when you never chose one.
r = launch({ feet, scale: 4 });
check('older state file: its spot kept, its size dropped for the default', r.scale === 2.25 && feetOf(r) === JSON.stringify(feet),
  `opened at ${r.scale}x with feet at ${feetOf(r)} (saved: 4x, no version)`);

section('every size, picked from the tray, survives a restart');
for (const s of ws.SCALES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-e2e-userdata-'));
  const one = launch(undefined, { pick: label(s), userData: dir });
  const p = one.picked;
  const g = ws.geometry(s);
  const picked = p && p.scale === s && p.bounds.width === g.width && p.bounds.height === g.height && feetOf(p) === feetOf(one) && p.checked.join() === label(s) && canvasFits(p);
  const two = launch(undefined, { userData: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  const kept = two.scale === s && JSON.stringify(two.bounds) === JSON.stringify(p && p.bounds) && two.checked.join() === label(s) && canvasFits(two);
  check(`  ${label(s)}`, picked && kept,
    `picked: window ${p && `${p.bounds.width}x${p.bounds.height}`}, page ${p && p.scale}x, menu ${p && p.checked}; saved ${JSON.stringify(two.savedFile && { scale: two.savedFile.scale })}; after restart: window ${two.bounds.width}x${two.bounds.height} at ${two.bounds.x},${two.bounds.y}, page ${two.scale}x, menu ${two.checked}`);
}

section('Show Terra at startup (remembered; Claude desktop faked)');
for (const [prefs, claudeOpen, want] of [
  [{}, false, false], [{}, true, true],
  [{ showWhen: 'claude' }, false, false], [{ showWhen: 'claude' }, true, true],
  [{ showWhen: 'claude-or-code' }, false, false],
  [{ showWhen: 'always' }, false, true],
]) {
  const x = launch(undefined, { prefs, claude: claudeOpen });
  check(`  ${prefs.showWhen || 'no choice yet (default)'}, Claude ${claudeOpen ? 'open' : 'closed'}`, x.visible === want && x.scale === 2.25,
    `window ${x.visible ? 'shown' : 'hidden'}${x.visible === want ? '' : ` (want ${want ? 'shown' : 'hidden'})`}, page loaded at ${x.scale}x`);
}

section('the Sound menu at startup (remembered)');
{
  const fresh = launch(undefined, { prefs: { showWhen: 'always' } });
  check('  nothing chosen yet: sound off, talk blips on (greyed out), volume low', fresh.soundMenu === 'Sound effects, Talk blips* (off), Volume (off), Low*, Medium, High, Test sound', fresh.soundMenu);
  const mine = launch(undefined, { prefs: { showWhen: 'always', soundEffects: true, talkBlips: false, volume: 'high' } });
  check('  saved choices come back: on, no talk blips, high', mine.soundMenu === 'Sound effects*, Talk blips, Volume (off), Low, Medium, High*, Test sound', mine.soundMenu);
}

section('Start at login, packaged app (login item calls recorded, not made)');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-e2e-userdata-'));
  const one = launch(undefined, { userData: dir, packaged: true, prefs: {} });
  check('  first run turns it on, starting hidden', JSON.stringify(one.loginCalls) === '[{"openAtLogin":true}]' && one.prefsFile.loginItemDefaultDone === true && one.visible === false,
    `calls ${JSON.stringify(one.loginCalls)}, preferences ${JSON.stringify(one.prefsFile)}, window ${one.visible ? 'shown' : 'hidden'}`);
  const two = launch(undefined, { userData: dir, packaged: true });
  check('  next runs leave it alone (so turning it off sticks)', two.loginCalls.length === 0, `calls ${JSON.stringify(two.loginCalls)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const dev = launch(undefined, { prefs: {} });
  check('  npm start never touches it', dev.loginCalls.length === 0 && !(dev.prefsFile || {}).loginItemDefaultDone, `calls ${JSON.stringify(dev.loginCalls)}`);
}

section('app flags for the packaged app');
{
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{\n  "model": "opus"\n}\n');
  const run = (flag) => spawnSync(ELECTRON, [ROOT, flag, '--settings', settings], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 30000 });
  let x = run('--install-hooks');
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  check('--install-hooks: installs and quits', x.status === 0 && Object.keys(s.hooks || {}).length === 6 && s.model === 'opus' && fs.existsSync(path.join(home, '.terra-pet', 'terra-hook.sh')),
    `exit ${x.status}; ${(x.stdout.match(/^ {2}\w+:/gm) || []).length} entries printed under "Added"`);
  x = run('--install-hooks');
  check('--install-hooks again: no change', x.status === 0 && /already installed/.test(x.stdout), x.stdout.split('\n').find((l) => /already/.test(l)));
  x = run('--uninstall-hooks');
  check('--uninstall-hooks: back to the original', x.status === 0 && JSON.stringify(JSON.parse(fs.readFileSync(settings, 'utf8'))) === '{"model":"opus"}', `exit ${x.status}`);
  check('no pet window was started by the flags', !/RESULT/.test(x.stdout));

  const config = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = '{\n  "preferences": {\n    "sidebarMode": "chat"\n  }\n}\n';
  fs.writeFileSync(config, original);
  const runMcp = (flag) => spawnSync(ELECTRON, [ROOT, flag, '--config', config], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 30000 });
  x = runMcp('--install-mcp');
  const c = JSON.parse(fs.readFileSync(config, 'utf8'));
  const entry = c.mcpServers && c.mcpServers.terra;
  check('--install-mcp: installs and quits', x.status === 0 && entry && entry.command === ELECTRON && entry.env.ELECTRON_RUN_AS_NODE === '1' && c.preferences.sidebarMode === 'chat',
    `exit ${x.status}; command ${entry && entry.command.replace(ROOT, '<repo>')}`);
  x = runMcp('--install-mcp');
  check('--install-mcp again: no change', x.status === 0 && /already installed/.test(x.stdout), x.stdout.split('\n').find((l) => /already/.test(l)));
  x = runMcp('--uninstall-mcp');
  check('--uninstall-mcp: back to the original', x.status === 0 && fs.readFileSync(config, 'utf8') === original, `exit ${x.status}`);
  check('no pet window was started by the MCP flags', !/RESULT/.test(x.stdout));
}

process.exitCode = summary() ? 1 : 0;
