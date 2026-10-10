// The REAL audio path, no fake player: `Terra --check-sound --muted` plays a sound effect
// from the pet's page the way the pet does and says whether play() went through. Run from
// source and from the packaged app in dist/ (which must be built from this code: run
// `npm run dist` first), plus the startup log line saying where the sound files are.
// Muted, so nobody hears the tests; play() goes through all the same.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, check, section, summary, isolateHome } = require('../lib.js');

const ELECTRON = require('electron');
const home = isolateHome('e2e-sound');
const { extractFile } = require(path.join(ROOT, 'node_modules', '@electron', 'asar'));

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

section('from source (npm start)');
{
  const r = run(ELECTRON, [ROOT, '--check-sound', '--muted']);
  const x = r.result || {};
  check('  --check-sound: play() resolves for hi.wav, exit 0', r.code === 0 && x.played === true && x.file === 'terra-pet/Bot/sounds/hi.wav' && Math.abs(x.duration - 0.21) < 0.01 && x.soundFiles === 15,
    r.result ? JSON.stringify({ played: x.played, error: x.error, file: x.file, duration: x.duration, soundFiles: x.soundFiles }) : `exit ${r.code}: ${r.stderr.slice(-200)}`);
}
{
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-e2e-userdata-'));
  const r = run(ELECTRON, [path.join(__dirname, 'startup-app.js')], { TERRA_TEST_USERDATA: userData, TERRA_TEST_CLAUDE: 'not running' });
  const line = r.stdout.split('\n').find((l) => l.startsWith('Terra: sound files in'));
  check('  startup log: where the sound files are, and how many', !!line && line.endsWith(`${path.join(ROOT, 'Bot', 'sounds')} (15 found)`), line || 'no such line');
  fs.rmSync(userData, { recursive: true, force: true });
}

section('the packaged app (dist/)');
{
  const appDir = ['mac-arm64', 'mac'].map((d) => path.join(ROOT, 'dist', d, 'Terra.app')).find((d) => fs.existsSync(d) && (process.arch === 'arm64') === d.includes('arm64'));
  if (!appDir) {
    check('  dist/ has a Terra.app for this Mac', false, 'none: run npm run dist first');
  } else {
    const asar = path.join(appDir, 'Contents', 'Resources', 'app.asar');
    const current = ['main.js', 'renderer/pet.js', 'renderer/sounds.js', 'preload.js'].every((f) => extractFile(asar, f).equals(fs.readFileSync(path.join(ROOT, f))));
    check('  built from this code', current, current ? path.relative(ROOT, appDir) : 'dist/ is older than the code: run npm run dist first');
    const wavs = fs.readdirSync(path.join(ROOT, 'Bot', 'sounds')).filter((n) => n.endsWith('.wav'));
    const packed = wavs.filter((n) => extractFile(asar, `Bot/sounds/${n}`).equals(fs.readFileSync(path.join(ROOT, 'Bot', 'sounds', n))));
    check('  every sound file is inside app.asar', packed.length === wavs.length && wavs.length === 15, `${packed.length} of ${wavs.length}`);
    if (current) {
      const r = run(path.join(appDir, 'Contents', 'MacOS', 'Terra'), ['--check-sound', '--muted']);
      const x = r.result || {};
      check('  Terra --check-sound: play() resolves for app.asar/Bot/sounds/hi.wav, exit 0', r.code === 0 && x.played === true && x.file === 'app.asar/Bot/sounds/hi.wav' && x.soundFiles === 15,
        r.result ? JSON.stringify({ played: x.played, error: x.error, file: x.file, duration: x.duration, soundFiles: x.soundFiles }) : `exit ${r.code}: ${r.stderr.slice(-200)}`);
    }
  }
}

fs.rmSync(home, { recursive: true, force: true });
process.exitCode = summary() ? 1 : 0;
