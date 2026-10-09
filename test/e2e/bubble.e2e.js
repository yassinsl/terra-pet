// The speech bubble (terra_say), end to end in the real app: POST /say (as the MCP server
// sends it) -> the pet's queue -> the bubble window. Its pixels against
// design/terra-bubble-assets/examples-1x and examples-4x, trimming, HTML shown as plain
// text, flipping at the screen edges and following the pet, the timer, a click to dismiss,
// a new message replacing the old, the pet talking meanwhile, and the tray checkbox.
// Run: npx electron test/e2e/bubble.e2e.js   (or npm test)
const {
  ROOT, t, check, section, wait, js, menuItem, subItem, waitFor, attempt, start, BrowserWindow, fs, path,
} = require('./lib.js');
const { PROMPT_MARK } = require('../lib.js');
const { nativeImage, screen } = require('electron');
const { FONT, TIMING, layoutBubble } = require(path.join(ROOT, 'bubble-layout.js'));

const EXAMPLES = path.join(ROOT, 'design', 'terra-bubble-assets');
const json = (v) => JSON.stringify(v);

let bubbleWin = null;
const bjs = (code) => bubbleWin.webContents.executeJavaScript(code);
const phase = () => bjs('phase');

async function say(text) {
  const port = fs.readFileSync(path.join(process.env.HOME, '.terra-pet', 'port'), 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${port}/say`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  return r.status;
}

async function waitPhase(want, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await phase()) === want) return true;
    await wait(10);
  }
  return false;
}

// Waits until no bubble shows (and the pet has finished talking).
async function quiet() {
  await waitPhase('hidden', 12000);
  await waitFor('idle', 6000);
  await wait(200);
}

// A PNG as RGBA rows (nativeImage gives BGRA).
function rgbaOf(image) {
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([bgra[i + 2], bgra[i + 1], bgra[i], bgra[i + 3]], i);
  return { width, height, data };
}

// Differing pixels between two RGBA images of the same size (transparent counts as equal
// whatever its colour); -1 when the sizes differ.
function differ(a, b) {
  if (a.width !== b.width || a.height !== b.height) return -1;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (!a.data[i + 3] && !b.data[i + 3]) continue;
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) n++;
  }
  return n;
}

// The picture the bubble page put together, at 1x.
async function frame1x() {
  const f = await bjs('frame && { width: frame.width, height: frame.height, data: Array.from(frame.data) }');
  return f && { ...f, data: Uint8Array.from(f.data) };
}

// Puts the pet so its window's left edge is at x (on the pet's display), still at the bottom.
async function petAt(x) {
  const b = t.win.getBounds();
  await js(`window.terra.moveWindow(${x}, ${b.y})`); // the path walking and dragging take
  await wait(150);
}

start(async () => {
  bubbleWin = BrowserWindow.getAllWindows().find((w) => w !== t.win && /bubble\.html$/.test(w.webContents.getURL()));
  const wa = screen.getDisplayMatching(t.win.getBounds()).workArea;
  menuItem('Patrol').click(); // keep the pet still while testing
  await waitFor('idle', 4000);

  section('the bubble window');
  check('a window of its own, hidden until needed', !!bubbleWin && !bubbleWin.isVisible() && bubbleWin !== t.win, bubbleWin ? bubbleWin.webContents.getURL().replace(/^.*\/renderer\//, 'renderer/') : 'none');
  check('never takes focus, above the pet, passes the mouse through', bubbleWin.isFocusable() === false && bubbleWin.isAlwaysOnTop(), `focusable ${bubbleWin.isFocusable()}`);
  const menu = menuItem('Speech bubbles');
  check('tray: "Speech bubbles", a checkbox, on by default', menu && menu.type === 'checkbox' && menu.checked === true);

  section('pixels: examples-1x, exactly');
  subItem('Size', '4x').click();
  await wait(300);
  const middle = wa.x + Math.round(wa.width / 2) - 128;
  for (const [text, file, x] of [['Tokyo!', 'tokyo', middle], ['Happy to help!', 'happy-to-help', middle],
    ['Paris is the capital of France!', 'paris', middle], ['Hi rabbit!', 'hi-rabbit-left', wa.x - 20]]) {
    await quiet();
    await petAt(x);
    const status = await say(text);
    const full = await waitPhase('full');
    const got = await frame1x();
    const want = rgbaOf(nativeImage.createFromPath(path.join(EXAMPLES, 'examples-1x', `${file}.png`)));
    const tail = await bjs('bubble && current.tail');
    const off = got ? differ(got, want) : -1;
    check(`  "${text}" = ${file}.png`, status === 204 && full && off === 0 && tail === (file.endsWith('left') ? 'left' : 'right'),
      `HTTP ${status}; ${got ? `${got.width}x${got.height}` : 'no frame'} vs ${want.width}x${want.height}, ${off < 0 ? 'sizes differ' : `${off} pixels differ`}, tail ${tail}`);
    if (file === 'tokyo') {
      // The window on screen at 4x: examples-4x, each art pixel a block of device pixels.
      const shot = rgbaOf(await bubbleWin.webContents.capturePage());
      const want4 = rgbaOf(nativeImage.createFromPath(path.join(EXAMPLES, 'examples-4x', 'tokyo.png')));
      const k = shot.width / want4.width; // device pixels per 4x pixel
      const sampled = { width: want4.width, height: want4.height, data: new Uint8Array(want4.data.length) };
      let blocky = 0;
      for (let y = 0; y < want4.height; y++) {
        for (let xx = 0; xx < want4.width; xx++) {
          const s = ((y * k) * shot.width + xx * k) * 4;
          sampled.data.set(shot.data.subarray(s, s + 4), (y * want4.width + xx) * 4);
          for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
            const o = (((y * k + j) * shot.width) + xx * k + i) * 4;
            if (shot.data[o + 3] !== shot.data[s + 3] || (shot.data[s + 3] && (shot.data[o] !== shot.data[s] || shot.data[o + 1] !== shot.data[s + 1] || shot.data[o + 2] !== shot.data[s + 2]))) blocky++;
          }
        }
      }
      const off4 = Number.isInteger(k) ? differ(sampled, want4) : -1;
      check('  on screen at 4x = examples-4x/tokyo.png, nearest neighbour', off4 === 0 && blocky === 0 && bubbleWin.getBounds().width === 172,
        `window ${json(bubbleWin.getBounds())}, capture ${shot.width}x${shot.height} (${k}x${k} device pixels a 4x pixel), ${off4} pixels differ, ${blocky} blurred`);
    }
  }

  section('sizes: nearest neighbour only');
  for (const size of ['Match small (2.25x)', '1.5x', '1x']) {
    await quiet();
    subItem('Size', size).click();
    await wait(300);
    await petAt(middle);
    await say('Tokyo!');
    await waitPhase('full');
    await wait(50);
    const scale = await bjs('current.scale');
    const shot = rgbaOf(await bubbleWin.webContents.capturePage());
    const art = rgbaOf(nativeImage.createFromPath(path.join(EXAMPLES, 'examples-1x', 'tokyo.png')));
    const px = shot.width / Math.round(art.width * scale); // device pixels per point
    // Each device pixel shows the art pixel under it: floor(x / (scale * ratio)).
    const mapped = { width: shot.width, height: shot.height, data: new Uint8Array(shot.data.length) };
    for (let y = 0; y < shot.height; y++) {
      for (let x = 0; x < shot.width; x++) {
        const s = (Math.min(art.height - 1, Math.floor(y / (scale * px))) * art.width + Math.min(art.width - 1, Math.floor(x / (scale * px)))) * 4;
        mapped.data.set(art.data.subarray(s, s + 4), (y * shot.width + x) * 4);
      }
    }
    const b = bubbleWin.getBounds();
    const off = differ(shot, mapped);
    check(`  ${size}: window ${Math.round(43 * scale)}x${Math.round(20 * scale)}, every device pixel an art pixel`, off === 0 && b.width === Math.round(43 * scale) && b.height === Math.round(20 * scale),
      `window ${b.width}x${b.height}, capture ${shot.width}x${shot.height}, ${off} pixels differ from the nearest-neighbour map`);
  }
  subItem('Size', '4x').click();
  await wait(300);

  section('text');
  await quiet();
  await petAt(middle);
  {
    const long = 'The quick brown fox jumps over the lazy dog, again and again, all day long';
    await say(long);
    await waitPhase('full');
    const b = await bjs('({ glyphs: current.glyphs, height: current.height })');
    const dot = FONT.glyphs['.'];
    const lastThree = b.glyphs.slice(-3).every((g) => g.sx === dot.x && g.y === 13);
    const lines = layoutBubble(long).lines;
    check('long text: 2 lines, the second ends with "..."', b.height === 25 && lastThree && lines.length === 2 && lines.every((l) => l.length <= 20), lines.join(' / '));
  }
  await quiet();
  {
    const html = '<img src=x onerror="window.pwned=1"><b>Hi</b> & <script>window.pwned=2</script>';
    const status = await say(html);
    await waitPhase('full');
    const page = await bjs("({ pwned: window.pwned, tags: [...document.querySelectorAll('*')].map((e) => e.tagName).join(' '), hasText: document.documentElement.outerHTML.includes('onerror') })");
    const petPwned = await js('window.pwned');
    const want = layoutBubble(html);
    const drawn = await bjs('current.glyphs.length');
    check('HTML is drawn as plain text, never run or added to the page', status === 204 && page.pwned === undefined && petPwned === undefined && !page.hasText
      && page.tags === 'HTML HEAD META META TITLE STYLE BODY CANVAS SCRIPT' && drawn === want.glyphs.length,
      `shows "${want.lines.join(' / ')}" (${drawn} glyphs); page elements: ${page.tags}`);
  }
  await quiet();
  {
    const status = await say('😀 🎉 ✨');
    await wait(300);
    check('nothing drawable (emoji only): HTTP 422, no bubble', status === 422 && (await phase()) === 'hidden' && !bubbleWin.isVisible(), `HTTP ${status}`);
  }

  section('placement: above-left, flipped at the left edge, following the pet');
  {
    await quiet();
    await petAt(middle);
    await say('Happy to help!');
    await waitPhase('full');
    const at = () => ({ pet: t.win.getBounds(), bubble: bubbleWin.getBounds() });
    let p = at();
    // Art: the bubble's right edge at the pet window's middle, its top 34 - 16 art px down.
    const leftOk = p.bubble.x + p.bubble.width === p.pet.x + 32 * 4 && p.bubble.y === p.pet.y + 18 * 4 && (await bjs('current.tail')) === 'right';
    check('  above-left of the head, tail on the right', leftOk, `pet ${json(p.pet)}, bubble ${json(p.bubble)}`);
    const flipX = wa.x + 87 * 4 - 32 * 4 - 4; // the left side would end 4 points off screen
    await petAt(flipX);
    p = at();
    const flipped = (await bjs('current.tail')) === 'left' && p.bubble.x === p.pet.x + 36 * 4 && p.bubble.x >= wa.x;
    check('  near the left edge: flipped to the right, tail on the left', flipped, `pet x ${p.pet.x}, bubble ${json(p.bubble)}, work area from x ${wa.x}`);
    await petAt(flipX + 8);
    p = at();
    check('  room again: back above-left', (await bjs('current.tail')) === 'right' && p.bubble.x >= wa.x && p.bubble.x + p.bubble.width === p.pet.x + 128, `bubble ${json(p.bubble)}`);
    const right = wa.x + wa.width - 256 + 20;
    await petAt(right);
    p = at();
    check('  near the right edge: stays above-left', (await bjs('current.tail')) === 'right' && p.bubble.x + p.bubble.width <= wa.x + wa.width, `pet x ${p.pet.x}, bubble ${json(p.bubble)}`);
    const moves = [];
    for (let k = 1; k <= 5; k++) {
      await petAt(middle - 40 * k);
      p = at();
      moves.push(p.bubble.x + p.bubble.width - (p.pet.x + 128));
    }
    check('  follows the pet as it moves (the walk and drag path)', moves.every((d) => d === 0), `offsets ${moves.join(', ')}`);
    await petAt(middle);
  }

  section('timing');
  await quiet();
  await attempt('pop-in 80 ms, hold 4 s + 50 ms a character, fade 200 ms', async () => {
    await quiet();
    const text = 'Tokyo!';
    const hold = layoutBubble(text).holdMs;
    const seen = [];
    let last = null;
    let popFrame = null;
    const t0 = Date.now();
    await say(text);
    while (Date.now() - t0 < hold + 1500) {
      const p = await phase();
      if (p !== last && (seen.length || p !== 'hidden')) { // from the first frame shown
        seen.push([p, Date.now() - t0]);
        last = p;
      }
      if (p === 'pop' && !popFrame) popFrame = await frame1x();
      if (p === 'hidden' && seen.length > 1) break;
      await wait(5);
    }
    const at = Object.fromEntries(seen.map(([p, ms]) => [p, ms]));
    const popMs = at.full - at.pop;
    const holdMs = at.fade - at.full;
    const fadeMs = at.hidden - at.fade;
    // The pop-in frame: pop-in-right.png with its tip on the full bubble's tip.
    let popOk = false;
    if (popFrame) {
      const pop = rgbaOf(nativeImage.createFromPath(path.join(ROOT, 'Bot', 'bubble', 'pop-in-right.png')));
      const want = { width: popFrame.width, height: popFrame.height, data: new Uint8Array(popFrame.data.length) };
      for (let y = 0; y < pop.height; y++) want.data.set(pop.data.subarray(y * pop.width * 4, (y + 1) * pop.width * 4), ((y + 6) * popFrame.width + 27) * 4);
      popOk = differ(popFrame, want) === 0;
    }
    const ok = seen.map(([p]) => p).join(' ') === 'pop full fade hidden' && Math.abs(popMs - TIMING.popMs) <= 40 && Math.abs(holdMs - hold) <= 80 && Math.abs(fadeMs - TIMING.fadeMs) <= 60 && popOk;
    return { ok, line: `${seen.map(([p, ms]) => `${p} at ${ms}`).join(', ')} ms: pop ${popMs}, hold ${holdMs} (want ${hold}), fade ${fadeMs}; pop-in frame ${popFrame ? (popOk ? 'matches pop-in-right.png' : 'differs') : 'not seen'}` };
  });
  check('  a longer text holds longer: 2 lines', layoutBubble('Paris is the capital of France!').holdMs === 4000 + 50 * 30, `${layoutBubble('Paris is the capital of France!').holdMs} ms`);

  section('the pet talks meanwhile');
  await quiet();
  {
    const from = t.states.length;
    await say('Happy to help!');
    await waitPhase('full');
    const during = await js('state');
    const emote = await js('emote && emote.name');
    await quiet();
    const seen = t.states.slice(from).map((s) => s.state).filter((s, i, a) => i === 0 || s !== a[i - 1]);
    check('  from idle: talk (no talk emote) while it shows, then idle', during === 'talk' && emote === null && seen.join(' ') === 'talk idle', seen.join(' -> '));
  }
  {
    // As Claude does it: working, say, done.
    const port = fs.readFileSync(path.join(process.env.HOME, '.terra-pet', 'port'), 'utf8').trim();
    const mcp = (body) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const from = t.states.length;
    await mcp({ state: 'working' });
    await say('Paris!');
    await mcp({ state: 'done', mood: 'happy' });
    await waitFor('idle', 15000, from + 3);
    await wait(300);
    const seen = t.states.slice(from).map((s) => s.state).filter((s, i, a) => i === 0 || s !== a[i - 1]);
    check('  working, say, done: sits, stands, talks with the bubble, then stars', seen.join(' ') === 'sitDown work standUp talk happy idle', seen.join(' -> '));
  }

  section('a click dismisses it; a new message replaces it');
  await quiet();
  {
    await say('Happy to help!');
    await waitPhase('full');
    const b = bubbleWin.getBounds();
    const click = (x, y) => {
      bubbleWin.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      bubbleWin.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      bubbleWin.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    };
    click(4, b.height - 4); // bottom-left corner, beside the tail: transparent
    await wait(150);
    const stillThere = await phase();
    bubbleWin.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(b.width / 2), y: 40 });
    await wait(100);
    const caught = await bjs('mouseOn');
    const t0 = Date.now();
    click(Math.round(b.width / 2), 40);
    const fading = await waitPhase('fade', 500);
    const gone = await waitPhase('hidden', 1000);
    const ms = Date.now() - t0;
    await waitFor('idle', 3000);
    check('  a click beside it does nothing; on it, it fades out at once', stillThere === 'full' && caught === true && fading && gone && ms < 450 && !bubbleWin.isVisible() && (await js('state')) === 'idle',
      `beside: still ${stillThere}; over it the mouse is caught=${caught}; on it: gone after ${ms} ms, pet ${await js('state')}`);
  }
  await quiet();
  {
    await say('Tokyo!');
    await waitPhase('full');
    await wait(1000);
    const t0 = Date.now();
    await say('Paris is the capital of France!');
    await wait(150);
    const b = await bjs('({ height: current.height, phase })');
    const talking = await js('state');
    await waitPhase('hidden', 12000);
    const ms = Date.now() - t0;
    const hold = TIMING.popMs + layoutBubble('Paris is the capital of France!').holdMs + TIMING.fadeMs;
    check('  a new message replaces the old one at once, with its own time', b.height === 25 && talking === 'talk' && Math.abs(ms - hold) < 250,
      `2-line bubble ${b.height === 25 ? 'shown' : 'not shown'} (${b.phase}), pet ${talking}; gone ${ms} ms later (want ~${hold})`);
  }

  section('tray: Speech bubbles off');
  await quiet();
  {
    menuItem('Speech bubbles').click();
    await wait(200);
    const prefs = JSON.parse(fs.readFileSync(path.join(t.userData, 'preferences.json'), 'utf8'));
    const status = await say('Tokyo!');
    await wait(300);
    const off = status === 409 && (await phase()) === 'hidden' && (await js('state')) === 'idle';
    menuItem('Speech bubbles').click();
    await wait(200);
    const again = await say('Tokyo!');
    const back = await waitPhase('full');
    check('  off: HTTP 409, no bubble, remembered; on again: shows', off && prefs.speechBubbles === false && again === 204 && back && menuItem('Speech bubbles').checked,
      `off: HTTP ${status}, saved ${json({ speechBubbles: prefs.speechBubbles })}; on: HTTP ${again}`);
  }

  section('privacy');
  await quiet();
  {
    await say(`Hi ${PROMPT_MARK}`);
    await waitPhase('full');
    await quiet();
    const files = [];
    const scan = (dir) => {
      for (const n of fs.readdirSync(dir)) {
        const p = path.join(dir, n);
        const st = fs.lstatSync(p); // Electron's Singleton* entries are links to nowhere
        if (st.isDirectory()) scan(p);
        else if (st.isFile() && st.size < 5e6 && fs.readFileSync(p).includes(PROMPT_MARK.slice(0, 12))) files.push(p);
      }
    };
    scan(t.userData);
    scan(process.env.HOME);
    check('  the text is in no file Terra writes (npm test also checks every log)', files.length === 0, files.length ? files.join(', ') : `searched ${t.userData.replace(/^.*\//, '')} and the test HOME`);
  }
});
