// Bakes the procedural pixel rigs (client/src/pixelRig.js) into PNG atlases for Unity, one per
// faction and rig. Each row is one `${style}_${view}_${animation}` strip of FRAME_W x FRAME_H frames.
// Run from the repo root: node unity/Tools/bake-rigs.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildRigFrames, FRAME_W, FRAME_H, RIG_NAMES } from '../../client/src/pixelRig.js';
import { FACTIONS } from '../../shared/constants.js';
import { png } from './png.mjs';

const OUT = new URL('../Assets/Resources/rigs/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const index = {};
for (const rig of RIG_NAMES) {
  for (const { id, color } of FACTIONS) {
    const sheets = buildRigFrames(rig, color);
    const names = Object.keys(sheets);
    const cols = Math.max(...names.map((n) => sheets[n].length));
    const width = cols * FRAME_W;
    const height = names.length * FRAME_H;
    const rgba = new Uint8ClampedArray(width * height * 4);
    names.forEach((name, row) => sheets[name].forEach((frame, col) => {
      for (let y = 0; y < FRAME_H; y++) {
        const dst = ((row * FRAME_H + y) * width + col * FRAME_W) * 4;
        rgba.set(frame.subarray(y * FRAME_W * 4, (y + 1) * FRAME_W * 4), dst);
      }
    }));
    writeFileSync(new URL(`${id}_${rig}.png`, OUT), png(width, height, rgba));
    // Same layout for every faction
    index[rig] = names.map((name) => ({ name, frames: sheets[name].length }));
  }
}
writeFileSync(new URL('index.json', OUT), JSON.stringify({ frameW: FRAME_W, frameH: FRAME_H, rigs: index }));
console.log(`Baked ${RIG_NAMES.length} rigs x ${FACTIONS.length} factions`);
