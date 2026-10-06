// Is the Claude desktop app running? Asked of Launch Services with /usr/bin/lsappinfo,
// which comes with macOS and needs no permissions (no Accessibility, no Automation).
// One call takes about 10 ms.
//
// main.js reads isRunning and POLL_MS through this module object at call time, so the
// tests can put a fake in their place.
const { execFile } = require('node:child_process');

// From /Applications/Claude.app/Contents/Info.plist. Claude Code's own helper apps have
// other identifiers (com.anthropic.claude-code, com.anthropic.claude-code-url-handler).
const BUNDLE_ID = 'com.anthropic.claudefordesktop';
const POLL_MS = 3000;

// `lsappinfo find bundleid=<id>` prints the app's ASN (`ASN:0x0-0x...:`) when it runs,
// and nothing when it doesn't.
const parse = (stdout) => /^ASN:/m.test(stdout);

// Resolves true or false, or null if lsappinfo couldn't answer.
function isRunning() {
  return new Promise((resolve) => {
    execFile('/usr/bin/lsappinfo', ['find', `bundleid=${BUNDLE_ID}`], { timeout: 2000 }, (err, stdout) => {
      resolve(err ? null : parse(stdout));
    });
  });
}

module.exports = { BUNDLE_ID, POLL_MS, parse, isRunning };
