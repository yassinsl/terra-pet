// Adds, removes and checks Terra's hooks in Claude Code's user settings
// (~/.claude/settings.json). Used by `npm run hooks:install` / `hooks:uninstall`,
// by the packaged app (`Terra --install-hooks`), and for the tray's status line.
//
// The hook script is copied to ~/.terra-pet/terra-hook.sh and settings.json points
// there, so the hooks keep working wherever Terra lives: this folder (npm start),
// /Applications/Terra.app, or a copy macOS runs from a temporary place.
// Nothing here exits the process or prints; results come back as text.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InstallError, readJson, writeJson, describeFile, sameJson: same } = require('./json-file.js');

const MARKER = 'terra-hook.sh'; // any hook handler whose command mentions this is Terra's
// Inside the packaged app this path is inside app.asar, which Electron reads like a folder.
const BUNDLED_SCRIPT = path.join(__dirname, 'hooks', 'terra-hook.sh');

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

const defaultSettingsPath = () => path.join(os.homedir(), '.claude', 'settings.json');
const hookCopyPath = () => path.join(os.homedir(), '.terra-pet', 'terra-hook.sh');
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// async: Claude Code doesn't wait for the hook at all. timeout (seconds) only
// matters if a Claude Code version ignores async; the script stops after ~1 s anyway.
function terraGroup({ event, matcher }) {
  const handler = { type: 'command', command: `/bin/sh ${shQuote(hookCopyPath())} ${event}`, async: true, timeout: 5 };
  return matcher ? { matcher, hooks: [handler] } : { hooks: [handler] };
}

function isTerraHandler(handler) {
  if (!handler || typeof handler !== 'object') return false;
  const parts = [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])];
  return parts.some((p) => typeof p === 'string' && p.includes(MARKER));
}

const terraGroups = (groups) => (Array.isArray(groups) ? groups : []).filter((g) => Array.isArray(g?.hooks) && g.hooks.some(isTerraHandler));
const show = (hookEvent, group) => `  ${hookEvent}: ${JSON.stringify(group)}`;

// Reads settings.json, following a symlink to the real file. Throws InstallError.
function readSettings(file) {
  const target = readJson(file);
  const { hooks } = target.data;
  if (hooks !== undefined && (typeof hooks !== 'object' || Array.isArray(hooks))) {
    throw new InstallError(`"hooks" in ${target.real} is not an object`);
  }
  return target;
}

// Copies the hook script to ~/.terra-pet/terra-hook.sh (atomically, so a hook that is
// running never reads half a file). Returns 'copied', 'updated' or 'unchanged'.
function copyHookScript() {
  const target = hookCopyPath();
  const script = fs.readFileSync(BUNDLED_SCRIPT);
  let current = null;
  try {
    current = fs.readFileSync(target);
  } catch {
    // not there yet
  }
  if (current && current.equals(script)) return 'unchanged';
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, script, { mode: 0o755 });
  fs.renameSync(tmp, target);
  return current ? 'updated' : 'copied';
}

// Keeps an installed hook script in step with this version of Terra. Does nothing when
// the hooks were never installed.
function refreshHookScript() {
  return fs.existsSync(hookCopyPath()) ? copyHookScript() : 'not installed';
}

// Merge only: every other setting and hook is left as it is. Safe to run again.
// Returns { code, text }.
function install(settingsFile = defaultSettingsPath()) {
  const lines = [];
  let target;
  try {
    target = readSettings(settingsFile);
  } catch (err) {
    if (err instanceof InstallError) return { code: 1, text: `Error: ${err.message}\nNothing was changed.` };
    throw err;
  }
  const hooks = target.data.hooks || {};
  const added = [];
  const removed = [];
  for (const entry of ENTRIES) {
    const want = terraGroup(entry);
    const groups = hooks[entry.hookEvent];
    if (groups !== undefined && !Array.isArray(groups)) return { code: 1, text: `Error: hooks.${entry.hookEvent} is not a list.\nNothing was changed.` };
    const list = groups || [];
    const mine = terraGroups(list);
    if (mine.length === 1 && same(mine[0], want)) continue; // already installed
    // Replace any older or partial Terra entry for this event (an old script path, say).
    const kept = [];
    for (const group of list) {
      if (!mine.includes(group)) {
        kept.push(group);
        continue;
      }
      for (const h of group.hooks.filter(isTerraHandler)) removed.push(show(entry.hookEvent, { ...group, hooks: [h] }));
      const others = group.hooks.filter((h) => !isTerraHandler(h));
      if (others.length) kept.push({ ...group, hooks: others });
    }
    kept.push(want);
    hooks[entry.hookEvent] = kept;
    added.push(show(entry.hookEvent, want));
  }

  const copied = copyHookScript();
  lines.push(describeFile('Settings', target));
  lines.push(`Hook script: ${hookCopyPath()} (${{ copied: 'copied', updated: 'updated', unchanged: 'already up to date' }[copied]})`);
  if (!added.length) {
    lines.push("Terra's hooks are already installed. settings.json not changed, no backup needed.");
    return { code: 0, text: lines.join('\n') };
  }
  target.data.hooks = hooks;
  const backup = writeJson(target);
  if (backup) lines.push(`Backup:   ${backup}`);
  if (removed.length) lines.push(`Removed (old Terra entries):\n${removed.join('\n')}`);
  lines.push(`Added:\n${added.join('\n')}`);
  lines.push('Nothing else in the file was changed.');
  return { code: 0, text: lines.join('\n') };
}

// Only Terra's entries go; every other setting and hook is left as it is. Returns { code, text }.
function uninstall(settingsFile = defaultSettingsPath()) {
  const lines = [];
  let target;
  try {
    target = readSettings(settingsFile);
  } catch (err) {
    if (err instanceof InstallError) return { code: 1, text: `Error: ${err.message}\nNothing was changed.` };
    throw err;
  }
  const hooks = target.data.hooks || {};
  const removed = [];
  for (const [hookEvent, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const mine = terraGroups(groups);
    if (!mine.length) continue;
    const kept = [];
    for (const group of groups) {
      if (!mine.includes(group)) {
        kept.push(group);
        continue;
      }
      for (const h of group.hooks.filter(isTerraHandler)) removed.push(show(hookEvent, { ...group, hooks: [h] }));
      const others = group.hooks.filter((h) => !isTerraHandler(h));
      if (others.length) kept.push({ ...group, hooks: others });
    }
    // Drop the event (and "hooks") only when removing Terra's entries emptied it.
    if (kept.length) hooks[hookEvent] = kept;
    else delete hooks[hookEvent];
  }

  lines.push(describeFile('Settings', target));
  const copy = hookCopyPath();
  if (fs.existsSync(copy)) {
    fs.rmSync(copy);
    lines.push(`Hook script: removed ${copy}`);
  }
  if (!removed.length) {
    lines.push('No Terra hooks found in settings.json. Not changed, no backup needed.');
    return { code: 0, text: lines.join('\n') };
  }
  if (Object.keys(hooks).length) target.data.hooks = hooks;
  else delete target.data.hooks;
  const backup = writeJson(target);
  if (backup) lines.push(`Backup:   ${backup}`);
  lines.push(`Removed:\n${removed.join('\n')}`);
  lines.push('Nothing else in the file was changed.');
  return { code: 0, text: lines.join('\n') };
}

// Reads settings.json (never writes it) and says whether Terra's hooks are in place:
// 'installed', 'not installed', 'needs update' (old or partial entries, or the hook
// script is missing) or 'unreadable'.
function status(settingsFile = defaultSettingsPath()) {
  let settings;
  try {
    const raw = fs.readFileSync(settingsFile, 'utf8');
    settings = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    return err.code === 'ENOENT' ? 'not installed' : 'unreadable';
  }
  const hooks = (settings && typeof settings.hooks === 'object' && settings.hooks) || {};
  const found = ENTRIES.map((e) => terraGroups(hooks[e.hookEvent]));
  if (!Object.values(hooks).some((g) => terraGroups(g).length)) return 'not installed';
  const exact = ENTRIES.every((e, i) => found[i].length === 1 && same(found[i][0], terraGroup(e)));
  return exact && fs.existsSync(hookCopyPath()) ? 'installed' : 'needs update';
}

// `--settings <path>` on the command line, or ~/.claude/settings.json.
function settingsPathFromArgs(argv) {
  const i = argv.indexOf('--settings');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return defaultSettingsPath();
}

module.exports = {
  ENTRIES, BUNDLED_SCRIPT, hookCopyPath, defaultSettingsPath, terraGroup, isTerraHandler,
  install, uninstall, status, refreshHookScript, settingsPathFromArgs,
};
