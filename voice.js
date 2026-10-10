// Terra's voice: speaks speech bubble text with macOS's own say, from the main process, the
// way sound-player.js plays sound effects with afplay. The text is given to say on stdin
// (say -f -), never as an argument, so it never shows in `ps`; it is never logged or saved.
const { execFile, spawn } = require('node:child_process');

const SAY = '/usr/bin/say';
const RATES = { slow: 160, normal: 190, fast: 230 }; // say -r, words a minute
const FRIENDLY = ['Samantha', 'Karen', 'Moira', 'Tessa', 'Daniel']; // the first one installed is the default
const MAX_SPOKEN = 300; // characters said at most (bubbles show about 40)
const TEST_LINE = "Hi! I'm Terra.";

// `say -v '?'` lines: "Eddy (English (UK)) en_GB    # Hello! My name is Eddy." -> the
// English ones, in say's order: [{ name, locale }].
function parseVoices(out) {
  return String(out).split('\n')
    .map((line) => line.match(/^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/))
    .filter((m) => m && /^en[_-]/.test(m[2]))
    .map((m) => ({ name: m[1].trim(), locale: m[2] }));
}

// The installed English voices (empty when say can't tell). Asks say in the background.
function listVoices() {
  return new Promise((resolve) => {
    execFile(SAY, ['-v', '?'], { timeout: 5000 }, (err, stdout) => resolve(err ? [] : parseVoices(stdout)));
  });
}

// A friendly English voice if one is installed, else the first English one, else null
// (say's own default).
function defaultVoice(voices) {
  const names = voices.map((v) => v.name);
  return FRIENDLY.find((n) => names.includes(n)) || names[0] || null;
}

// What to say for a bubble's text: as written (not the bubble's capitals), on one line,
// without control characters or say's embedded [[commands]], at most MAX_SPOKEN characters
// (cut at a word).
function speechText(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.replace(/\[\[[^\]]*\]\]/g, '').replace(/\s/gu, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/ +/g, ' ').trim();
  if (text.length > MAX_SPOKEN) {
    const cut = text.slice(0, MAX_SPOKEN);
    text = cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : MAX_SPOKEN);
  }
  return text;
}

// Starts say, detached, with nothing but its own arguments; the text goes in on stdin.
// Used as voice.spawnSay(...) so the tests can put a fake process in its place.
function spawnSay(args) {
  const child = spawn(SAY, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  child.unref();
  return child;
}

// say's arguments for `voice` at `rate`: the text itself is never one of them (stdin: -f -).
function sayArgs({ voice = null, rate = 'normal' } = {}) {
  return [...(voice ? ['-v', voice] : []), '-r', String(RATES[rate] || RATES.normal), '-f', '-'];
}

let current = null; // { child, done } while say speaks

// Says `text` (already speechText) in `voice` at `rate` (slow/normal/fast), stopping what
// is being said first. Resolves to say's exit code when it has finished or was stopped.
function speak(text, { voice = null, rate = 'normal' } = {}) {
  stop();
  const child = module.exports.spawnSay(sayArgs({ voice, rate }));
  const done = new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
  const mine = { child, done };
  current = mine;
  done.then(() => {
    if (current === mine) current = null;
  });
  if (child.stdin) {
    child.stdin.on('error', () => {}); // say gone before it read everything: nothing to do
    child.stdin.end(text);
  }
  return done;
}

function stop() {
  if (!current) return;
  const { child } = current;
  current = null;
  try {
    child.kill();
  } catch {
    // already gone
  }
}

const speaking = () => current !== null;

module.exports = { SAY, RATES, FRIENDLY, MAX_SPOKEN, TEST_LINE, parseVoices, listVoices, defaultVoice, speechText, sayArgs, spawnSay, speak, stop, speaking };
