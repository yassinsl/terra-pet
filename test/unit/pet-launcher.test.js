// mcp/pet-launcher.js on its own: when the MCP server opens the pet and when it doesn't,
// the lock, how the pet is opened, and how the pet's listener is asked.
const { ROOT, check, section, summary, wait, isolateHome } = require('../lib.js');

const home = isolateHome('launcher');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const launcher = require(path.join(ROOT, 'mcp', 'pet-launcher.js'));

const noSleep = () => Promise.resolve();
const states = (...list) => { let i = 0; return async () => ({ state: list[Math.min(i++, list.length - 1)] }); };

(async () => {
  section('opening the pet, or not');
  {
    let launched = 0;
    const r = await launcher.ensurePet({ isEnabled: () => true, stopped: () => false, check: states('down', 'down', 'up'), launchPet: () => launched++, sleep: noSleep });
    check('not running: opens it once and waits for it', r === 'launched' && launched === 1, `${r}, ${launched} launch`);
  }
  {
    let launched = 0;
    const r = await launcher.ensurePet({ isEnabled: () => true, stopped: () => false, check: states('up'), launchPet: () => launched++, sleep: noSleep });
    check('already running: leaves it', r === 'running' && launched === 0, `${r}, ${launched} launches`);
  }
  {
    let launched = 0;
    const r = await launcher.ensurePet({ isEnabled: () => true, stopped: () => false, check: states('unknown'), launchPet: () => launched++, sleep: noSleep });
    check('port open but no answer (busy pet): leaves it', r === 'running' && launched === 0, `${r}, ${launched} launches`);
  }
  {
    let launched = 0;
    const r = await launcher.ensurePet({ isEnabled: () => false, stopped: () => false, check: states('down'), launchPet: () => launched++, sleep: noSleep });
    check('"Open and close with Claude desktop" off: does nothing', r === 'disabled' && launched === 0, r);
  }
  {
    // Claude's first quick start: shut down during the delay, so it never opens anything.
    let launched = 0;
    let stop = false;
    const p = launcher.ensurePet({ isEnabled: () => true, stopped: () => stop, check: states('down'), launchPet: () => launched++, delayMs: 300 });
    await wait(100);
    stop = true;
    const r = await p;
    check('shut down during the delay: opens nothing', r === 'stopped' && launched === 0, r);
  }

  section('two servers at once (the lock, a real file)');
  {
    // A shared fake world: the pet is "up" 400 ms after the (only) launch.
    let launched = 0;
    let upAt = Infinity;
    const petState = async () => ({ state: Date.now() >= upAt ? 'up' : 'down' });
    const launchPet = () => { launched++; upAt = Date.now() + 400; };
    const one = launcher.ensurePet({ isEnabled: () => true, stopped: () => false, check: petState, launchPet, delayMs: 50 });
    const two = launcher.ensurePet({ isEnabled: () => true, stopped: () => false, check: petState, launchPet, delayMs: 60 });
    const results = await Promise.all([one, two]);
    check('both look, one opens, the other waits for it', launched === 1 && results.includes('launched') && results.includes('opened elsewhere'), `${results.join(' / ')}, ${launched} launch`);
    check('lock released afterwards', !fs.existsSync(launcher.lockFile()));
  }
  {
    fs.mkdirSync(path.dirname(launcher.lockFile()), { recursive: true });
    fs.writeFileSync(launcher.lockFile(), JSON.stringify({ pid: 999999, at: Date.now() })); // that process is long gone
    const release = launcher.acquireLock();
    check('lock left by a server that died: taken over', typeof release === 'function', release ? 'acquired' : 'refused');
    if (release) release();
    fs.writeFileSync(launcher.lockFile(), JSON.stringify({ pid: process.pid, at: Date.now() }));
    check('lock held by a live server: refused', launcher.acquireLock() === null);
    fs.writeFileSync(launcher.lockFile(), JSON.stringify({ pid: process.pid, at: Date.now() - 60000 }));
    const again = launcher.acquireLock();
    check('lock older than 30 s: taken over', typeof again === 'function');
    if (again) again();
    // The race the real-process test caught: a lock seen before its owner was in it.
    fs.writeFileSync(launcher.lockFile(), '');
    check('empty lock, just made: refused (someone is mid-way)', launcher.acquireLock() === null);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(launcher.lockFile(), old, old);
    const taken = launcher.acquireLock();
    check('empty lock, a minute old: taken over', typeof taken === 'function');
    if (taken) taken();
  }

  section('how the pet is opened (never a child of the server, never as Node)');
  {
    const env = { HOME: '/Users/x', ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' };
    const app = launcher.launchCommand({
      execPath: '/Applications/Terra.app/Contents/MacOS/Terra', scriptDir: '/Applications/Terra.app/Contents/Resources/app.asar/mcp', env,
    });
    check('packaged: opens the Terra.app around this server', app.command === '/usr/bin/open' && app.args.join(' ') === '-n -g /Applications/Terra.app --args --opened-by-claude' && !('ELECTRON_RUN_AS_NODE' in app.env),
      `${app.command} ${app.args.join(' ')}`);
    const dev = launcher.launchCommand({ execPath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', scriptDir: '/repo/mcp', env, electron: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' });
    check('development: Electron on the project, like npm start, through a shell that lets go', dev.command === '/bin/sh' && dev.args[1].endsWith('&') && dev.args.slice(2).join(' ') === '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /repo --opened-by-claude' && !('ELECTRON_RUN_AS_NODE' in dev.env) && dev.env.HOME === '/Users/x',
      `${dev.command} -c '${dev.args[1]}' ${dev.args.slice(2).join(' ')}`);
  }

  section('asking the pet');
  {
    const portFile = path.join(home, '.terra-pet', 'port');
    fs.rmSync(portFile, { force: true });
    check('no port file: down', (await launcher.tellPet('ping', 'test-session-1')).state === 'down');
    const closed = net.createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = closed.address().port;
    await new Promise((r) => closed.close(r));
    fs.writeFileSync(portFile, `${deadPort}\n`);
    check('port file left behind (refused): down', (await launcher.tellPet('ping', 'test-session-1')).state === 'down');
    const silent = net.createServer(() => {});
    await new Promise((r) => silent.listen(0, '127.0.0.1', r));
    fs.writeFileSync(portFile, `${silent.address().port}\n`);
    const t0 = Date.now();
    const s = await launcher.tellPet('ping', 'test-session-1', 400);
    check('listening but silent: unknown (counts as running)', s.state === 'unknown' && Date.now() - t0 < 1500, `${s.state} after ${Date.now() - t0} ms`);
    silent.close();
    const seen = [];
    const pet = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => { seen.push({ url: req.url, body: JSON.parse(body) }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"pid":42,"sessions":1}'); });
    });
    await new Promise((r) => pet.listen(0, '127.0.0.1', r));
    fs.writeFileSync(portFile, `${pet.address().port}\n`);
    const up = await launcher.tellPet('hello', 'test-session-1');
    check('answering: up, with its status', up.state === 'up' && up.info.pid === 42 && seen[0].url === '/server' && JSON.stringify(seen[0].body) === '{"action":"hello","id":"test-session-1"}',
      `${up.state}, ${JSON.stringify(up.info)}, sent ${JSON.stringify(seen[0])}`);
    pet.close();
  }

  process.exitCode = summary() ? 1 : 0;
})();
