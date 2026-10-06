// Tiny helpers shared by the test files.
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const results = [];

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(48)} ${detail}`);
  results.push({ label, ok: !!ok });
  return !!ok;
}

function section(title) {
  console.log(`--- ${title}`);
}

// Prints the tally; returns the number of failures.
function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.label).join(', ')}` : ''}`);
  return failed.length;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Points HOME at a fresh temp folder so tests never touch the real ~/.terra-pet
// (a Terra you are running keeps its own port file). Call before requiring listener.js.
//
// If the real port file is left over from a Terra that didn't quit cleanly, its port
// is free, and a test listener could take it; Claude Code's real hooks (if installed)
// would then post into the test. So that port is held, closed to everyone, meanwhile.
function isolateHome(prefix) {
  try {
    const port = Number(fs.readFileSync(path.join(os.homedir(), '.terra-pet', 'port'), 'utf8').trim());
    if (port > 0) {
      const hold = net.createServer((socket) => socket.destroy());
      hold.on('error', () => {}); // in use: a real Terra is running there, fine
      hold.listen(port, '127.0.0.1');
      hold.unref();
    }
  } catch {
    // no real port file
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `terra-${prefix}-`));
  process.env.HOME = home;
  return home;
}

// Marker put into every test prompt; test/run.js checks it never reaches logs or disk.
const PROMPT_MARK = 'PRIVATE-PROMPT-MARK-5150';

module.exports = { ROOT, check, section, summary, wait, isolateHome, PROMPT_MARK };
