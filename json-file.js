// Reads and writes the JSON files Terra's installers edit: Claude Code's settings.json
// (hook-installer.js) and the Claude desktop app's claude_desktop_config.json
// (mcp-installer.js). A symlink is followed and stays a symlink, the old content is
// backed up next to the file before anything is written, and the indentation is kept.
const fs = require('node:fs');
const path = require('node:path');

// A problem with the user's file; the installers turn it into "Nothing was changed".
class InstallError extends Error {}

// Reads a JSON object file, following a symlink to the real file. A missing or empty
// file reads as {}. Throws InstallError.
function readJson(file) {
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
      throw new InstallError(`${file} is a symlink to ${fs.readlinkSync(file)}, which doesn't exist`);
    }
  }
  let raw = null;
  try {
    raw = fs.readFileSync(real, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  let data = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new InstallError(`${real} is not valid JSON (${err.message})`);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InstallError(`${real} is not a JSON object`);
  return { file, real, isLink, raw, data };
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Backs up the current file next to it (next to the link, if it is one), then writes the
// new content into the real file in place, so a symlink stays a symlink. Returns the
// backup's path, or null for a new file.
function writeJson({ file, real, raw, data }) {
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
  fs.writeFileSync(real, `${JSON.stringify(data, null, indent)}\n`, raw === null ? { mode: 0o600 } : undefined);
  return backup;
}

// "Settings: <path> (symlink to ...)" for the installers' output.
function describeFile(label, { file, real, isLink, raw }) {
  return `${label}: ${file}${isLink ? ` (symlink to ${real})` : ''}${raw === null ? ' (new file)' : ''}`;
}

// Deep equality for JSON values, ignoring key order.
const sorted = (v) => (Array.isArray(v) ? v.map(sorted)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const sameJson = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

module.exports = { InstallError, readJson, writeJson, describeFile, sameJson };
