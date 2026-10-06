// Runs every test: node unit tests, then the Electron end-to-end tests (these open a
// pet window and move it around for a few minutes). Afterwards, checks that no test
// prompt text showed up in any output or in the files the app writes.
// Usage: npm test            all
//        npm test -- unit    only the fast unit tests
//        npm test -- e2e     only the Electron tests
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, PROMPT_MARK } = require('./lib.js');

const ELECTRON = require('electron'); // from node this is the path to the binary
const SUITES = [
  ['unit', process.execPath, 'test/unit/reactions.test.js'],
  ['unit', process.execPath, 'test/unit/listener.test.js'],
  ['unit', process.execPath, 'test/unit/hook-script.test.js'],
  ['unit', process.execPath, 'test/unit/installer.test.js'],
  ['unit', process.execPath, 'test/unit/mcp-installer.test.js'],
  ['unit', process.execPath, 'test/unit/mcp-server.test.js'],
  ['unit', process.execPath, 'test/unit/window-state.test.js'],
  ['unit', process.execPath, 'test/unit/visibility.test.js'],
  ['e2e', process.execPath, 'test/e2e/startup.test.js'],
  ['e2e', ELECTRON, 'test/e2e/events.e2e.js'],
  ['e2e', ELECTRON, 'test/e2e/pet.e2e.js'],
  ['e2e', ELECTRON, 'test/e2e/size.e2e.js'],
  ['e2e', ELECTRON, 'test/e2e/visibility.e2e.js'],
  ['e2e', ELECTRON, 'test/e2e/mcp.e2e.js'],
];

const only = process.argv[2];
const started = Date.now();
const results = [];
let output = '';

function runSuite(cmd, file) {
  return new Promise((resolve) => {
    // ELECTRON_ENABLE_LOGGING prints renderer console output too, so it is checked as well.
    const p = spawn(cmd, [file], { cwd: ROOT, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
    const onData = (d) => {
      const text = d.toString();
      output += text;
      for (const line of text.split('\n')) {
        if (/^(PASS|FAIL|---|DEBUG|\d+\/\d+ passed)/.test(line)) console.log(line);
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', (d) => { output += d.toString(); });
    p.on('close', (code) => resolve(code));
  });
}

(async () => {
  for (const [kind, cmd, file] of SUITES) {
    if (only && only !== kind && !file.includes(only)) continue;
    console.log(`\n===== ${file}`);
    const code = await runSuite(cmd, file);
    results.push({ file, ok: code === 0 });
  }

  console.log('\n===== prompt privacy');
  const leaks = [];
  if (output.includes(PROMPT_MARK)) leaks.push('test output / app logs');
  const dirs = fs.readdirSync(os.tmpdir()).filter((n) => /^terra-(e2e|hook|listener|mcp)/.test(n)).map((n) => path.join(os.tmpdir(), n));
  dirs.push(path.join(os.homedir(), 'Library', 'Application Support', 'Electron'));
  const scan = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) scan(path.join(p, n));
    else if (st.size < 20 * 1024 * 1024 && st.mtimeMs >= started - 1000 && fs.readFileSync(p).includes(PROMPT_MARK)) leaks.push(p);
  };
  for (const d of dirs) scan(d);
  const privacyOk = leaks.length === 0;
  console.log(`${privacyOk ? 'PASS' : 'FAIL'}  prompt text never in output, logs or app files   ${privacyOk ? `checked ${output.split('\n').length} output lines and ${dirs.length} folders` : leaks.join(', ')}`);
  for (const d of dirs) if (d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true });

  console.log('\n===== summary');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file}`);
  const failed = results.filter((r) => !r.ok).length + (privacyOk ? 0 : 1);
  console.log(failed ? `${failed} failed` : `all passed (${Math.round((Date.now() - started) / 1000)} s)`);
  process.exitCode = failed ? 1 : 0;
})();
