// Opening and closing the pet with Claude desktop, with real processes: the MCP server
// started the way Claude starts it (ELECTRON_RUN_AS_NODE=1 Electron mcp/terra-mcp.js) and
// the real pet it opens (Electron on this project, detached). Covers the pet not running,
// already running, Claude's double start, quitting with Claude (and Claude coming back),
// a pet you opened yourself, and the menu checkbox being off. stdout must stay MCP only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { ROOT, check, section, summary, wait, isolateHome } = require('../lib.js');

const home = isolateHome('e2e-claude');
const ELECTRON = require('electron');
const launcher = require(path.join(ROOT, 'mcp', 'pet-launcher.js'));
const openWithClaude = require(path.join(ROOT, 'open-with-claude.js'));
// The pets opened here use this data folder, never your real one.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-e2e-userdata-'));
const env = { ...process.env, HOME: home, TERRA_USER_DATA: userData };
const PORT_FILE = path.join(home, '.terra-pet', 'port');
const servers = [];

// Starts the MCP server the way Claude desktop does, and says initialize so it answers.
function startServer(name) {
  const p = spawn(ELECTRON, [path.join(ROOT, 'mcp', 'terra-mcp.js')], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const s = { name, p, out: '', err: '', exited: false };
  p.stdout.on('data', (d) => (s.out += d));
  p.stderr.on('data', (d) => (s.err += d));
  p.on('exit', () => (s.exited = true));
  p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`);
  s.close = () => p.stdin.end(); // what Claude desktop does when it quits
  servers.push(s);
  return s;
}
// What the server did about the pet. Nothing logged: it found the pet up and said hello
// straight away, or Claude closed it before it decided.
const outcome = (s) => ((s.err.match(/pet ([a-z ,]+)\n/) || [])[1] || 'found it up or was closed first (nothing to decide)');
const launches = (list) => list.filter((s) => /pet launched/.test(s.err)).length;

const ping = async () => (await launcher.tellPet('ping', 'test-runner-1')).info;
async function until(fn, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(200);
  }
  return !!(await fn());
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Pets (Electron main processes) whose open files are in this test's data folder.
function pets() {
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter((l) => l.includes('Electron.app/Contents/MacOS/Electron ') && l.includes(ROOT))
    .map((l) => Number(l.split(' ')[0]))
    .filter((pid) => {
      try {
        return execFileSync('/usr/sbin/lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8' }).includes(userData);
      } catch {
        return false;
      }
    });
}
async function noPets(timeout = 9000) {
  return until(() => pets().length === 0 && !fs.existsSync(PORT_FILE), timeout);
}

(async () => {
  try {
    section('pet not running when the server starts');
    const s1 = startServer('s1');
    const up = await until(async () => (await ping())?.sessions === 1, 15000);
    const info = await ping();
    check('opens the pet, which says it was opened by Claude', up && info.openedByClaude === true && pets().length === 1 && launches([s1]) === 1,
      `server: pet ${outcome(s1)}; pet ${info && `pid ${info.pid}, opened by Claude ${info.openedByClaude}, ${info.sessions} server(s)`}; ${pets().length} pet process(es)`);

    section('pet already running');
    const s2 = startServer('s2');
    await until(async () => (await ping())?.sessions === 2, 5000);
    await wait(1500); // past the server's launch delay
    check('a second server only says hello', (await ping()).sessions === 2 && pets().length === 1 && launches([s2]) === 0, `${(await ping()).sessions} servers, ${pets().length} pet, server 2: ${outcome(s2)}`);
    s2.close();
    await wait(800);
    check('one of two servers leaving: the pet stays', (await ping())?.sessions === 1 && !(await ping()).quitting, JSON.stringify(await ping()));

    section('quitting with Claude');
    const pid1 = info.pid;
    const closedAt = Date.now();
    s1.close();
    await wait(600);
    const quitting = (await ping())?.quitting;
    await until(() => !alive(pid1), 9000);
    const after = Date.now() - closedAt;
    check('last server gone: the pet quits about 5 s later', quitting === true && !alive(pid1) && after >= 4800 && after <= 7500 && !fs.existsSync(PORT_FILE),
      `quitting ${quitting}; gone ${after} ms after Claude closed; port file ${fs.existsSync(PORT_FILE) ? 'LEFT' : 'removed'}`);

    const s3 = startServer('s3');
    await until(async () => (await ping())?.sessions === 1, 15000);
    const pid3 = (await ping()).pid;
    s3.close();
    await wait(2000);
    const s4 = startServer('s4'); // Claude back within 5 s
    await until(async () => (await ping())?.sessions === 1, 5000);
    await wait(5000);
    check('Claude back within 5 s: the quit is called off', alive(pid3) && (await ping())?.pid === pid3 && !(await ping()).quitting && launches([s4]) === 0,
      `same pet ${pid3} still running 7 s after Claude closed: ${alive(pid3)}; server 4: ${outcome(s4)}`);
    s4.close();
    check('  and it quits when Claude goes for good', await until(() => !alive(pid3), 9000));
    await noPets();

    section("Claude's double start (start, shut down 0.4 s later, start again)");
    const s5 = startServer('s5');
    await wait(400);
    s5.close();
    await wait(180);
    const s6 = startServer('s6');
    await until(async () => (await ping())?.sessions === 1, 15000);
    await wait(2500); // anything that was going to open a second pet has done so by now
    check('one pet', pets().length === 1 && launches([s5, s6]) === 1 && (await ping()).sessions === 1,
      `${pets().length} pet process(es); server 5: ${outcome(s5)}; server 6: ${outcome(s6)}`);
    const s7 = startServer('s7');
    const s8 = startServer('s8');
    s6.close(); // while the other two are starting
    await until(async () => (await ping())?.sessions === 2, 6000);
    await wait(1500);
    check('two servers starting together, a third leaving: still one pet', pets().length === 1 && launches([s7, s8]) === 0 && (await ping()).sessions === 2,
      `${pets().length} pet; servers 7 and 8: ${outcome(s7)} / ${outcome(s8)}`);
    s7.close();
    s8.close();
    check('  gone with Claude', await noPets());

    const s9 = startServer('s9');
    const s10 = startServer('s10'); // both find no pet
    await until(async () => (await ping())?.sessions === 2, 15000);
    await wait(1500);
    check('two servers finding no pet at once: one opens it', pets().length === 1 && launches([s9, s10]) === 1,
      `${pets().length} pet; ${outcome(s9)} / ${outcome(s10)}`);
    s9.close();
    s10.close();
    await noPets();

    section('a pet you opened yourself');
    const mine = spawn(ELECTRON, [ROOT], { env, detached: true, stdio: 'ignore' });
    mine.unref();
    await until(async () => (await ping())?.pid === mine.pid, 15000);
    const s11 = startServer('s11');
    await until(async () => (await ping())?.sessions === 1, 5000);
    const before = await ping();
    s11.close();
    await wait(7000);
    check('Claude quitting leaves it alone', before.openedByClaude === false && alive(mine.pid) && launches([s11]) === 0 && !(await ping()).quitting,
      `opened by Claude ${before.openedByClaude}; still running 7 s after Claude closed: ${alive(mine.pid)}`);
    process.kill(mine.pid, 'SIGTERM');
    await noPets();

    section('"Open and close with Claude desktop" off');
    openWithClaude.setEnabled(false);
    const s12 = startServer('s12');
    await wait(4000);
    check('no pet opened', pets().length === 0 && !fs.existsSync(PORT_FILE), `server: pet ${outcome(s12)}`);
    s12.close();
    openWithClaude.setEnabled(true);

    section('stdout carries MCP messages only');
    await wait(500);
    const bad = [];
    let lines = 0;
    for (const s of servers) {
      for (const line of s.out.split('\n').filter(Boolean)) {
        lines++;
        try {
          if (JSON.parse(line).jsonrpc !== '2.0') bad.push(`${s.name}: ${line.slice(0, 60)}`);
        } catch {
          bad.push(`${s.name}: ${line.slice(0, 60)}`);
        }
      }
    }
    const answered = servers.filter((s) => /"id":1/.test(s.out)).length;
    check('every stdout line is a JSON-RPC message', bad.length === 0 && lines >= servers.length - 1, bad.length ? bad.join(' | ') : `${lines} lines from ${servers.length} servers (${answered} answered initialize)`);
    check('every server exited when Claude closed it', servers.every((s) => s.exited), servers.filter((s) => !s.exited).map((s) => s.name).join(', ') || 'all exited');
  } catch (err) {
    check('test run', false, err.stack);
  } finally {
    for (const s of servers) if (!s.exited) s.p.kill();
    for (const pid of pets()) process.kill(pid, 'SIGTERM');
    process.exitCode = summary() ? 1 : 0;
  }
})();
