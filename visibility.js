// When Terra's window is shown ("Show Terra" in the menu), and the preferences file in the
// app's user data folder that remembers it.
const fs = require('node:fs');
const path = require('node:path');

const MODES = [
  { id: 'claude', label: 'Only while Claude desktop is running' },
  { id: 'claude-or-code', label: 'While Claude desktop or a Claude Code session is active' },
  { id: 'always', label: 'Always' },
];
const DEFAULT_MODE = 'claude';
// A Claude Code session counts as active from its first hook event until this long
// after its last one.
const CODE_SESSION_MS = 10 * 60 * 1000;

function shouldShow({ mode, claudeRunning, lastCodeEventAt, now }) {
  if (mode === 'always' || claudeRunning) return true;
  return mode === 'claude-or-code' && lastCodeEventAt > 0 && now - lastCodeEventAt < CODE_SESSION_MS;
}

// showWhen: one of MODES. loginItemDefaultDone: the packaged app has turned "Start at
// login" on once already, so it won't again after you turn it off.
function loadPrefs(file) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    // missing or damaged: defaults
  }
  return {
    showWhen: MODES.some((m) => m.id === saved.showWhen) ? saved.showWhen : DEFAULT_MODE,
    loginItemDefaultDone: saved.loginItemDefaultDone === true,
  };
}

function savePrefs(file, prefs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

module.exports = { MODES, DEFAULT_MODE, CODE_SESSION_MS, shouldShow, loadPrefs, savePrefs };
