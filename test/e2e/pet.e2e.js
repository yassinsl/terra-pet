// The pet itself: window, all animations and reactions from the tray, emote alignment,
// idle behaviour, clicks, drag, click-through, sleep and patrol.
// Run: npx electron test/e2e/pet.e2e.js   (or npm test)
const {
  ROOT, ANIMATIONS, EMOTES, t, check, section, wait, js, current, menuItem, subItem, clipMs,
  takeFrames, segments, emoteRuns, waitFor, attempt, start, BrowserWindow, fs, path,
} = require('./lib.js');
const { screen, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const ws = require(path.join(ROOT, 'window-state.js'));

const OUT = path.join(require('node:os').tmpdir(), 'terra-e2e-captures');
fs.mkdirSync(OUT, { recursive: true });
const PET = { x: 32, y: 112, width: 192, height: 208 }; // in the 256x320 window
const TOL = 34; // ms; frames land on 60 Hz ticks
const HOOKS_NEEDS_UPDATE = 'Hooks: installed, needs update (install again)';

// Frame order, per-frame timing, play count and what comes next, for one pet animation.
function checkAnimation(name, frames, { expectEmote = false } = {}) {
  const a = ANIMATIONS[name];
  const ms = clipMs(a);
  const segs = segments(frames);
  const seg = segs[0];
  const errs = [];
  if (!seg || seg.row !== a.row) return { ok: false, line: `first row drawn was ${seg && seg.row}, expected ${a.row}` };
  // Only pet-frame changes count (emote changes also redraw).
  const changes = seg.items.filter((f, i, all) => i === 0 || f.frame !== all[i - 1].frame);
  const fr = changes.map((f) => f.frame);
  fr.forEach((f, i) => { if (f !== i % a.frames) errs.push(`frame #${i} was ${f}`); });
  let maxErr = 0;
  for (let i = 0; i + 1 < changes.length; i++) maxErr = Math.max(maxErr, Math.abs(changes[i + 1].t - changes[i].t - ms[changes[i].frame]));
  if (maxErr > TOL) errs.push(`timing off by up to ${maxErr.toFixed(0)} ms`);
  if (!expectEmote && seg.items.some((f) => f.emote)) errs.push('an emote was drawn');
  const plays = fr.filter((f) => f === 0).length;
  let after;
  if (a.loop) {
    if (plays < 2) errs.push(`only ${plays} loop(s)`);
    if (segs.length > 1) errs.push(`interrupted by row ${segs[1].row}`);
    after = `looping, ${plays} cycles`;
  } else {
    if (plays !== a.plays) errs.push(`played ${plays}x, expected ${a.plays}`);
    const nextSeg = segs[1];
    if (!nextSeg || nextSeg.row !== ANIMATIONS[a.next].row) errs.push(`then row ${nextSeg && nextSeg.row}, expected ${a.next}`);
    else {
      const held = nextSeg.items[0].t - changes[changes.length - 1].t;
      if (Math.abs(held - ms[a.frames - 1]) > TOL) errs.push(`last frame held ${held.toFixed(0)} ms`);
    }
    after = `${plays}x then ${a.next}`;
  }
  return { ok: !errs.length, line: `row ${a.row}, frames ${fr.slice(0, a.frames).join(',')}, ${after}, timing within ${maxErr.toFixed(0)} ms${errs.length ? ` -- ${errs.join('; ')}` : ''}` };
}

// Emote frames in order with their timing, drawn over the right pet animation, then removed.
function checkReaction(name, frames) {
  const def = EMOTES[name];
  const anim = ANIMATIONS[def.anim];
  const ms = clipMs(def);
  const errs = [];
  const segs = segments(frames);
  if (!segs[0] || segs[0].row !== anim.row) return { ok: false, line: `pet row ${segs[0] && segs[0].row}, expected ${def.anim} (row ${anim.row})` };
  const runs = emoteRuns(segs[0].items);
  const shown = runs.filter((r) => r.key);
  const want = Array.from({ length: def.frames }, (_, i) => `${name}-${i + 1}`);
  const cycle = want.join(' ');
  const keys = shown.map((r) => r.key);
  if (keys.slice(0, def.frames).join(' ') !== cycle) errs.push(`emote frames ${keys.slice(0, def.frames).join(' ')}`);
  let maxErr = 0;
  for (let i = 0; i + 1 < runs.length && i < def.frames; i++) {
    if (!runs[i].key) continue;
    const n = Number(runs[i].key.split('-').pop()) - 1;
    maxErr = Math.max(maxErr, Math.abs(runs[i + 1].t - runs[i].t - ms[n]));
  }
  if (maxErr > TOL) errs.push(`emote timing off by ${maxErr.toFixed(0)} ms`);
  const emoteTotal = ms.reduce((s, v) => s + v, 0);
  let line;
  if (def.loop) {
    const cycles = keys.filter((k) => k === `${name}-1`).length;
    if (cycles < 2) errs.push(`emote looped ${cycles}x`);
    if (segs.length > 1) errs.push(`pet left ${def.anim}`);
    line = `pet ${def.anim}, emote ${name}-1..${def.frames} looping (${cycles} cycles)`;
  } else {
    const firstT = segs[0].items[0].t;
    const removed = runs.find((r, i) => i > 0 && !r.key);
    const petTotal = clipMs(anim).reduce((s, v) => s + v, 0) * anim.plays;
    const nextAt = segs[1] ? segs[1].items[0].t - firstT : null;
    const removedAt = removed ? removed.t - firstT : nextAt; // removed with the state change
    if (keys.length !== def.frames) errs.push(`emote shown ${keys.length} frames`);
    if (removedAt === null || Math.abs(removedAt - emoteTotal) > TOL) errs.push(`emote removed at ${removedAt} ms (want ${emoteTotal})`);
    const wantNext = Math.max(petTotal, emoteTotal);
    if (nextAt === null || Math.abs(nextAt - wantNext) > TOL * 2) errs.push(`next state at ${nextAt} ms (want ${wantNext})`);
    if (segs[1] && segs[1].items.some((f) => f.emote)) errs.push('emote still drawn after the reaction');
    line = `pet ${def.anim}, emote ${name}-1..${def.frames} once, removed at ${Math.round(removedAt)} ms (want ${emoteTotal}), ${anim.next} at ${Math.round(nextAt)} ms (want ${wantNext})`;
  }
  return { ok: !errs.length, line: `${line}, timing within ${maxErr.toFixed(0)} ms${errs.length ? ` -- ${errs.join('; ')}` : ''}` };
}

async function click(x = 128, y = 216) {
  const [wx, wy] = t.win.getPosition();
  const g = { globalX: wx + x, globalY: wy + y };
  t.wc.sendInputEvent({ type: 'mouseDown', x, y, ...g, button: 'left', clickCount: 1 });
  await wait(30);
  t.wc.sendInputEvent({ type: 'mouseUp', x, y, ...g, button: 'left', clickCount: 1 });
  await wait(30);
}

// Compares a capture of the window with the expected picture: the sheet cell at (8,28)
// and the emote frame on top, both from the art files. Returns mismatching pixels.
async function compareCapture(png, row, frame, emote) {
  const toUrl = (p) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
  const helper = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await helper.loadURL('data:text/html,<canvas></canvas>');
  const result = await helper.webContents.executeJavaScript(`(async () => {
    const load = async (src) => { const i = new Image(); i.src = src; await i.decode(); return i; };
    const [cap, sheet, emo] = await Promise.all([load(${JSON.stringify(`data:image/png;base64,${png.toString('base64')}`)}),
      load(${JSON.stringify(toUrl(path.join(ROOT, 'Bot', 'spritesheet-x1.png')))}),
      ${emote ? `load(${JSON.stringify(toUrl(path.join(ROOT, 'Bot', 'reactions', 'emotes-only', `${emote}.png`)))})` : 'null'}]);
    const c = document.createElement('canvas'); c.width = 64; c.height = 80;
    const x = c.getContext('2d');
    x.drawImage(sheet, ${frame * 48}, ${row * 52}, 48, 52, 8, 28, 48, 52);
    if (emo) x.drawImage(emo, 0, 0);
    const want = x.getImageData(0, 0, 64, 80).data;
    const k = cap.width / 64;
    const d = document.createElement('canvas'); d.width = cap.width; d.height = cap.height;
    const y = d.getContext('2d'); y.drawImage(cap, 0, 0);
    const got = y.getImageData(0, 0, cap.width, cap.height).data;
    let off = 0, blocky = 0, opaque = 0;
    for (let py = 0; py < 80; py++) for (let px = 0; px < 64; px++) {
      const w = (py * 64 + px) * 4;
      const base = ((py * k) * cap.width + px * k) * 4;
      if (want[w + 3]) opaque++;
      const same = (i) => Math.abs(got[i] - want[w]) <= 2 && Math.abs(got[i + 1] - want[w + 1]) <= 2 && Math.abs(got[i + 2] - want[w + 2]) <= 2 && Math.abs(got[i + 3] - want[w + 3]) <= 2;
      const visibleBoth = want[w + 3] === 0 ? got[base + 3] === 0 : same(base);
      if (!visibleBoth) off++;
      for (let sy = 0; sy < k; sy++) for (let sx = 0; sx < k; sx++) {
        const i = (((py * k + sy) * cap.width) + px * k + sx) * 4;
        if (got[i] !== got[base] || got[i + 1] !== got[base + 1] || got[i + 2] !== got[base + 2] || got[i + 3] !== got[base + 3]) { blocky++; sy = k; break; }
      }
    }
    return { off, blocky, opaque, scale: k };
  })()`);
  helper.destroy();
  return result;
}

// Captures the window while a reaction shows, with the cell and emote frame on screen at that moment.
async function captureReaction(name) {
  subItem('Play reaction', name).click();
  await wait(EMOTES[name].frames > 6 ? 300 : 200);
  for (let tries = 0; tries < 8; tries++) {
    const before = await js('window.__draws.length');
    const png = (await t.wc.capturePage()).toPNG();
    const after = await js('window.__draws.length');
    if (before !== after) continue;
    // The last redraw is a pet cell, or a pet cell followed by an emote frame.
    const last = await js('window.__draws.slice(-2)');
    const emo = last[1][1] === 'e' ? last[1] : null;
    const pet = emo ? last[0] : last[1];
    if (pet[1] !== 'p') continue;
    fs.writeFileSync(path.join(OUT, `reaction-${name}.png`), png);
    return { png, row: pet[2], frame: pet[3], emote: emo ? `${emo[2]}-${emo[3]}` : null };
  }
  return null;
}

start(async () => {
  const wa = screen.getDisplayMatching(t.win.getBounds()).workArea;

  section('window');
  {
    const b = t.win.getBounds();
    const petAt = { x: b.x + PET.x, y: b.y + PET.y };
    const wantPet = { x: wa.x + wa.width - 24 - PET.width, y: wa.y + wa.height - 24 - PET.height };
    check('window is 256x320', b.width === 256 && b.height === 320, `${b.width}x${b.height}`);
    check('pet where it was in step 1 (bottom-right)', petAt.x === wantPet.x && petAt.y === wantPet.y, `pet at ${petAt.x},${petAt.y} (want ${wantPet.x},${wantPet.y}); window at ${b.x},${b.y}`);
    check('window bottom on the bottom margin', b.y + b.height === wa.y + wa.height - 24, `bottom ${b.y + b.height}, work area bottom ${wa.y + wa.height}`);
    check('starts ignoring the mouse, forwarding moves', t.ignoreCalls[0] && t.ignoreCalls[0].ignore && t.ignoreCalls[0].forward, JSON.stringify(t.ignoreCalls[0]));
  }

  section('startup');
  await wait(2200);
  await attempt('wave then idle', async (n) => {
    if (n > 1) { // same path the page takes once the sheet has loaded
      await takeFrames();
      await js("setState('wave')");
      await wait(2200);
    }
    return checkAnimation('wave', await takeFrames());
  });

  section('tray');
  const labels = t.trayMenu.items.map((i) => i.label || '---');
  check('menu items', /^Listening on 127\.0\.0\.1:\d+ \| Hooks: not installed \| Claude desktop: not installed \| --- \| Play animation \| Play reaction \| Back to idle \| --- \| Size \| Show Terra \| Speech bubbles \| Voice \| Sound \| Patrol \| Start at login \(packaged app only\) \| Open and close with Claude desktop \| --- \| Install in Claude desktop \| Uninstall from Claude desktop \| --- \| Quit$/.test(labels.join(' | ')), labels.join(' | '));
  const login = menuItem('Start at login (packaged app only)');
  check('Start at login: off and greyed out with npm start', login && !login.enabled && !login.checked, 'a login item must be an app; with npm start it would be Electron itself');
  {
    const icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'trayTemplate.png'));
    const { width, height } = icon.getSize();
    check('tray icon is a template image, 1x and 2x', icon.isTemplateImage() && icon.getScaleFactors().join() === '1,2' && width === 20 && height === 16, `template=${icon.isTemplateImage()}, scale factors ${icon.getScaleFactors()}, ${width}x${height} pt`);
  }
  const patrolDefault = menuItem('Patrol').checked;
  menuItem('Patrol').click();
  await wait(100);
  check('Patrol default on, then off', patrolDefault && (await js('patrolEnabled')) === false, `default ${patrolDefault}, now ${await js('patrolEnabled')}`);

  section('Play animation: all 19');
  const animNames = menuItem('Play animation').submenu.items.map((i) => i.label);
  check('submenu lists the 19', animNames.join() === Object.keys(ANIMATIONS).join(), animNames.join(' '));
  for (const name of animNames) {
    const a = ANIMATIONS[name];
    const cycle = clipMs(a).reduce((s, v) => s + v, 0);
    await attempt(`  ${name}`, async () => {
      const pre = name === 'think' ? 'talk' : 'think';
      subItem('Play animation', pre).click();
      await waitFor(pre, 1500);
      await wait(60);
      await takeFrames();
      subItem('Play animation', name).click();
      await wait(a.loop ? cycle * 2 + 200 : cycle * a.plays + 500);
      return checkAnimation(name, await takeFrames());
    });
  }

  section('Play reaction: all 8');
  const reactionNames = menuItem('Play reaction').submenu.items.map((i) => i.label);
  check('submenu lists the 8', reactionNames.join() === Object.keys(EMOTES).join(), reactionNames.join(' '));
  for (const name of reactionNames) {
    const def = EMOTES[name];
    const anim = ANIMATIONS[def.anim];
    const emoteTotal = clipMs(def).reduce((s, v) => s + v, 0);
    const petTotal = anim.loop ? 0 : clipMs(anim).reduce((s, v) => s + v, 0) * anim.plays;
    await attempt(`  ${name}`, async () => {
      subItem('Play animation', 'think').click();
      await waitFor('think', 1500);
      await wait(60);
      await takeFrames();
      subItem('Play reaction', name).click();
      await wait(def.loop ? emoteTotal * 2 + 250 : Math.max(emoteTotal, petTotal) + 400);
      const r = checkReaction(name, await takeFrames());
      if (!def.loop) return r;
      subItem('Play animation', 'idle').click(); // leaving the state removes the looping emote
      await wait(300);
      const after = await takeFrames();
      // From the switch to idle on (a frame may have been drawn just before the click).
      const fromIdle = after.slice(Math.max(0, after.findIndex((f) => f.row === 0)));
      const removed = fromIdle.length > 0 && fromIdle.every((f) => !f.emote) && fromIdle[0].row === 0;
      return { ok: r.ok && removed, line: `${r.line}; leaving ${def.anim}: ${removed ? 'emote removed' : `rows ${[...new Set(after.map((f) => f.row))].join(',')}, ${after.filter((f) => f.emote).length} emote frames`}` };
    });
  }

  section('emote lines up with the pet (captures)');
  for (const name of ['hi', 'love']) {
    const cap = await captureReaction(name);
    if (!cap) {
      check(`  ${name} capture`, false, 'could not get a stable frame');
      continue;
    }
    const cmp = await compareCapture(cap.png, cap.row, cap.frame, cap.emote);
    check(`  ${name}: capture matches cell at (8,28) + emote`, cmp.off === 0 && cmp.blocky === 0 && cap.emote,
      `pet row ${cap.row} frame ${cap.frame} + ${cap.emote}; ${cmp.off} of 5120 pixels differ, ${cmp.blocky} blurry blocks, ${cmp.scale}x${cmp.scale} screen pixels per art pixel; saved ${path.join(OUT, `reaction-${name}.png`)}`);
    await wait(2000);
  }

  section('leaving work plays sitDown backwards');
  await attempt('work -> stars: stand up first, emote after', async () => {
    subItem('Play animation', 'work').click();
    await wait(1200);
    await takeFrames();
    subItem('Play reaction', 'stars').click();
    await wait(4 * 130 + 200);
    const drawn = await takeFrames();
    const segs = segments(drawn.slice(Math.max(0, drawn.findIndex((f) => f.row !== 12)))); // work frames drawn before the click landed
    const s0 = segs[0];
    const fr = s0 ? s0.items.map((f) => f.frame).join(',') : '';
    const emoteDuringStandUp = s0 ? s0.items.some((f) => f.emote) : true;
    await wait(1800);
    return {
      ok: s0 && s0.row === 11 && fr === '3,2,1,0' && !emoteDuringStandUp && segs[1] && segs[1].row === 4 && segs[1].items[0].emote === 'stars-1',
      line: `row ${s0 && s0.row} frames ${fr}, then row ${segs[1] && segs[1].row} with ${segs[1] && segs[1].items[0].emote}`,
    };
  });

  section('idle blink');
  await attempt('row 8 frames 1,2,1 every 2.5-5 s', async () => {
    subItem('Play animation', 'idle').click();
    await wait(100);
    await takeFrames();
    await wait(11000);
    const f = await takeFrames();
    const blinks = [];
    for (let i = 0; i + 3 < f.length; i++) {
      const s = f.slice(i, i + 4);
      if (s[0].row === 8 && s[0].frame === 1 && s[1].row === 8 && s[1].frame === 2 && s[2].row === 8 && s[2].frame === 1 && s[3].row === 0) {
        blinks.push({ t: s[0].t, gaps: [s[1].t - s[0].t, s[2].t - s[1].t, s[3].t - s[2].t].map((g) => Math.round(g)) });
      }
    }
    const intervals = blinks.slice(1).map((b, i) => (b.t - blinks[i].t) / 1000);
    const ok = blinks.length >= 2 && intervals.every((s) => s >= 2.5 && s <= 5.3) && blinks.every((b) => Math.abs(b.gaps[0] - 60) < TOL && Math.abs(b.gaps[1] - 90) < TOL && Math.abs(b.gaps[2] - 60) < TOL);
    return { ok, line: `${blinks.length} blinks in 11 s, gaps ${blinks.map((b) => b.gaps.join('/')).join(' | ')} ms, intervals ${intervals.map((x) => x.toFixed(2)).join(', ')} s` };
  });

  section('mouse: only the pet catches it');
  {
    const from = t.ignoreCalls.length;
    const move = async (x, y) => { t.wc.sendInputEvent({ type: 'mouseMove', x, y }); await wait(80); };
    const spots = [['emote area', 128, 40, true], ['pet', 128, 216, false], ['emote area again', 128, 60, true], ['left margin', 10, 300, true],
      ['pet corner (32,112)', 32, 112, false], ['right margin', 240, 200, true], ['pet bottom edge', 200, 319, false], ['just above the pet', 128, 110, true]];
    const seen = [];
    for (const [label, x, y, ignore] of spots) {
      await move(x, y);
      const lastCall = t.ignoreCalls[t.ignoreCalls.length - 1];
      seen.push(`${label}: ${lastCall.ignore ? 'pass-through' : 'pet'}`);
      check(`  ${label} (${x},${y})`, lastCall.ignore === ignore && (!ignore || lastCall.forward), lastCall.ignore ? 'clicks pass through (moves still forwarded)' : 'window takes clicks');
    }
    t.wc.sendInputEvent({ type: 'mouseMove', x: 128, y: 216 });
    await wait(80);
    t.wc.sendInputEvent({ type: 'mouseLeave', x: 128, y: 330 });
    await wait(80);
    check('  pointer leaves the window', t.ignoreCalls[t.ignoreCalls.length - 1].ignore === true, `${t.ignoreCalls.length - from} setIgnoreMouseEvents calls in this test`);

    await takeFrames();
    for (const [x, y] of [[128, 40], [10, 300], [240, 150]]) await click(x, y);
    await wait(300);
    const rows = [...new Set((await takeFrames()).map((f) => f.row))];
    check('  clicks outside the pet do nothing', (await js('state')) === 'idle' && !rows.includes(13), `state ${await js('state')}, rows drawn ${rows.join(',')}`);
  }

  section('clicks');
  await attempt('single click -> love reaction', async () => {
    await waitFor('idle', 3000);
    await takeFrames();
    await click();
    await wait(2000);
    const f = await takeFrames();
    return checkReaction('love', f.slice(Math.max(0, f.findIndex((x) => x.row === 13)))); // idle frames drawn before the click landed
  });
  await wait(1700);
  await attempt('5 clicks in 1.5 s -> dizzy', async () => {
    await waitFor('idle', 3000);
    await wait(1600); // let earlier clicks age out of the 1.5 s window
    await takeFrames();
    for (let i = 0; i < 5; i++) { await click(); await wait(150); }
    await wait(6 * 440 + 400);
    const segs = segments(await takeFrames());
    const dizzy = segs.find((x) => x.row === 5);
    const plays = dizzy ? dizzy.items.filter((f) => f.frame === 0).length : 0;
    return { ok: dizzy && plays === 6 && segs[segs.length - 1].row === 0 && !dizzy.items.some((f) => f.emote), line: `rows ${segs.map((x) => x.row).join(' ')}; dizzy ${plays}x, no emote` };
  });
  await wait(1600);
  await takeFrames();
  for (let i = 0; i < 5; i++) { await click(); await wait(400); }
  await wait(300);
  {
    const rows = segments(await takeFrames()).map((s) => s.row);
    check('5 slow clicks: no dizzy', !rows.includes(5), `rows ${rows.join(' ')}`);
  }
  await waitFor('idle', 3000);
  await wait(300);

  section('drag');
  {
    await takeFrames();
    const [wx, wy] = t.win.getPosition();
    const send = (type, gx, gy, extra = {}) => t.wc.sendInputEvent({ type, x: 128, y: 216, globalX: gx, globalY: gy, button: 'left', ...extra });
    send('mouseDown', wx + 128, wy + 216, { clickCount: 1 });
    await wait(40);
    send('mouseMove', wx + 130, wy + 217, { modifiers: ['leftButtonDown'] });
    await wait(40);
    const p1 = t.win.getPosition();
    for (let k = 1; k <= 6; k++) {
      send('mouseMove', wx + 128 - 20 * k, wy + 216 - 10 * k, { modifiers: ['leftButtonDown'] });
      await wait(40);
    }
    send('mouseUp', wx + 8, wy + 156, { clickCount: 1 });
    await wait(400);
    const p2 = t.win.getPosition();
    const rows = [...new Set((await takeFrames()).map((f) => f.row))];
    check('drag moves the window, no click', p1[0] === wx && p1[1] === wy && p2[0] === wx - 120 && p2[1] === wy - 60 && !rows.includes(13),
      `start ${wx},${wy}; after 2 px wiggle ${p1}; after drag ${p2} (want ${wx - 120},${wy - 60})`);
  }

  section('sleep after 5 min idle, click wakes');
  await attempt('idle 5 min -> sleep -> click -> wave', async () => {
    await waitFor('idle', 3000);
    await takeFrames();
    await js('sleepClock -= 5 * 60 * 1000');
    const slept = await waitFor('sleep', 1000);
    await wait(1200);
    await click();
    await wait(3 * 640 + 400);
    const rows = segments(await takeFrames()).map((x) => x.row);
    return { ok: slept && rows[0] === 9 && rows[1] === 3 && rows[2] === 0, line: `rows ${rows.join(' ')}` };
  });

  section('patrol');
  {
    menuItem('Patrol').click();
    await wait(100);
    // The pet (not the transparent margin around it) stays inside the work area.
    const inside = (m) => m.x + PET.x >= wa.x && m.x + PET.x + PET.width <= wa.x + wa.width && m.y + PET.y >= wa.y && m.y + 320 <= wa.y + wa.height;
    for (let walkNo = 1; walkNo <= 2; walkNo++) await attempt(`walk #${walkNo}`, async () => {
      await waitFor('idle', 3000);
      const moves = [];
      const onMove = () => { const [x, y] = t.win.getPosition(); moves.push({ t: Date.now(), x, y }); };
      t.win.on('move', onMove);
      const startPos = t.win.getPosition();
      await js('nextPatrolAt = 0');
      await wait(300);
      const walkState = await js('state');
      const done = await waitFor('idle', 20000);
      t.win.off('move', onMove);
      const end = t.win.getPosition();
      const first = moves[0];
      const last = moves[moves.length - 1];
      const speed = Math.hypot(last.x - first.x, last.y - first.y) / ((last.t - first.t) / 1000);
      const allInside = moves.every(inside);
      const dirOk = walkState === (end[0] >= startPos[0] ? 'walkR' : 'walkL');
      const bottomOk = end[1] + 320 === wa.y + wa.height - 24;
      return {
        ok: done && dirOk && allInside && bottomOk && Math.abs(speed - 96) < 8,
        line: `${walkState} from ${startPos} to ${end}, ${speed.toFixed(1)} px/s, pet inside work area=${allInside}, window bottom on the bottom margin=${bottomOk}`,
      };
    });
    menuItem('Patrol').click();
  }

  section('hooks status line (reads ~/.claude/settings.json, a temp one here)');
  {
    const settings = path.join(process.env.HOME, '.claude', 'settings.json');
    const label = () => t.trayMenu.items[1].label;
    const waitLabel = async (want) => {
      for (let i = 0; i < 40 && label() !== want; i++) await wait(250);
      return label();
    };
    // process.execPath is Electron here; ELECTRON_RUN_AS_NODE makes it plain Node. Async, so the
    // main process (and its listener) isn't blocked while the script runs.
    const npm = (script) => new Promise((resolve) => {
      spawn(process.execPath, [path.join(ROOT, 'scripts', script)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' }).on('close', resolve);
    });
    await npm('install-hooks.js');
    check('  after hooks:install', (await waitLabel('Hooks: installed')) === 'Hooks: installed', label());
    const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
    s.hooks.Stop[0].hooks[0].command = "/bin/sh '/old/place/hooks/terra-hook.sh' stop";
    fs.writeFileSync(settings, JSON.stringify(s));
    check('  old entry in settings', (await waitLabel(HOOKS_NEEDS_UPDATE)) === HOOKS_NEEDS_UPDATE, label());
    await npm('uninstall-hooks.js');
    check('  after hooks:uninstall', (await waitLabel('Hooks: not installed')) === 'Hooks: not installed', label());
  }

  section('size');
  await waitFor('idle', 3000);
  const dpr = await js('devicePixelRatio');
  const sizes = menuItem('Size').submenu.items.map((i) => i.label);
  check('menu: 1x, 1.5x, 2x, Match small (2.25x), 3x, 4x', sizes.join(' | ') === '1x | 1.5x | 2x | Match small (2.25x) | 3x | 4x', `${sizes.join(' | ')}; screen pixel ratio ${dpr}`);
  const sizeLabel = (s) => (s === 2.25 ? 'Match small (2.25x)' : `${s}x`);
  // Moves the page's pointer to (x,y); true when clicks there go through to what is behind.
  const passesThrough = async (x, y) => { t.wc.sendInputEvent({ type: 'mouseMove', x, y }); await wait(100); return t.ignoreCalls[t.ignoreCalls.length - 1].ignore; };
  for (const [from, to] of [[4, 1.5], [1.5, 1], [1, 2], [2, 2.25], [2.25, 3], [3, 4]]) {
    const before = t.win.getBounds();
    await takeFrames();
    subItem('Size', sizeLabel(to)).click();
    await wait(400);
    const after = t.win.getBounds();
    const g = ws.geometry(to);
    const p = g.pet;
    const k = to * dpr; // device pixels per art pixel
    // On screen the canvas is the window's size; its own pixels are device pixels.
    const canvas = await js('[canvas.clientWidth, canvas.clientHeight, canvas.width, canvas.height]');
    const f = (await takeFrames()).pop();
    const radio = menuItem('Size').submenu.items.map((i) => `${i.label}${i.checked ? '*' : ''}`).join(' ');
    const saved = ws.load(path.join(t.userData, 'window-state.json'));
    const feetSame = JSON.stringify(ws.feetOf(before)) === JSON.stringify(ws.feetOf(after));
    const savedHere = saved && saved.scale === to && JSON.stringify(saved.feet) === JSON.stringify(ws.feetOf(after));
    check(`  ${from}x -> ${to}x`, after.width === g.width && after.height === g.height && feetSame
      && canvas.join() === [g.width, g.height, Math.round(g.width * dpr), Math.round(g.height * dpr)].join()
      // Sizes that aren't whole device pixels per art pixel are drawn pixel by pixel, not with
      // drawImage; size.e2e.js measures those on screen.
      && (Number.isInteger(k) ? f && f.dest.join() === [8 * k, 28 * k, 48 * k].join() : (await js('drawn')) !== '')
      && radio.includes(`${sizeLabel(to)}*`) && savedHere,
      `window ${after.width}x${after.height}, feet ${feetSame ? 'unchanged' : 'MOVED'}, canvas ${canvas[0]}x${canvas[1]} (${canvas[2]}x${canvas[3]} device px), pet drawn ${Number.isInteger(k) ? `at ${f && f.dest} device px` : 'pixel by pixel'}, menu ${radio}, saved ${saved && saved.scale}x ${savedHere ? 'at these feet' : 'ELSEWHERE'}`);

    const spots = [['pet centre', p.x + p.width / 2, p.y + p.height / 2, false], ['pet top-left corner', p.x, p.y, false],
      ['pet bottom-right corner', p.x + p.width - 1, p.y + p.height - 1, false], ['just left of the pet', p.x - 1, p.y + p.height / 2, true],
      ['just above the pet', p.x + p.width / 2, p.y - 1, true], ['emote area', g.width / 2, p.y / 2, true]];
    const wrong = [];
    for (const [label, x, y, through] of spots) if ((await passesThrough(x, y)) !== through) wrong.push(label);
    check(`  ${to}x: only the pet catches the mouse`, !wrong.length, wrong.length ? `wrong at: ${wrong.join(', ')}` : `${spots.length} spots: the pet's edges catch it, around and above pass through`);
    if (to >= 2) continue;

    // The new small sizes: clicks, sharpness with the emote in place, patrol, pixel ratio changes.
    await attempt(`  ${to}x: a click on the pet plays love, beside it does nothing`, async () => {
      await waitFor('idle', 3000);
      await takeFrames();
      await click(p.x - 2, p.y + p.height / 2);
      await wait(400);
      const beside = (await takeFrames()).some((x) => x.row === ANIMATIONS.love.row);
      await click(p.x + p.width / 2, p.y + p.height / 2);
      await wait(400);
      const on = (await takeFrames()).some((x) => x.row === ANIMATIONS.love.row);
      await waitFor('idle', 3000);
      return { ok: on && !beside, line: `on the pet: ${on ? 'love' : 'nothing'}, beside it: ${beside ? 'love' : 'nothing'}` };
    });

    if (Number.isInteger(k)) {
      const cap = await captureReaction('hi');
      const cmp = cap && await compareCapture(cap.png, cap.row, cap.frame, cap.emote);
      const file = path.join(OUT, `size-${to}x-hi.png`);
      if (cap) fs.writeFileSync(file, cap.png);
      check(`  ${to}x: capture matches cell at (8,28) + emote, whole pixels`, cmp && cmp.off === 0 && cmp.blocky === 0 && cmp.scale === k && cap.emote,
        cap ? `pet row ${cap.row} frame ${cap.frame} + ${cap.emote}; ${cmp.off} of 5120 pixels differ, ${cmp.blocky} blurry blocks, ${cmp.scale}x${cmp.scale} device pixels per art pixel; saved ${file}` : 'could not get a stable frame');
      await wait(2000);
    } else {
      check(`  ${to}x: capture (skipped: pixel ratio ${dpr} can't give whole pixels)`, true, `${k} device pixels per art pixel`);
    }

    const routes = [];
    for (let i = 0; i < 20; i++) routes.push(await js('window.terra.patrolRoute()'));
    const [x0, y0] = t.win.getPosition();
    const badRoutes = routes.filter((r) => r.from.x !== x0 || r.from.y !== y0 || r.to.y + g.height !== wa.y + wa.height - 24
      || r.to.x + p.x < wa.x + 24 || r.to.x + p.x + p.width > wa.x + wa.width - 24);
    const xs = routes.map((r) => r.to.x + p.x);
    check(`  ${to}x: patrol routes end on the bottom margin, pet 24 px inside the work area`, !badRoutes.length,
      `${routes.length} routes, pet left edge ${Math.min(...xs)}..${Math.max(...xs)} (work area ${wa.x + 24}..${wa.x + wa.width - 24 - p.width}), window bottom ${routes[0].to.y + g.height}${badRoutes.length ? `; bad: ${JSON.stringify(badRoutes[0])}` : ''}`);
    await attempt(`  ${to}x: patrol walks at ${24 * to} px/s`, async () => {
      await waitFor('idle', 3000);
      menuItem('Patrol').click(); // on
      const moves = [];
      const onMove = () => { const [x, y] = t.win.getPosition(); moves.push({ t: Date.now(), x, y }); };
      t.win.on('move', onMove);
      await js('nextPatrolAt = 0');
      await wait(2000);
      t.win.off('move', onMove);
      const walkState = await js('state');
      await js("setState('idle')");
      menuItem('Patrol').click(); // off
      const first = moves[0];
      const last = moves[moves.length - 1];
      if (!first || last === first) return { ok: false, line: `${moves.length} moves, state ${walkState}` };
      const speed = Math.hypot(last.x - first.x, last.y - first.y) / ((last.t - first.t) / 1000);
      const inside = moves.every((m) => m.x + p.x >= wa.x && m.x + p.x + p.width <= wa.x + wa.width && m.y + p.y >= wa.y && m.y + g.height <= wa.y + wa.height);
      return { ok: inside && Math.abs(speed - 24 * to) < 2.4 * to + 1, line: `${walkState}, ${moves.length} moves at ${speed.toFixed(1)} px/s, pet inside work area=${inside}` };
    });

    if (to === 1.5) {
      // As if the window moved to a screen with another pixel ratio, then back.
      const other = dpr === 1 ? 2 : 1;
      // Pixel ratio, canvas size, where drawImage put the pet (only used when an art pixel is
      // whole device pixels; other sizes are drawn pixel by pixel), and two probes of the
      // canvas itself: opaque in the middle of the pet's body, clear in the empty corner.
      const look = async () => {
        await wait(300);
        const c = await js(`[devicePixelRatio, canvas.width, canvas.height,
          ctx.getImageData(Math.floor(32 * px), Math.floor(64 * px), 1, 1).data[3], ctx.getImageData(Math.floor(2 * px), Math.floor(2 * px), 1, 1).data[3]]`);
        return [...c.slice(0, 3), ((await takeFrames()).pop() || { dest: [] }).dest.join(), ...c.slice(3)];
      };
      await takeFrames();
      await t.wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: other, mobile: false });
      const there = await look();
      await t.wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
      const back = await look();
      const fits = (r, ratio) => r.slice(0, 3).join() === [ratio, g.width * ratio, g.height * ratio].join() && r[4] === 255 && r[5] === 0
        && (!Number.isInteger(to * ratio) || r[3] === [8, 28, 48].map((v) => v * to * ratio).join());
      check(`  ${to}x: canvas follows the screen's pixel ratio`, fits(there, other) && fits(back, dpr),
        `ratio ${other}: canvas ${there[1]}x${there[2]}, ${Number.isInteger(to * other) ? `pet at ${there[3]}` : 'drawn pixel by pixel'}, body ${there[4] === 255 ? 'opaque' : 'MISSING'}, corner ${there[5] === 0 ? 'clear' : 'NOT CLEAR'}; `
        + `back to ${dpr}: ${back[1]}x${back[2]}, pet at ${back[3]}, body ${back[4] === 255 ? 'opaque' : 'MISSING'}, corner ${back[5] === 0 ? 'clear' : 'NOT CLEAR'}`);
    }
  }

  section('position is remembered');
  {
    await waitFor('idle', 3000);
    const [wx, wy] = t.win.getPosition();
    t.wc.send('pet:set-patrol', false);
    const send = (type, gx, gy, extra = {}) => t.wc.sendInputEvent({ type, x: 128, y: 216, globalX: gx, globalY: gy, button: 'left', ...extra });
    send('mouseDown', wx + 128, wy + 216, { clickCount: 1 });
    for (let k = 1; k <= 5; k++) { send('mouseMove', wx + 128 - 30 * k, wy + 216 - 10 * k, { modifiers: ['leftButtonDown'] }); await wait(40); }
    send('mouseUp', wx - 22, wy + 166, { clickCount: 1 });
    await wait(1500); // saved a second after the last move
    const saved = ws.load(path.join(t.userData, 'window-state.json'));
    const feet = ws.feetOf(t.win.getBounds());
    check('  dragged spot saved in the user data folder', saved && saved.feet.x === feet.x && saved.feet.y === feet.y && saved.scale === 4, `saved ${JSON.stringify(saved)}, window feet ${JSON.stringify(feet)}`);
  }

  section('unknown names');
  t.wc.send('pet:set-state', 'notAState', {});
  t.wc.send('pet:play-reaction', 'notAReaction', {});
  await wait(200);
  check('ignored', current() === 'idle' && (await js('state')) === 'idle', `state ${await js('state')}`);
  t.consoleLog = t.consoleLog.filter((m) => !/notAState|notAReaction/.test(m.message));
});
