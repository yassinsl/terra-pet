// Used by mcp/terra-mcp.js, which Claude desktop starts every time it opens: tells the
// pet this server is here (hello) or going (bye), and opens the pet when it isn't running.
//
// Claude starts the server twice at launch (start, shutdown ~0.4 s later, start again),
// and the user may be opening Terra at the same moment, so the pet is only opened after
// a short delay, under a lock file, and after looking again inside the lock. The pet
// also refuses to run twice (Electron's single-instance lock), whatever happens here.
//
// Nothing here writes to stdout: that is the MCP protocol's.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOST = '127.0.0.1';
const DELAY_MS = 1000;     // the first of Claude's two quick starts is gone by then
const WAIT_UP_MS = 20000;  // how long to wait for an opened pet to start listening
const LOCK_STALE_MS = 30000;

const terraDir = () => path.join(os.homedir(), '.terra-pet');
const lockFile = () => path.join(terraDir(), 'launch.lock');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// POST /server { action, id } to the pet. Resolves to
//   { state: 'up', info }  the pet answered (info: its reply, if it is new enough to send one)
//   { state: 'down' }      no port file, or nothing listening on its port (a file left behind)
//   { state: 'unknown' }   something is listening but didn't answer in time: assume it's Terra
function tellPet(action, id, timeout = 1500) {
  let port;
  try {
    port = Number(fs.readFileSync(path.join(terraDir(), 'port'), 'utf8').trim());
  } catch {
    return Promise.resolve({ state: 'down' });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve({ state: 'down' });
  const data = JSON.stringify({ action, id });
  return new Promise((resolve) => {
    const req = http.request({
      host: HOST, port, path: '/server', method: 'POST', agent: false, timeout,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        let info = null;
        try {
          info = JSON.parse(body);
        } catch {
          // an older Terra without this route: still a running pet
        }
        resolve({ state: 'up', info });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })));
    req.on('error', (err) => resolve({ state: err.code === 'ECONNREFUSED' ? 'down' : 'unknown' }));
    req.end(data);
  });
}

// How to open the pet that this server belongs to, without making it a child of the
// server or giving it the server's stdio.
//   packaged (this file is inside Terra.app's app.asar): open that Terra.app
//   development: the project's Electron on the project folder, like `npm start`, through
//                a shell that backgrounds it and exits, so the pet's parent is launchd
function launchCommand({ execPath = process.execPath, scriptDir = __dirname, env = process.env, electron } = {}) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE; // or the pet would start as plain Node, like this server
  const inApp = scriptDir.split(path.sep).includes('app.asar');
  if (inApp) {
    const bundle = execPath.slice(0, execPath.lastIndexOf('.app/') + '.app'.length);
    return { command: '/usr/bin/open', args: ['-n', '-g', bundle, '--args', '--opened-by-claude'], env: childEnv };
  }
  const binary = electron || (process.versions.electron ? execPath : require('electron'));
  const root = path.resolve(scriptDir, '..');
  return {
    command: '/bin/sh',
    args: ['-c', '"$0" "$@" </dev/null >/dev/null 2>&1 &', binary, root, '--opened-by-claude'],
    env: childEnv,
  };
}

function launch(cmd = launchCommand()) {
  spawn(cmd.command, cmd.args, { env: cmd.env, detached: true, stdio: 'ignore' }).unref();
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// Takes ~/.terra-pet/launch.lock; returns a function that releases it, or null when
// another server holds it. A lock whose owner has died, or that is old, is taken over.
// The lock is written whole to a temporary file and then linked into place, which fails
// if a lock is already there: so nobody ever sees a lock without its owner in it.
function acquireLock(file = lockFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.linkSync(tmp, file);
        return () => fs.rmSync(file, { force: true });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      let owner = null;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
        owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // gone again, or not ours to read: decided by its age below
      }
      const stale = age > LOCK_STALE_MS || (owner && (!alive(owner.pid) || Date.now() - owner.at > LOCK_STALE_MS));
      if (!stale) return null;
      fs.rmSync(file, { force: true });
    }
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Opens the pet unless it is running (or being opened by another server). Resolves to
// what happened: 'disabled', 'stopped' (this server is shutting down), 'running',
// 'opened elsewhere', 'launched' or 'launched, not answering yet'.
async function ensurePet({
  isEnabled, stopped, check = () => tellPet('ping', 'launcher'), launchPet = launch, lock = acquireLock,
  delayMs = DELAY_MS, waitUpMs = WAIT_UP_MS, sleep = wait,
}) {
  await sleep(delayMs);
  if (stopped()) return 'stopped';
  if (!isEnabled()) return 'disabled';
  if ((await check()).state !== 'down') return 'running';
  const waitUp = async () => {
    for (let t = 0; t < waitUpMs; t += 250) {
      if ((await check()).state !== 'down') return true;
      await sleep(250);
    }
    return false;
  };
  const release = lock();
  if (!release) return (await waitUp()) ? 'opened elsewhere' : 'opened elsewhere, not answering yet';
  try {
    if (stopped()) return 'stopped';
    if ((await check()).state !== 'down') return 'running'; // looked again, inside the lock
    launchPet();
    return (await waitUp()) ? 'launched' : 'launched, not answering yet';
  } finally {
    release();
  }
}

module.exports = { DELAY_MS, tellPet, launchCommand, launch, acquireLock, ensurePet, lockFile };
