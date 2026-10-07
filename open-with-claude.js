// "Open and close with Claude desktop" (a tray checkbox, on by default). Kept in
// ~/.terra-pet/claude.json because two processes read it: the pet, and the MCP server
// (mcp/terra-mcp.js) that Claude desktop starts, which opens the pet when it isn't running.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const QUIT_AFTER_MS = 5000; // after Claude desktop quits, before a pet it opened quits too
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/; // how an MCP server names itself to the pet

const settingsFile = () => path.join(os.homedir(), '.terra-pet', 'claude.json');

function isEnabled() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).openWithClaude !== false;
  } catch {
    return true; // never set: on
  }
}

function setEnabled(on) {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ openWithClaude: !!on })}\n`);
  fs.renameSync(tmp, file);
}

module.exports = { QUIT_AFTER_MS, SESSION_ID, settingsFile, isEnabled, setEnabled };
