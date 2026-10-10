// The REAL sound path, no fake: `Terra --check-sound --muted` plays hi.wav with macOS's
// afplay the way every sound effect plays, and says whether afplay started and exited with
// 0. From source and from the packaged app in dist/ (which must be built from this code:
// run `npm run dist` first), where the sounds must sit in app.asar.unpacked for afplay to
// read them. Plus the startup log line. Muted (afplay -v 0), so nobody hears the tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, check, section, summary, isolateHome } = require('../lib.js');

const ELECTRON = require('electron');
const home = isolateHome('e2e-sound');
const { extractFile } = require(path.join(ROOT, 'node_modules', '@electron', 'asar'));
const WAVS = fs.readdirSync(path.join(ROOT, 'Bot', 'sounds')).filter((n) => n.endsWith('.wav'));

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, HOME: home, ...env }, timeout: 30000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('{'));
  let result = null;
  try {
    result = line && JSON.parse(line);
  } catch {
    // reported below
  }
  return { code: r.status, result, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const shown = (r) => (r.result ? JSON.stringify(r.result).replace(ROOT, '<repo>') : `exit ${r.code}: ${r.stderr.slice(-200)}`);

section('from source (npm start)');
{
  const r = run(ELECTRON, [ROOT, '--check-sound', '--muted']);
  const x = r.result || {};
  check('  --check-sound: /usr/bin/afplay plays Bot/sounds/hi.wav and exits with 0', r.code === 0 && x.played === true && x.exitCode === 0 && x.player === '/usr/bin/afplay'
    && x.file === path.join(ROOT, 'Bot', 'sounds', 'hi.wav') && x.soundFiles === 15, shown(r));
}
{
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-e2e-userdata-'));
  const r = run(ELECTRON, [path.join(__dirname, 'startup-app.js')], { TERRA_TEST_USERDATA: userData, TERRA_TEST_CLAUDE: 'not running' });
  const line = r.stdout.split('\n').find((l) => l.startsWith('Terra: sound files in'));
  check('  startup log: where the sound files are, how many, and afplay', !!line && line.endsWith(`${path.join(ROOT, 'Bot', 'sounds')} (15 found), played with /usr/bin/afplay`), line || 'no such line');
  fs.rmSync(userData, { recursive: true, force: true });
}

section('the packaged app (dist/)');
{
  const appDir = ['mac-arm64', 'mac'].map((d) => path.join(ROOT, 'dist', d, 'Terra.app')).find((d) => fs.existsSync(d) && (process.arch === 'arm64') === d.includes('arm64'));
  if (!appDir) {
    check('  dist/ has a Terra.app for this Mac', false, 'none: run npm run dist first');
  } else {
    const resources = path.join(appDir, 'Contents', 'Resources');
    const asar = path.join(resources, 'app.asar');
    // (Not package.json: electron-builder writes its own, without the build settings.)
    const current = ['main.js', 'sound-player.js', 'renderer/pet.js', 'renderer/sounds.js', 'preload.js'].every((f) => extractFile(asar, f).equals(fs.readFileSync(path.join(ROOT, f))));
    check('  built from this code', current, current ? path.relative(ROOT, appDir) : 'dist/ is older than the code: run npm run dist first');
    const unpacked = path.join(resources, 'app.asar.unpacked', 'Bot', 'sounds');
    const there = WAVS.filter((n) => fs.existsSync(path.join(unpacked, n)) && fs.readFileSync(path.join(unpacked, n)).equals(fs.readFileSync(path.join(ROOT, 'Bot', 'sounds', n))));
    check('  every sound file in app.asar.unpacked, where afplay can read it', there.length === WAVS.length && WAVS.length === 15, `${there.length} of ${WAVS.length} in ${path.relative(appDir, unpacked)}`);
    if (current) {
      const r = run(path.join(appDir, 'Contents', 'MacOS', 'Terra'), ['--check-sound', '--muted']);
      const x = r.result || {};
      check('  Terra --check-sound: afplay starts on the unpacked hi.wav and exits with 0', r.code === 0 && x.played === true && x.exitCode === 0
        && x.file === path.join(unpacked, 'hi.wav') && x.soundFiles === 15, shown(r));
    }
  }
}

fs.rmSync(home, { recursive: true, force: true });
process.exitCode = summary() ? 1 : 0;
