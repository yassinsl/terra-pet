// renderer/sounds.js with a fake player and a fake clock: the files and their lengths
// against design/terra-sounds/README.json, which sound goes with which moment, off by
// default, never the same sound over itself, never more than 2 at once, nothing while
// quiet (hidden or asleep), talk blips, and volume.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, check, section, summary } = require('../lib.js');
const s = require(path.join(ROOT, 'renderer', 'sounds.js'));
const EMOTES = require(path.join(ROOT, 'renderer', 'emotes.js'));

const README = JSON.parse(fs.readFileSync(path.join(ROOT, 'design', 'terra-sounds', 'README.json'), 'utf8'));
const json = (v) => JSON.stringify(v);

section('the sounds (design/terra-sounds, copied to Bot/sounds)');
{
  const names = Object.keys(README.durations_s);
  check('every sound in README.json, with its length', json(Object.keys(s.SOUNDS).sort()) === json(names.sort())
    && names.every((n) => s.SOUNDS[n] === Math.round(README.durations_s[n] * 1000)), names.join(' '));
  const copied = names.filter((n) => fs.readFileSync(path.join(ROOT, 'Bot', 'sounds', `${n}.wav`)).equals(fs.readFileSync(path.join(ROOT, 'design', 'terra-sounds', `${n}.wav`))));
  check('each one in Bot/sounds, the same file', copied.length === names.length, `${copied.length} of ${names.length}`);
}

section('which sound for which moment (README.json "use")');
for (const [moment, got, want] of [
  ['hi reaction', s.FOR_EMOTE.hi, 'hi'], ['wave (app start, new session, waking up)', s.FOR_STATE.wave, 'hi'],
  ['love reaction', s.FOR_EMOTE.love, 'love'], ['stars reaction / happy done', s.FOR_EMOTE.stars, 'stars'],
  ['idea reaction', s.FOR_EMOTE.idea, 'idea'], ['sad reaction / sad done', s.FOR_EMOTE.sad, 'sad'],
  ['angry reaction / angry done', s.FOR_EMOTE.angry, 'angry'], ['ask / waiting for the user', s.FOR_EMOTE.ask, 'ask'],
  ['dizzy / error', s.FOR_STATE.dizzy, 'error'], ['sitting down at the laptop', s.FOR_STATE.sitDown, 'sit'],
  ['neutral done', s.NEUTRAL_DONE, 'done'], ['speech bubble pops in', s.BUBBLE_POP, 'pop'],
]) check(`  ${moment}: ${want}`, got === want, got);
check('  every emote has its sound but talk (the bubble has blips)', Object.keys(EMOTES).filter((e) => !s.FOR_EMOTE[e]).join() === 'talk');

// A mixer on a fake clock, recording what the fake player was asked to play.
function mixer({ quiet = () => false } = {}) {
  const clock = { t: 0 };
  const played = [];
  const m = s.createMixer({ player: { play: (name, volume) => played.push([clock.t, name, volume]) }, quiet, now: () => clock.t });
  return { m, clock, played };
}

section('the rules');
{
  const { m, played } = mixer();
  check('off by default: nothing plays', json(m.settings) === json({ effects: false, blips: true, volume: 'low' }) && m.play('hi') === false && played.length === 0, json(m.settings));
}
{
  const { m, clock, played } = mixer();
  m.setSettings({ effects: true });
  const first = m.play('hi');
  clock.t = 100;
  const again = m.play('hi');
  clock.t = 211;
  const after = m.play('hi');
  check('never the same sound over itself: again once it has ended', first && !again && after && played.length === 2, `at 0 ${first}, at 100 ms ${again}, at 211 ms ${after}`);
}
{
  const { m, clock, played } = mixer();
  m.setSettings({ effects: true });
  const a = m.play('sad');   // 640 ms
  const b = m.play('angry'); // 410 ms
  const c = m.play('love');
  clock.t = 420;
  const d = m.play('love');
  check('at most 2 at once: a third waits for one to end', a && b && !c && d && json(played.map((p) => p[1])) === json(['sad', 'angry', 'love']), `${a} ${b} ${c}, at 420 ms ${d}`);
}
{
  let hidden = true;
  const { m, played } = mixer({ quiet: () => hidden });
  m.setSettings({ effects: true });
  const whileQuiet = m.play('stars');
  hidden = false;
  const after = m.play('stars');
  check('nothing while quiet (the pet hidden or asleep)', !whileQuiet && after && played.length === 1);
}
{
  const { m, played } = mixer();
  m.setSettings({ effects: true, blips: false });
  const blip = m.play('talk-1', { blip: true });
  const pop = m.play('pop');
  m.setSettings({ effects: false, blips: true });
  const offBlip = m.play('talk-2', { blip: true });
  check('talk blips: off on their own, and only with sound effects on', !blip && pop && !offBlip && played.length === 1);
}
{
  const { m, clock, played } = mixer();
  for (const [volume, at] of [['low', 0], ['medium', 1000], ['high', 2000], ['loud', 3000]]) {
    m.setSettings({ effects: true, volume });
    clock.t = at;
    m.play('hi');
  }
  check('volume for afplay -v: low 0.3, medium 0.6, high 1.0 (anything else: low)', json(played.map((p) => p[2])) === json([0.3, 0.6, 1, 0.3]), json(played.map((p) => p[2])));
  check('  an unknown sound: nothing', m.play('boom') === false);
}

section('a player that says when it ends (afplay\'s process)');
(async () => {
  const clock = { t: 0 };
  const ends = {};
  const m = s.createMixer({
    player: { play: (name) => new Promise((resolve) => { ends[name] = resolve; }) },
    now: () => clock.t,
  });
  m.setSettings({ effects: true });
  m.play('pop'); // 50 ms long, but its process is still running
  clock.t = 1000;
  const whileRunning = m.play('pop');
  ends.pop(0);
  await new Promise((r) => setImmediate(r));
  const afterExit = m.play('pop');
  check('  held until the process ends, not just for the sound\'s length', !whileRunning && afterExit, `at 1 s while running: ${whileRunning}; after it ended: ${afterExit}`);
  const hung = ends.pop; // that last pop's process never ends (until much later)
  clock.t += 50 + s.HELD_AT_MOST;
  const afterHang = m.play('pop'); // a new pop, with its own process
  hung(0); // the hung one ends at last: it must not free the new pop
  await new Promise((r) => setImmediate(r));
  const overNew = m.play('pop');
  check('  a process that never ends gives its place up after 5 s, and ending late frees nothing new', afterHang && !overNew, `after the hang: ${afterHang}; over the new one: ${overNew}`);

section('talk blips at the reading pace');
{
  const seq = [0.1, 0.9, 0.1, 0.9, 0.1];
  let i = 0;
  const times = s.blipTimes(12, 50, () => seq[i++ % seq.length]);
  check('  12 characters at 50 ms each: a blip at the start, then every 2 or 3 characters', json(times) === json([0, 100, 250, 350, 500]), json(times));
  const many = s.blipTimes(40, 50);
  const gaps = many.slice(1).map((t, k) => t - many[k]);
  check('  40 characters: 14 to 20 blips, 100 or 150 ms apart, all within the 2 s of reading', many.length >= 14 && many.length <= 20 && gaps.every((g) => g === 100 || g === 150) && many[many.length - 1] < 2000,
    `${many.length} blips`);
  let last = null;
  const picks = Array.from({ length: 200 }, () => (last = s.nextBlip(last)));
  check('  a random talk-1..4, never the same one twice in a row', picks.every((p, k) => s.TALK_BLIPS.includes(p) && (k === 0 || p !== picks[k - 1])) && new Set(picks).size === 4);
}

process.exitCode = summary() ? 1 : 0;
})();
