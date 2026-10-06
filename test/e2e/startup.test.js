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

function launch(saved) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-e2e-userdata-'));
  if (saved !== undefined) fs.writeFileSync(path.join(userData, 'window-state.json'), typeof saved === 'string' ? saved : JSON.stringify(saved));
  const r = spawnSync(ELECTRON, [path.join(__dirname, 'startup-app.js')], { encoding: 'utf8', env: { ...process.env, HOME: home, TERRA_TEST_USERDATA: userData }, timeout: 30000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  fs.rmSync(userData, { recursive: true, force: true });
  return line ? JSON.parse(line.slice(7)) : { error: r.stderr || `exit ${r.status}` };
}

// The primary screen's work area, from a launch with nothing saved.
section('where the window opens');
const first = launch();
const g4 = ws.geometry(4);
const workRight = first.bounds.x + g4.pet.x + g4.pet.width + 24;
const workBottom = first.bounds.y + first.bounds.height + 24;
// The canvas fills the window and has one pixel of its own per device pixel.
const canvasFits = (r) => r.canvas.join() === `${r.bounds.width},${r.bounds.height}`
  && r.backing.join() === `${Math.round(r.bounds.width * r.dpr)},${Math.round(r.bounds.height * r.dpr)}`;
const canvasLine = (r) => `canvas ${r.canvas.join('x')}, ${r.backing.join('x')} device pixels at pixel ratio ${r.dpr}`;
check('nothing saved: bottom-right at 4x', first.scale === 4 && first.bounds.width === 256 && first.canvas.join() === '256,320' && canvasFits(first),
  `${JSON.stringify(first.bounds)}, page scale ${first.scale}, ${canvasLine(first)}`);

const feet = { x: workRight - 600, y: workBottom - 300 };
let r = launch({ feet, scale: 2 });
check('saved spot at 2x: restored', r.scale === 2 && r.canvas.join() === '128,160' && canvasFits(r) && JSON.stringify(ws.feetOf(r.bounds)) === JSON.stringify(feet),
  `feet ${JSON.stringify(ws.feetOf(r.bounds))} (saved ${JSON.stringify(feet)}), window ${r.bounds.width}x${r.bounds.height}, ${canvasLine(r)}`);
r = launch({ feet, scale: 1.5 });
check('saved spot at 1.5x: restored', r.scale === 1.5 && r.canvas.join() === '96,120' && canvasFits(r) && JSON.stringify(ws.feetOf(r.bounds)) === JSON.stringify(feet),
  `feet ${JSON.stringify(ws.feetOf(r.bounds))} (saved ${JSON.stringify(feet)}), window ${r.bounds.width}x${r.bounds.height}, ${canvasLine(r)}`);
r = launch({ feet: { x: -4000, y: 300 }, scale: 3 });
const want3 = { x: workRight - 24 - (48 * 3) / 2, y: workBottom - 24 };
check('saved spot off-screen (monitor gone): default spot', r.scale === 3 && JSON.stringify(ws.feetOf(r.bounds)) === JSON.stringify(want3),
  `opened with feet at ${JSON.stringify(ws.feetOf(r.bounds))}, 3x kept`);
r = launch({ feet: { x: -4000, y: 300 }, scale: 1 });
const want1 = { x: workRight - 24 - 48 / 2, y: workBottom - 24 };
check('  same at 1x', r.scale === 1 && r.canvas.join() === '64,80' && canvasFits(r) && JSON.stringify(ws.feetOf(r.bounds)) === JSON.stringify(want1),
  `opened with feet at ${JSON.stringify(ws.feetOf(r.bounds))}, 1x kept, ${canvasLine(r)}`);
r = launch('{ not json');
check('damaged state file: default spot at 4x', r.scale === 4 && JSON.stringify(r.bounds) === JSON.stringify(first.bounds), JSON.stringify(r.bounds));

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
