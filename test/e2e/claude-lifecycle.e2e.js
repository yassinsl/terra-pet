// The pet's side of opening and closing with Claude desktop, inside the app: a pet opened
// by the MCP server (--opened-by-claude) says hi when ready, and quits 5 s after the last
// server says goodbye, unless one says hello in time, or the menu checkbox is off.
// (open-with-claude.test.js covers the same with real servers and real pets.)
// Run: npx electron test/e2e/claude-lifecycle.e2e.js   (or npm test)
process.argv.push('--opened-by-claude'); // as mcp/pet-launcher.js opens it

const { ROOT, t, check, section, wait, menuItem, takeFrames, start, fs, path } = require('./lib.js');
const { app } = require('electron');
const { spawn } = require('node:child_process');
const openWithClaude = require(path.join(ROOT, 'open-with-claude.js'));

const quits = [];
app.quit = () => quits.push(Date.now()); // record instead of ending the test

const tell = (action, id) => new Promise((resolve) => {
  const port = fs.readFileSync(path.join(process.env.HOME, '.terra-pet', 'port'), 'utf8').trim();
  const p = spawn('curl', ['-q', '-s', '--noproxy', '*', '--max-time', '2', '-H', 'Content-Type: application/json',
    '--data-binary', JSON.stringify({ action, id }), `http://127.0.0.1:${port}/server`]);
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', () => {
    try {
      resolve(JSON.parse(out));
    } catch {
      resolve({ raw: out });
    }
  });
});

start(async () => {
  section('opened by Claude');
  {
    // The page was reloaded once by the test setup, so its start-up shows again from here.
    await wait(1200);
    const frames = await takeFrames();
    const emotes = [...new Set(frames.filter((f) => f.emote).map((f) => f.emote.replace(/-\d+$/, '')))];
    const states = [...new Set(t.states.map((s) => s.state))];
    check('says hi once ready (not the usual wave alone)', emotes.includes('hi') && states.includes('wave'), `emotes ${emotes.join(',') || 'none'}, states ${states.join(' -> ')}`);
    const ping = await tell('ping', 'test-session-0');
    check('says it was opened by Claude', ping.openedByClaude === true && ping.sessions === 0 && ping.pid === process.pid, JSON.stringify(ping));
    const box = menuItem('Open and close with Claude desktop');
    check('menu checkbox, on by default', box && box.type === 'checkbox' && box.checked, box ? `checked ${box.checked}` : 'missing');
  }

  section('closing with Claude');
  {
    await tell('hello', 'session-aaaa-1');
    const t0 = Date.now();
    const bye = await tell('bye', 'session-aaaa-1');
    await wait(5600);
    check('last server gone: quits 5 s later', bye.quitting === true && quits.length === 1 && Math.abs(quits[0] - t0 - 5000) < 400, `quitting ${bye.quitting}; quit asked ${quits.length ? quits[0] - t0 : '-'} ms later`);

    await tell('hello', 'session-bbbb-1'); // (the recorded quit didn't end the app; start over)
    await tell('hello', 'session-cccc-1');
    await tell('bye', 'session-bbbb-1');
    await wait(5600);
    check('one of two servers gone: stays', quits.length === 1, `${quits.length - 1} more quits`);
    await tell('bye', 'session-cccc-1');
    await wait(2000);
    const back = await tell('hello', 'session-dddd-1'); // Claude back within 5 s
    await wait(4500);
    check('Claude back within 5 s: the quit is called off', quits.length === 1 && back.quitting === false && back.sessions === 1, `${quits.length - 1} more quits; ${JSON.stringify(back)}`);

    menuItem('Open and close with Claude desktop').click();
    const saved = JSON.parse(fs.readFileSync(openWithClaude.settingsFile(), 'utf8'));
    await tell('bye', 'session-dddd-1');
    await wait(5600);
    check('checkbox off: saved, and Claude quitting leaves the pet', saved.openWithClaude === false && quits.length === 1, `claude.json ${JSON.stringify(saved)}; ${quits.length - 1} more quits`);
    menuItem('Open and close with Claude desktop').click();
    check('checkbox back on', openWithClaude.isEnabled());
  }

  section('the /server route takes nothing else');
  {
    const bad = await tell('explode', 'session-eeee-1');
    const badId = await tell('hello', 'no spaces allowed!');
    check('unknown action or bad id: refused', !bad.pid && !badId.pid, `${JSON.stringify(bad)} / ${JSON.stringify(badId)}`);
  }
});
