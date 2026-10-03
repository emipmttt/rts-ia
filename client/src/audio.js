// Sound effects with the Web Audio API. Sounds load lazily; the context starts on the first user
// gesture (browsers block audio before that). World sounds are quieter the farther they are from the
// centre of the screen, silent off screen, and throttled so a big battle doesn't turn into noise.

const BASE = '/assets/sfx';

// name -> { files, volume, gap: min seconds between two plays of this sound }
const SOUNDS = {
  sword: { files: ['sword_1', 'sword_2', 'sword_3'], volume: 0.35, gap: 0.08 },
  hit: { files: ['hit_1', 'hit_2', 'hit_3'], volume: 0.3, gap: 0.1 },
  bow: { files: ['bow_1', 'bow_2'], volume: 0.3, gap: 0.1 },
  arrowHit: { files: ['arrow_hit_1', 'arrow_hit_2', 'arrow_hit_3'], volume: 0.25, gap: 0.12 },
  chop: { files: ['chop_1', 'chop_2', 'chop_3', 'chop_4'], volume: 0.22, gap: 0.12 },
  mine: { files: ['mine_1', 'mine_2', 'mine_3', 'mine_4', 'mine_5'], volume: 0.22, gap: 0.12 },
  hammer: { files: ['chop_2', 'chop_4'], volume: 0.18, gap: 0.15, rate: 1.5 },
  death: { files: ['death_1', 'death_2'], volume: 0.3, gap: 0.1 },
  collapse: { files: ['collapse'], volume: 0.5, gap: 0.4 },
  built: { files: ['built'], volume: 0.45, gap: 0.3 },
  trained: { files: ['trained'], volume: 0.35, gap: 0.2 },
  heal: { files: ['heal'], volume: 0.2, gap: 0.6 },
  notice: { files: ['notice'], volume: 0.4, gap: 0.5 },
  error: { files: ['error'], volume: 0.35, gap: 0.3 },
  start: { files: ['start'], volume: 0.5, gap: 1 },
  victory: { files: ['victory'], volume: 0.6, gap: 1 },
  defeat: { files: ['defeat'], volume: 0.6, gap: 1 },
  click: { files: ['ui_click'], volume: 0.3, gap: 0.05 },
  hover: { files: ['ui_hover'], volume: 0.12, gap: 0.06, rate: 1.4 },
  place: { files: ['ui_place'], volume: 0.4, gap: 0.1 },
};
const AMBIENT_VOLUME = 0.18;
const MAX_VOICES = 12; // sounds playing at once

let ctx = null;
let master = null;
let ambient = null;
let voices = 0;
const buffers = new Map(); // file -> Promise<AudioBuffer>
const lastPlayed = new Map(); // sound name -> ctx time
let muted = false;
try { muted = localStorage.getItem('muted') === '1'; } catch { /* storage unavailable */ }

function ensureContext() {
  if (ctx) return ctx;
  const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioCtx) return null;
  ctx = new AudioCtx();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 1;
  master.connect(ctx.destination);
  return ctx;
}

function load(file) {
  if (!buffers.has(file)) {
    buffers.set(file, fetch(`${BASE}/${file}.mp3`)
      .then((r) => r.arrayBuffer())
      .then((data) => ctx.decodeAudioData(data))
      .catch(() => null));
  }
  return buffers.get(file);
}

// Browsers only allow audio after a user gesture: start (and preload) on the first one
for (const event of ['pointerdown', 'keydown']) {
  window.addEventListener(event, () => {
    if (!ensureContext()) return;
    if (ctx.state === 'suspended') ctx.resume();
    for (const { files } of Object.values(SOUNDS)) files.forEach(load);
  }, { capture: true });
}

/**
 * Plays a sound. `volume` scales the sound's own volume (used for distance).
 * @param {keyof SOUNDS} name
 */
export function play(name, volume = 1) {
  const sound = SOUNDS[name];
  if (!sound || muted || volume <= 0.02 || !ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  if (now - (lastPlayed.get(name) ?? -Infinity) < sound.gap || voices >= MAX_VOICES) return;
  lastPlayed.set(name, now);
  const file = sound.files[Math.floor(Math.random() * sound.files.length)];
  load(file).then((buffer) => {
    if (!buffer) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // A little pitch variation so repeated sounds don't feel mechanical
    source.playbackRate.value = (sound.rate ?? 1) * (0.92 + Math.random() * 0.16);
    const gain = ctx.createGain();
    gain.gain.value = sound.volume * Math.min(1, volume);
    source.connect(gain).connect(master);
    voices++;
    source.onended = () => { voices--; };
    source.start();
  });
}

// Looping forest ambience while in a game
export function startAmbient() {
  if (!ensureContext() || ambient) return;
  const gain = ctx.createGain();
  gain.gain.value = AMBIENT_VOLUME;
  gain.connect(master);
  ambient = { gain, source: null, stopped: false };
  const current = ambient;
  load('ambient').then((buffer) => {
    if (!buffer || current.stopped) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start();
    current.source = source;
  });
}

export function stopAmbient() {
  if (!ambient) return;
  ambient.stopped = true;
  ambient.source?.stop();
  ambient.gain.disconnect();
  ambient = null;
}

export const isMuted = () => muted;

export function setMuted(value) {
  muted = value;
  try { localStorage.setItem('muted', muted ? '1' : '0'); } catch { /* storage unavailable */ }
  if (master) master.gain.value = muted ? 0 : 1;
}

// Clicks and hovers on every button in the page, including ones created later
let hovered = null;
document.addEventListener('pointerover', (e) => {
  const button = e.target.closest?.('button');
  if (button === hovered) return;
  hovered = button;
  if (button && !button.disabled) play('hover');
});
document.addEventListener('click', (e) => {
  const button = e.target.closest?.('button');
  if (button && !button.disabled) play('click');
}, { capture: true });
