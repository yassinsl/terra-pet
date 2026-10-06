// Adds, removes and checks Terra's MCP server in the Claude desktop app's config
// (~/Library/Application Support/Claude/claude_desktop_config.json). Used by
// `npm run mcp:install` / `mcp:uninstall`, by the packaged app (`Terra --install-mcp`),
// and by the tray menu. Nothing here exits the process or prints; results come back as text.
//
// The "terra" entry starts mcp/terra-mcp.js with the binary that runs Terra, in Node mode
// (ELECTRON_RUN_AS_NODE): Terra.app's own for the app, node_modules' Electron for
// `npm start`. So it needs no separate Node install, but it points into this copy of
// Terra: after moving Terra (or switching between the app and the source), install again.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InstallError, readJson, writeJson, describeFile, sameJson: same } = require('./json-file.js');

const NAME = 'terra';
const MARKER = 'terra-mcp.js'; // any server whose command or args mention this is Terra's
// Inside the packaged app this path is inside app.asar, which Electron reads like a folder.
const SERVER_SCRIPT = path.join(__dirname, 'mcp', 'terra-mcp.js');
const RESTART = "Quit the Claude desktop app (Cmd+Q) and open it again to load Terra's tools.";

const defaultConfigPath = () => path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

// The binary running Terra: the app itself, or Electron under `npm start`. From plain
// Node (the npm scripts), require('electron') is the path of that same Electron.
const terraBinary = () => (process.versions.electron ? process.execPath : require('electron'));

function terraEntry(binary = terraBinary()) {
  return { command: binary, args: [SERVER_SCRIPT], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

function isTerraEntry(server) {
  if (!server || typeof server !== 'object') return false;
  const parts = [server.command, ...(Array.isArray(server.args) ? server.args : [])];
  return parts.some((p) => typeof p === 'string' && p.includes(MARKER));
}

// Places that are gone after a restart or an eject, so not worth pointing Claude at.
function temporaryPlace(binary) {
  if (binary.includes('/AppTranslocation/')) return 'from a temporary copy macOS made of it (App Translocation)';
  if (/^\/Volumes\/Terra[^/]*\/Terra\.app\//.test(binary)) return 'from its disk image';
  return null;
}

const show = (name, server) => `  ${name}: ${JSON.stringify(server)}`;
const refuse = (message) => ({ code: 1, text: `Error: ${message}\nNothing was changed.` });

// Reads the config, following a symlink to the real file. Throws InstallError.
function readConfig(file) {
  const target = readJson(file);
  const servers = target.data.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) {
    throw new InstallError(`"mcpServers" in ${target.real} is not an object`);
  }
  return target;
}

// Merge only: every other server and setting is left as it is. Safe to run again.
// Returns { code, text }.
function install(configFile = defaultConfigPath(), binary = terraBinary()) {
  const where = temporaryPlace(binary);
  if (where) return refuse(`Terra is running ${where}:\n  ${binary}\nMove Terra to Applications, open it from there, and install again.`);
  let target;
  try {
    target = readConfig(configFile);
  } catch (err) {
    if (err instanceof InstallError) return refuse(err.message);
    throw err;
  }
  const servers = target.data.mcpServers || {};
  // Not printed: a server of yours may hold keys in its env.
  if (Object.hasOwn(servers, NAME) && !isTerraEntry(servers[NAME])) {
    return refuse(`${target.real} already has a server called "${NAME}" that isn't Terra's.\nRename or remove it, then install again.`);
  }
  const want = terraEntry(binary);
  const lines = [describeFile('Config', target)];
  // Terra's entry under another name (renamed by hand, say) would be a duplicate.
  const elsewhere = Object.keys(servers).filter((name) => name !== NAME && isTerraEntry(servers[name]));
  if (same(servers[NAME], want) && !elsewhere.length) {
    lines.push('Terra is already installed. Config not changed, no backup needed.');
    return { code: 0, text: lines.join('\n') };
  }
  const removed = elsewhere.map((name) => show(name, servers[name]));
  if (servers[NAME] !== undefined) removed.unshift(show(NAME, servers[NAME]));
  for (const name of elsewhere) delete servers[name];
  servers[NAME] = want;
  target.data.mcpServers = servers;
  const backup = writeJson(target);
  if (backup) lines.push(`Backup:   ${backup}`);
  if (removed.length) lines.push(`Removed (old Terra entries):\n${removed.join('\n')}`);
  lines.push(`Added:\n${show(NAME, want)}`);
  lines.push('Nothing else in the file was changed.');
  lines.push(RESTART);
  return { code: 0, text: lines.join('\n') };
}

// Only Terra's entries go; every other server and setting is left as it is. Returns { code, text }.
function uninstall(configFile = defaultConfigPath()) {
  let target;
  try {
    target = readConfig(configFile);
  } catch (err) {
    if (err instanceof InstallError) return refuse(err.message);
    throw err;
  }
  const lines = [describeFile('Config', target)];
  const servers = target.data.mcpServers || {};
  const mine = Object.keys(servers).filter((name) => isTerraEntry(servers[name]));
  if (!mine.length) {
    lines.push('Terra is not in the config. Not changed, no backup needed.');
    return { code: 0, text: lines.join('\n') };
  }
  const removed = mine.map((name) => show(name, servers[name]));
  for (const name of mine) delete servers[name];
  // Drop "mcpServers" only when removing Terra emptied it.
  if (Object.keys(servers).length) target.data.mcpServers = servers;
  else delete target.data.mcpServers;
  const backup = writeJson(target);
  if (backup) lines.push(`Backup:   ${backup}`);
  lines.push(`Removed:\n${removed.join('\n')}`);
  lines.push('Nothing else in the file was changed.');
  lines.push("Quit the Claude desktop app (Cmd+Q) and open it again to unload Terra's tools.");
  return { code: 0, text: lines.join('\n') };
}

// Reads the config (never writes it) and says whether Terra's server is in place:
// 'installed', 'not installed', 'needs update' (it points at another copy of Terra, or
// there is more than one) or 'unreadable'.
function status(configFile = defaultConfigPath(), binary = terraBinary()) {
  let config;
  try {
    const raw = fs.readFileSync(configFile, 'utf8');
    config = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    return err.code === 'ENOENT' ? 'not installed' : 'unreadable';
  }
  const servers = (config && typeof config.mcpServers === 'object' && config.mcpServers) || {};
  const mine = Object.keys(servers).filter((name) => isTerraEntry(servers[name]));
  if (!mine.length) return 'not installed';
  return mine.length === 1 && mine[0] === NAME && same(servers[NAME], terraEntry(binary)) ? 'installed' : 'needs update';
}

// `--config <path>` on the command line, or the Claude desktop app's config.
function configPathFromArgs(argv) {
  const i = argv.indexOf('--config');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return defaultConfigPath();
}

module.exports = {
  NAME, SERVER_SCRIPT, defaultConfigPath, terraEntry, isTerraEntry, install, uninstall, status, configPathFromArgs,
};
