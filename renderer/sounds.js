// Terra's sound effects: the WAVs in Bot/sounds/ (copied from design/terra-sounds/, whose
// README.json says which goes with which moment), and the rules for playing them. A sound
// never overlaps itself, at most 2 play at once, and nothing plays while sound effects are
// off, or the pet is hidden or asleep. The pet's page (renderer/pet.js) uses the moment
// lists to ask for a sound; main.js keeps the mixer and plays through sound-player.js
// (afplay). The tests require this file with a fake player.

// Every sound and how long it lasts (ms), from design/terra-sounds/README.json.
const SOUNDS = {
  hi: 210, love: 350, stars: 390, idea: 280, sad: 640, angry: 410, ask: 260, error: 300,
  sit: 140, done: 180, pop: 50, 'talk-1': 30, 'talk-2': 30, 'talk-3': 30, 'talk-4': 30,
};
const TALK_BLIPS = ['talk-1', 'talk-2', 'talk-3', 'talk-4'];

// The moments. A reaction's sound comes with its emote (talk has none: the speech bubble
// has its blips); a few pet animations have their own. "done" by mood: happy plays the
// stars reaction, sad and angry their reactions, and neutral plays NEUTRAL_DONE.
const FOR_EMOTE = { hi: 'hi', love: 'love', stars: 'stars', idea: 'idea', sad: 'sad', angry: 'angry', ask: 'ask' };
const FOR_STATE = { sitDown: 'sit', dizzy: 'error', wave: 'hi' };
const NEUTRAL_DONE = 'done';
const BUBBLE_POP = 'pop';

const VOLUMES = { low: 0.3, medium: 0.6, high: 1.0 }; // afplay -v
const MAX_AT_ONCE = 2;
const HELD_AT_MOST = 5000; // ms over its length a sound holds its place if its player never says it ended
const DEFAULT_SETTINGS = { effects: false, blips: true, volume: 'low' };

// player.play(name, volume) makes the noise; when it returns a promise, the sound counts as
// playing until that settles (afplay's process ends), otherwise for its length. quiet()
// says when not to (hidden, asleep).
function createMixer({ player, quiet = () => false, now = () => performance.now() }) {
  const playing = new Map(); // sound -> { end }: playing until its player says so, or end passes
  let settings = { ...DEFAULT_SETTINGS };
  return {
    get settings() {
      return { ...settings };
    },
    setSettings(next) {
      settings = {
        effects: next.effects === true,
        blips: next.blips !== false,
        volume: Object.hasOwn(VOLUMES, next.volume) ? next.volume : DEFAULT_SETTINGS.volume,
      };
    },
    // Plays `name` unless a rule says no; true when it played. Talk blips (blip: true) also
    // need the Talk blips setting.
    play(name, { blip = false } = {}) {
      if (!settings.effects || (blip && !settings.blips) || !Object.hasOwn(SOUNDS, name) || quiet()) return false;
      const t = now();
      for (const [n, entry] of playing) if (entry.end <= t) playing.delete(n);
      if (playing.has(name) || playing.size >= MAX_AT_ONCE) return false;
      const entry = { end: t + SOUNDS[name] };
      playing.set(name, entry);
      const playingNow = player.play(name, VOLUMES[settings.volume]);
      if (playingNow && typeof playingNow.then === 'function') {
        entry.end += HELD_AT_MOST;
        const release = () => {
          if (playing.get(name) === entry) playing.delete(name);
        };
        playingNow.then(release, release);
      }
      return true;
    },
  };
}

// When to blip while a bubble with `chars` characters shows: reading it at `perCharMs` a
// character, a blip at the start and then every 2 or 3 characters, until the text is read.
// Times in ms from when the text appears.
function blipTimes(chars, perCharMs, random = Math.random) {
  const times = [];
  for (let at = 0; at < chars; at += random() < 0.5 ? 2 : 3) times.push(at * perCharMs);
  return times;
}

// A talk blip other than the last one, so the same blip never follows itself.
function nextBlip(last, random = Math.random) {
  const choices = TALK_BLIPS.filter((b) => b !== last);
  return choices[Math.floor(random() * choices.length)];
}

if (typeof module !== 'undefined') {
  module.exports = {
    SOUNDS, TALK_BLIPS, FOR_EMOTE, FOR_STATE, NEUTRAL_DONE, BUBBLE_POP, VOLUMES, MAX_AT_ONCE, HELD_AT_MOST, DEFAULT_SETTINGS, createMixer, blipTimes, nextBlip,
  };
}
