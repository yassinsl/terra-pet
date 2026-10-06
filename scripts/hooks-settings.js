// Shared by install-hooks.js and uninstall-hooks.js: reading, backing up and
// writing Claude Code's settings.json, and recognising Terra's hook entries.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_SCRIPT = path.resolve(__dirname, '..', 'hooks', 'terra-hook.sh');
const MARKER = 'terra-hook.sh'; // any hook handler whose command mentions this is Terra's

// Claude Code hook event -> Terra event. Matchers follow the hooks docs:
// UserPromptSubmit and Stop don't take one; no matcher means every tool.
const ENTRIES = [
  { hookEvent: 'UserPromptSubmit', event: 'prompt' },
  { hookEvent: 'PreToolUse', event: 'tool' },
  // Only the notifications where Claude is waiting on you.
  { hookEvent: 'Notification', event: 'notify', matcher: 'permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog' },
  { hookEvent: 'Stop', event: 'stop' },
  // Fires instead of Stop when a turn ends on an API error (rate limit, overloaded, ...).
  { hookEvent: 'StopFailure', event: 'error' },
  // Not "compact" (fires mid-task) or "fork".
  { hookEvent: 'SessionStart', event: 'session-start', matcher: 'startup|resume|clear' },
];

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// async: Claude Code doesn't wait for the hook at all. timeout (seconds) only
// matters if a Claude Code version ignores async; the script stops after ~1 s anyway.
function terraGroup({ event, matcher }) {
  const handler = { type: 'command', command: `/bin/sh ${shQuote(HOOK_SCRIPT)} ${event}`, async: true, timeout: 5 };
  return matcher ? { matcher, hooks: [handler] } : { hooks: [handler] };
}

function isTerraHandler(handler) {
  if (!handler || typeof handler !== 'object') return false;
  const parts = [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])];
  return parts.some((p) => typeof p === 'string' && p.includes(MARKER));
}

function settingsPathFromArgs(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--settings');
  if (i !== -1) {
    if (!argv[i + 1]) fail('--settings needs a path');
    return path.resolve(argv[i + 1]);
  }
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function fail(message) {
  console.error(`Error: ${message}\nNothing was changed.`);
  process.exit(1);
}

// Reads settings.json, following a symlink to the real file.
function readSettings(file) {
  let real = file;
  let isLink = false;
  try {
    isLink = fs.lstatSync(file).isSymbolicLink();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (isLink) {
    try {
      real = fs.realpathSync(file);
    } catch {
      fail(`${file} is a symlink to ${fs.readlinkSync(file)}, which doesn't exist`);
    }
  }

  let raw = null;
  try {
    raw = fs.readFileSync(real, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  let settings = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      settings = JSON.parse(raw);
    } catch (err) {
      fail(`${real} is not valid JSON (${err.message})`);
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) fail(`${real} is not a JSON object`);
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    fail(`"hooks" in ${real} is not an object`);
  }
  return { file, real, isLink, raw, settings };
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Backs up the current file next to settings.json (next to the link, if it is one),
// then writes the new content into the real file in place, so a symlink stays a symlink.
function writeSettings({ file, real, raw, settings }) {
  let backup = null;
  if (raw !== null) {
    const { mode } = fs.statSync(real);
    for (let n = 0; ; n++) {
      backup = `${file}.terra-backup-${timestamp()}${n ? `-${n}` : ''}`;
      try {
        fs.writeFileSync(backup, raw, { flag: 'wx', mode });
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  } else {
    fs.mkdirSync(path.dirname(real), { recursive: true });
  }
  const indent = (raw && raw.match(/^([ \t]+)"/m)?.[1]) || '  ';
  fs.writeFileSync(real, `${JSON.stringify(settings, null, indent)}\n`, raw === null ? { mode: 0o600 } : undefined);
  return backup;
}

function printTarget({ file, real, isLink, raw }) {
  console.log(`Settings: ${file}${isLink ? ` (symlink to ${real})` : ''}${raw === null ? ' (new file)' : ''}`);
}

const show = (hookEvent, group) => `  ${hookEvent}: ${JSON.stringify(group)}`;

module.exports = {
  ENTRIES, HOOK_SCRIPT, terraGroup, isTerraHandler, settingsPathFromArgs, readSettings, writeSettings, printTarget, show,
};
