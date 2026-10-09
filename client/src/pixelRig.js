// Procedural pixel-art units (villager, staff and air warriors, flyer). Each 16x16 reference sprite is split into bones (head, torso, arms,
// legs) and every animation frame is a pose that moves/rotates those bones, then gets rasterised
// pixel by pixel (no anti-aliasing). Pure data in, RGBA buffers out, so it can run without a DOM.

export const FRAME_W = 24;
export const FRAME_H = 28;
// Where the reference sprite's (0,0) lands inside a frame
const OX = 10;
const OY = 10;

// Colour keys from the reference art; only `team` (#93ff83 in the art) is replaced by the faction colour
export const PALETTE = {
  skin: 0xebcaa6,
  eye: 0x0b0b0b,
  hair: 0x544433,
  team: 0x93ff83,
  pants: 0xc99965,
  dark: 0x2c2c2c, // fire civilization cloth
  blade: 0xc3c3c3,
  bladeDark: 0xa7a7a7,
  grip: 0x372d23,
  fireWhite: 0xfff3b0,
  fireYellow: 0xffd34d,
  fireOrange: 0xff8a2a,
  fireRed: 0xe0401f,
  shoe: 0x544433,
  wood: 0x8b5a2b,
  metal: 0xb8c0c8,
  metalDark: 0x7a828a,
  gold: 0xffd34d,
  meat: 0xd9534f,
  log: 0x6b4423,
  logEnd: 0xc89b62,
  staff: 0x514231,
  staffBand: 0x73583a,
  windWhite: 0xffffff,
  windGray: 0xc9d3dc,
  windBlue: 0x8fd0ff,
  healGreen: 0x7dff7a,
  healGold: 0xfff59d,
};

// Bones are drawn as text grids (one char per pixel, '.' = empty) in reference-sprite coordinates
const KEYS = {
  S: 'skin', E: 'eye', H: 'hair', T: 'team', P: 'pants', B: 'shoe', D: 'dark',
};
const grid = (rows, y0 = 0, x0 = 0) => rows.flatMap((row, y) => [...row].flatMap((c, x) => (
  c === '.' ? [] : [[x + x0, y + y0, KEYS[c]]])));

// Faces sit under the hair; row 4 is the neck
const FACE = grid(['.SSS.', '.ESE.', '.SSS.', '..S..'], 1);
const BLINK = grid(['.S.S.'], 2);
const FACE_SIDE = grid(['..SSS', '..SES', '..SS.', '..S..'], 1);
const BLINK_SIDE = grid(['...S.'], 2);
const FACE_BACK = grid(['..S..'], 4);
// Hair per style and view (the side view faces +x)
const HAIR = {
  male: {
    front: grid(['.HHH.', 'HHH.H', 'H...H']),
    side: grid(['HHHH.', 'HHHHH', 'HH...', '.H...']),
    back: grid(['.HHH.', 'HHHHH', 'HHHHH', '.HHH.']),
  },
  female: {
    front: grid(['.HHH.', 'HHH.H', 'H...H', 'H...H', 'H...H']),
    side: grid(['HHHH.', 'HHHHH', 'HH...', 'HH...', 'HH...']),
    back: grid(['.HHH.', 'HHHHH', 'HHHHH', 'HHHHH', 'HHHHH']),
  },
};
export const HAIR_STYLES = Object.keys(HAIR);
// Team headband over the hair (air warrior)
const BAND = {
  male: { front: grid(['..TT.'], 1), side: grid(['.TT..'], 1), back: grid(['TTTTT'], 1) },
  female: { front: grid(['...T.'], 1), side: grid(['.TT..'], 1), back: grid(['TTTTT'], 1) },
};
// Body art per unit; legs are drawn from their left column `x0`
// Villager: tunic with a team-coloured sash from the right shoulder to the left hip, over beige trousers
const leg = (x0, top, ankleX, ankle = 'skin', shoe = 'shoe', mid = 'PP') => [
  ...grid([top, mid], 10, x0), [ankleX, 12, ankle], [x0, 13, shoe], [x0 + 1, 13, shoe],
];
const teamLeg = (x0, ankleX, mid) => leg(x0, 'PP', ankleX, 'team', 'team', mid);
const BODIES = {
  villager: {
    torso: grid(['.SST.', '.STT.', '.TTT.', '.TTP.', 'TTPPP'], 5),
    torsoBack: grid(['.TSS.', '.TTS.', '.TTT.', '.PTT.', 'PPPTT'], 5),
    torsoSide: grid(['SST', 'STT', 'TTT', 'TTP', 'TPP'], 5, 1),
    legs: [leg(0, 'TP', 1), leg(3, 'PP', 3)],
    legsBack: [leg(0, 'PP', 1), leg(3, 'PT', 3)],
    legSide: (x0) => leg(x0, 'PP', x0),
    shoulders: [[0, 5], [4, 5]],
    shoulderSide: [2, 5],
    armWidth: 1,
    arm: ['skin'],
  },
  // Fire villager: dark clothes with a team collar, team bracelets; short hair or a tied-up bun
  villager_fire: {
    torso: grid(['.TDT.', '.DTD.', '.DDD.', '.DDD.', 'DDDDD'], 5),
    torsoBack: grid(['.DDD.', '.DDD.', '.DDD.', '.DDD.', 'DDDDD'], 5),
    torsoSide: grid(['TDD', 'DTD', 'DDD', 'DDD', 'DDD'], 5, 1),
    legs: [leg(0, 'DD', 1, 'skin', 'shoe', 'DD'), leg(3, 'DD', 3, 'skin', 'shoe', 'DD')],
    legsBack: [leg(0, 'DD', 1, 'skin', 'shoe', 'DD'), leg(3, 'DD', 3, 'skin', 'shoe', 'DD')],
    legSide: (x0) => leg(x0, 'DD', x0, 'skin', 'shoe', 'DD'),
    shoulders: [[0, 5], [4, 5]],
    shoulderSide: [2, 5],
    armWidth: 1,
    arm: ['skin', 'skin', 'team', 'skin'],
    hair: {
      male: {
        front: grid(['.HHH.']),
        side: grid(['HHHH.', 'H....']),
        back: grid(['.HHH.', 'HHHHH', 'HHHHH', '.HHH.']),
      },
      female: {
        front: grid(['....H.', '....TH', '.HHH..', 'HHHHH.', 'H...H.'], -2),
        side: grid(['H....', 'TH...', 'HHHH.', 'HHHHH', 'HH...'], -2, -1),
        back: grid(['..H..', '..T..', '.HHH.', 'HHHHH', 'HHHHH', 'HHHHH'], -2),
      },
    },
  },
  // Fire swordsman: dark armour with team trim, two-tone sleeves, team-tipped boots
  warrior_fire: {
    torso: grid(['DTTTD', 'TDDDT', '.TDT.', '.DTD.', 'DDDDD'], 5),
    torsoBack: grid(['DTTTD', 'TDDDT', '.DDD.', '.DDD.', 'DDDDD'], 5),
    torsoSide: grid(['TTT', 'DDT', 'TDT', 'DTD', 'DDD'], 5, 1),
    legs: [
      [...grid(['DD', 'TT'], 10, 0), [1, 12, 'team'], [0, 13, 'team'], [1, 13, 'dark']],
      [...grid(['DD', 'TT'], 10, 3), [3, 12, 'team'], [3, 13, 'dark'], [4, 13, 'team']],
    ],
    legsBack: [
      [...grid(['DD', 'TT'], 10, 0), [1, 12, 'team'], [0, 13, 'team'], [1, 13, 'dark']],
      [...grid(['DD', 'TT'], 10, 3), [3, 12, 'team'], [3, 13, 'dark'], [4, 13, 'team']],
    ],
    legSide: (x0) => [...grid(['DD', 'TT'], 10, x0), [x0, 12, 'team'], [x0, 13, 'dark'], [x0 + 1, 13, 'team']],
    shoulders: [[-1, 5], [5, 5]],
    shoulderSide: [2, 5],
    armWidth: 2,
    arm: ['team', 'team', 'dark', 'skin'],
    armOuter: ['team', 'dark', 'dark', 'skin'],
    hair: {
      male: {
        front: grid(['.HHH.']),
        side: grid(['HHHH.', 'H....']),
        back: grid(['.HHH.', 'HHHHH', 'HHHHH', '.HHH.']),
      },
      female: {
        front: grid(['....H.', '....TH', '.HHH..', 'HHHHH.', 'H...H.', 'H...H.'], -2),
        side: grid(['H....', 'TH...', 'HHHH.', 'HHHHH', 'HH...', 'HH...'], -2, -1),
        back: grid(['..H..', '..T..', '.HHH.', 'HHHHH', 'HHHHH', 'HHHHH', 'HHHHH'], -2),
      },
    },
  },
  // Fire mage: team headband, raised team shoulder pads, dark robe with team bands, team trousers
  air_fire: {
    torso: grid(['T...T', 'TTDTT', '.DTD.', '.DDD.', '.TTT.', 'DDDDD'], 4),
    torsoBack: grid(['T...T', 'TTDTT', '.DDD.', '.DDD.', '.TTT.', 'DDDDD'], 4),
    torsoSide: grid(['.T.', 'TTT', 'DTD', 'DDD', 'TTT', 'DDD'], 4, 1),
    legs: [leg(0, 'TT', 1, 'skin', 'shoe', 'TT'), leg(3, 'TT', 3, 'skin', 'shoe', 'TT')],
    legsBack: [leg(0, 'TT', 1, 'skin', 'shoe', 'TT'), leg(3, 'TT', 3, 'skin', 'shoe', 'TT')],
    legSide: (x0) => leg(x0, 'TT', x0, 'skin', 'shoe', 'TT'),
    shoulders: [[0, 5], [4, 5]],
    shoulderSide: [2, 5],
    armWidth: 1,
    arm: ['team', 'dark', 'team', 'skin'],
    // Short hair or bun like the fire villager, with a team headband across the forehead
    hair: {
      male: {
        front: grid(['.HHH.', '.TTT.']),
        side: grid(['HHHH.', 'HTTT.']),
        back: grid(['.HHH.', 'TTTTT', 'HHHHH', '.HHH.']),
      },
      female: {
        front: grid(['....H.', '....TH', '.HHH..', 'HTTTH.', 'H...H.'], -2),
        side: grid(['H....', 'TH...', 'HHHH.', 'HTTTT', 'HH...'], -2, -1),
        back: grid(['..H..', '..T..', '.HHH.', 'TTTTT', 'HHHHH', 'HHHHH'], -2),
      },
    },
  },
  // Staff warrior: team tunic top and sleeves, shin wraps and shoes, thick arms
  warrior: {
    torso: grid(['TTSTT', 'TTTTT', '.TTT.', '.PTP.', 'PPPPP'], 5),
    torsoBack: grid(['TTSTT', 'TTTTT', '.TTT.', '.PTP.', 'PPPPP'], 5),
    torsoSide: grid(['TST', 'TTT', 'TTT', 'TTP', 'PPP'], 5, 1),
    legs: [teamLeg(0, 1), teamLeg(3, 3)],
    legsBack: [teamLeg(0, 1), teamLeg(3, 3)],
    legSide: (x0) => teamLeg(x0, x0),
    shoulders: [[-1, 5], [5, 5]],
    shoulderSide: [2, 5],
    armWidth: 2,
    arm: ['team', 'team', 'team', 'skin'],
  },
  // Air warrior: striped team robe, team bracelets, shins and shoes, headband
  air: {
    torso: grid(['TTSTT', 'PTTTP', 'PPTPP', '.PTP.', 'PPTPP'], 5),
    torsoBack: grid(['TTSTT', 'PTTTP', 'PPTPP', '.PTP.', 'PPTPP'], 5),
    torsoSide: grid(['TST', 'PTT', 'PTP', 'PTP', 'PTP'], 5, 1),
    legs: [teamLeg(0, 1, 'TT'), teamLeg(3, 3, 'TT')],
    legsBack: [teamLeg(0, 1, 'TT'), teamLeg(3, 3, 'TT')],
    legSide: (x0) => teamLeg(x0, x0, 'TT'),
    shoulders: [[-1, 5], [5, 5]],
    shoulderSide: [2, 5],
    armWidth: 1,
    arm: ['skin', 'skin', 'team', 'skin'],
    band: true,
  },
  // Monk: bald, long team robe down to the ankles, pale sleeves
  monk: {
    torso: grid(['TTSTT', 'TTTTT', 'TTTTT', 'PTTTP', 'PPTPP', 'PPPPP', 'TTTTT'], 5),
    torsoBack: grid(['TTSTT', 'TTTTT', 'TTTTT', 'PTTTP', 'PPTPP', 'PPPPP', 'TTTTT'], 5),
    torsoSide: grid(['TST', 'TTT', 'TTT', 'PTP', 'PTP', 'PPP', 'TTT'], 5, 1),
    // Only the ankles and shoes show under the robe
    legs: [[[1, 12, 'pants'], [0, 13, 'team'], [1, 13, 'team']], [[3, 12, 'pants'], [3, 13, 'team'], [4, 13, 'team']]],
    legsBack: [[[1, 12, 'pants'], [0, 13, 'team'], [1, 13, 'team']], [[3, 12, 'pants'], [3, 13, 'team'], [4, 13, 'team']]],
    legSide: (x0) => [[x0, 12, 'pants'], [x0, 13, 'team'], [x0 + 1, 13, 'team']],
    shoulders: [[-1, 5], [5, 5]],
    shoulderSide: [2, 5],
    armWidth: 1,
    arm: ['pants', 'pants', 'pants', 'skin'],
    // Bald: no hair, just the skin of the scalp from the side and behind
    hair: Object.fromEntries(['male', 'female'].map((style) => [style, {
      front: [], side: grid(['.S', '.S', '.S'], 1), back: grid(['.SSS.', '.SSS.', '.SSS.'], 1),
    }])),
  },
  // Fire flyer: team hood and mask (only the eyes show), dark poncho with a team border
  flyer_fire: {
    torso: grid(['DDDDD', 'DDDDD'], 9),
    torsoBack: grid(['DDDDD', 'DDDDD'], 9),
    torsoSide: grid(['DDD', 'DDD'], 9, 1),
    legs: [leg(0, 'DD', 1, 'team', 'team', 'TT'), leg(3, 'DD', 3, 'team', 'team', 'TT')],
    legsBack: [leg(0, 'DD', 1, 'team', 'team', 'TT'), leg(3, 'DD', 3, 'team', 'team', 'TT')],
    legSide: (x0) => leg(x0, 'DD', x0, 'team', 'team', 'TT'),
    legBone: ['dark', 'team', 'team', 'team'],
    shoulders: [[0, 6], [4, 6]],
    shoulderSide: [2, 6],
    armWidth: 1,
    arm: ['dark', 'dark', 'team', 'skin'],
    face: {
      front: grid(['.TTT.', '.ESE.', '.TTT.', '..T..'], 1),
      side: grid(['..TTT', '..TES', '..TT.', '..T..'], 1),
      back: grid(['.TTT.', '.TTT.', '.TTT.', '..T..'], 1),
    },
    hair: {
      male: { front: grid(['.HHH.']), side: grid(['HHHH.']), back: grid(['.HHH.']) },
      female: {
        front: grid(['....HH', '....TH', '.HHH..', 'HHH.H.'], -2),
        side: grid(['HH...', 'TH...', 'HHHH.', 'HHHH.'], -2, -1),
        back: grid(['..HH.', '..TH.', '.HHH.', 'HHHHH'], -2),
      },
    },
    poncho: {
      front: {
        closed: grid(['TDDTDDT', 'TTDDDTT', 'TTTTTTT', '.TTTTT.', '.TTTTT.'], 5, -1),
        open: grid(['TTDDDTDDDTT', 'TTTDDDDDTTT', '.TTTTTTTTT.', '..TTTTTTT..'], 5, -3),
        flutter: grid(['TTDDDTDDDTT', '.TTDDDDDTT.', '..TTTTTTT..', '...TTTTT...'], 5, -3),
        wide: grid(['TT.......TT', 'TTDDDTDDDTT', '.TTDDDDDTT.', '..TTTTTTT..'], 4, -3),
      },
      back: {
        closed: grid(['TDDTDDT', 'TTDDDTT', 'TTTTTTT', '.TTTTT.', '.TTTTT.'], 5, -1),
        open: grid(['TTDDDTDDDTT', 'TTTDDDDDTTT', '.TTTTTTTTT.', '..TTTTTTT..'], 5, -3),
        flutter: grid(['TTDDDTDDDTT', '.TTDDDDDTT.', '..TTTTTTT..', '...TTTTT...'], 5, -3),
        wide: grid(['TT.......TT', 'TTDDDTDDDTT', '.TTDDDDDTT.', '..TTTTTTT..'], 4, -3),
      },
      side: {
        closed: grid(['.TTT', 'TDDT', 'TDDT', 'TTTT', 'TTTT'], 5, 0),
        open: grid(['....TTT', 'TTDDDTT', '.TDDTTT', '...TTTT'], 5, -3),
        flutter: grid(['....TTT', '..TDDTT', 'TTDDTTT', '.TT.TTT'], 5, -3),
        wide: grid(['TT.....', '.TTDTTT', '..TDTTT', '...TTTT'], 4, -3),
      },
    },
  },
  // Flyer: a striped team poncho that hangs closed on the ground and spreads out like wings in flight
  flyer: {
    torso: grid(['PPPPP', 'PPPPP'], 9),
    torsoBack: grid(['PPPPP', 'PPPPP'], 9),
    torsoSide: grid(['PPP', 'PPP'], 9, 1),
    legs: [teamLeg(0, 1), teamLeg(3, 3)],
    legsBack: [teamLeg(0, 1), teamLeg(3, 3)],
    legSide: (x0) => teamLeg(x0, x0),
    legBone: ['pants', 'pants', 'team', 'team'], // hip to toe when the legs swing as bones
    shoulders: [[0, 6], [4, 6]],
    shoulderSide: [2, 6],
    armWidth: 1,
    arm: ['skin'],
    hair: { male: { front: grid(['.HHH.', 'HH..H', 'H...H']) } },
    poncho: {
      front: {
        closed: grid(['TPPSPPT', 'TPPTPPT', 'TTTTTTT', '.TTTTT.', '.TTTTT.'], 5, -1),
        open: grid(['TTPPTSTPPTT', 'TTPPTTTPPTT', '.TTTTTTTTT.', '..TTTTTTT..'], 5, -3),
        flutter: grid(['TTPPTSTPPTT', '.TPPTTTPPT.', '..TTTTTTT..', '...TTTTT...'], 5, -3),
        // Downstroke: the tips swept up above the shoulders
        wide: grid(['TT.......TT', 'TTPPTSTPPTT', '.TPPTTTPPT.', '..TTTTTTT..'], 4, -3),
      },
      back: {
        closed: grid(['TPPSPPT', 'TPPTPPT', 'TTTTTTT', '.TTTTT.', '.TTTTT.'], 5, -1),
        open: grid(['TTPPTSTPPTT', 'TTPPTTTPPTT', '.TTTTTTTTT.', '..TTTTTTT..'], 5, -3),
        flutter: grid(['TTPPTSTPPTT', '.TPPTTTPPT.', '..TTTTTTT..', '...TTTTT...'], 5, -3),
        wide: grid(['TT.......TT', 'TTPPTSTPPTT', '.TPPTTTPPT.', '..TTTTTTT..'], 4, -3),
      },
      // From the side the poncho streams out behind (-x)
      side: {
        closed: grid(['.TST', 'TPPT', 'TPPT', 'TTTT', 'TTTT'], 5, 0),
        open: grid(['....TST', 'TTPPTTT', '.TPPTTT', '...TTTT'], 5, -3),
        flutter: grid(['....TST', '..TPPTT', 'TTPPTTT', '.TT.TTT'], 5, -3),
        wide: grid(['TT.....', '.TTPTST', '..TPTTT', '...TTTT'], 4, -3),
      },
    },
  },
};
const ARM_LEN = 4;

const rad = (deg) => (deg * Math.PI) / 180;
// Angle convention: 0 = straight down, 90 = forward (+x), 180 = straight up
const dir = (deg) => [Math.sin(rad(deg)), Math.cos(rad(deg))];

// Tools: handle length + head pixels at the tip, offsets along the handle (a) and across it (p)
const TOOLS = {
  axe: { handle: 5, twoHanded: true, head: [[0, 1, 'metal'], [0, 2, 'metal'], [-1, 1, 'metal'], [-1, 2, 'metalDark']] },
  pickaxe: { handle: 5, twoHanded: true, head: [[0, -2, 'metalDark'], [0, -1, 'metal'], [0, 1, 'metal'], [0, 2, 'metalDark'], [1, 0, 'metal']] },
  hammer: { handle: 4, head: [[0, -1, 'metalDark'], [0, 1, 'metal'], [1, -1, 'metalDark'], [1, 0, 'metal'], [1, 1, 'metal']] },
  // Long staff gripped near its lower end, with two lighter bands
  staff: { handle: 8, back: 2, key: 'staff', bands: [1, 7], head: [] },
  // Short sword: dark grip in the fist, a two-tone blade with a pointed tip
  sword: {
    handle: 1,
    key: 'grip',
    head: [
      ...[1, 2, 3, 4, 5, 6].flatMap((a) => [[a, 0, 'blade'], [a, 1, 'bladeDark']]),
      [7, 0, 'blade'], [8, 0, 'blade'],
    ],
  },
  // The monk's taller staff (14 px)
  tallStaff: { handle: 11, back: 2, key: 'staff', bands: [1, 12], head: [] },
  // Folding fan held at its corner (grid row 3, column 0), one per hand
  fan: {
    handle: 0,
    head: grid(['..TT', '.TPP', 'TPPP', 'TPPP']).map(([x, y, k]) => [3 - y, -x, k]),
  },
  knife: { handle: 1, head: [[1, 0, 'metal'], [2, 0, 'metal'], [3, 0, 'metalDark']] },
};
// Carried loads, drawn in front of the chest (reference coords, relative to the body bob)
const LOADS = {
  wood: [[-1, 6, 'log'], [0, 6, 'log'], [1, 6, 'log'], [2, 6, 'log'], [3, 6, 'log'], [4, 6, 'log'], [5, 6, 'logEnd'],
    [-1, 7, 'logEnd'], [0, 7, 'log'], [1, 7, 'log'], [2, 7, 'log'], [3, 7, 'log'], [4, 7, 'log'], [5, 7, 'log']],
  gold: [[1, 6, 'gold'], [2, 6, 'gold'], [3, 6, 'metalDark'], [1, 7, 'gold'], [2, 7, 'gold'], [3, 7, 'gold']],
  meat: [[1, 6, 'meat'], [2, 6, 'meat'], [3, 6, 'meat'], [2, 7, 'meat'], [3, 7, 'skin']],
};

const LOAD_SIDE_DX = 2; // loads ride further forward when seen from the side

/**
 * Pose fields (all optional): bob (body y offset), head (extra head y), blink,
 * armL / armR (degrees), liftL / liftR (leg lift px), tool { type, angle (relative to the right arm) },
 * load ('wood' | 'gold' | 'meat'), hover (px the whole figure floats), poncho ('closed' | 'open' | 'flutter'),
 * armsOver (arms drawn over the poncho), lean (px the chest and head shift forward/right, the head
 * the most), stance (px the feet spread apart), legAngle (side view: legs as bones swung back),
 * front/back/side (overrides for that view).
 * `view` is 'front' | 'back' | 'side'.
 */
function renderPose(basePose, colors, view, hair, body) {
  // A pose may carry per-view overrides: { ..., side: { armR: -60 } }
  const pose = basePose[view] ? { ...basePose, ...basePose[view] } : basePose;
  const [SHOULDER_L, SHOULDER_R] = body.shoulders;
  const SHOULDER_SIDE = body.shoulderSide;
  const buf = new Uint8ClampedArray(FRAME_W * FRAME_H * 4);
  let shiftX = () => 0; // per-row horizontal offset (side-view lean)
  const put = (x, y, key) => {
    const px = Math.round(x) + shiftX(y) + OX;
    const py = Math.round(y - (pose.hover ?? 0)) + OY;
    if (px < 0 || py < 0 || px >= FRAME_W || py >= FRAME_H) return;
    const c = colors[key];
    const i = (py * FRAME_W + px) * 4;
    buf[i] = c >> 16; buf[i + 1] = (c >> 8) & 255; buf[i + 2] = c & 255; buf[i + 3] = 255;
  };
  const bob = pose.bob ?? 0;
  // `key` may be a list: one colour per pixel along the line, the last one repeating
  const keyAt = (key, i) => (Array.isArray(key) ? key[Math.min(i, key.length - 1)] : key);
  const line = (x, y, deg, len, key) => {
    const [dx, dy] = dir(deg);
    for (let i = 0; i < len; i++) put(x + dx * i, y + dy * i, keyAt(key, i));
    return [x + dx * (len - 1), y + dy * (len - 1)];
  };
  // An arm; thick arms get a second line on the outer side (`out` = -1 left, 1 right)
  const arm = (x, y, deg, len, out) => {
    if (body.armWidth > 1) line(x + out, y, deg, len, body.armOuter ?? body.arm);
    return line(x, y, deg, len, body.arm);
  };
  // Straight pixel line between two points (for an arm reaching a grip)
  const lineTo = (x0, y0, x1, y1, key) => {
    const n = Math.max(Math.abs(Math.round(x1 - x0)), Math.abs(Math.round(y1 - y0)), 1);
    for (let i = 0; i <= n; i++) put(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, keyAt(key, i));
  };
  // Where the second hand holds a two-handed tool: just above the leading hand on the handle
  const grip = (hand) => {
    const [dx, dy] = dir((pose.armR ?? 0) + pose.tool.angle);
    return [hand[0] + dx * 2, hand[1] + dy * 2];
  };
  const twoHanded = pose.tool && (pose.tool.twoHanded ?? TOOLS[pose.tool.type].twoHanded);
  const handAt = (shoulder, deg) => {
    const [dx, dy] = dir(deg);
    return [shoulder[0] + dx * (ARM_LEN - 1), shoulder[1] + bob + dy * (ARM_LEN - 1)];
  };
  const side = view === 'side';
  // Draws a held tool; the left hand's tool (`toolL`, angle relative to armL) is mirrored
  const drawTool = (hand, spec = pose.tool, armDeg = pose.armR ?? 0, mirror = 1) => {
    if (!spec) return;
    const tool = TOOLS[spec.type];
    const deg = armDeg + spec.angle * mirror;
    const [ax, ay] = dir(deg);
    const back = tool.back ?? 0;
    for (let i = 0; i <= tool.handle + back; i++) {
      const key = tool.bands?.includes(i) ? 'staffBand' : tool.key ?? 'wood';
      put(hand[0] + ax * (i - back), hand[1] + ay * (i - back), key);
    }
    const tip = [hand[0] + ax * tool.handle, hand[1] + ay * tool.handle];
    const [px, py] = dir(deg + 90);
    for (const [a, p, k] of tool.head) put(tip[0] + ax * a + px * p * mirror, tip[1] + ay * a + py * p * mirror, k);
  };
  const drawToolL = (hand) => pose.toolL && drawTool(hand, pose.toolL, pose.armL ?? 0, -1);
  // Puffs of air pushed out by the fans: [x, y, key] in reference coords, relative to the body bob
  const drawGust = () => {
    for (const [x, y, k] of pose.gust ?? []) put(x, y + bob, k);
  };
  const hairPixels = (v) => [...hair[v], ...(body.band ? hair.band[v] : [])];
  const drawLoad = (dx) => {
    if (pose.load) for (const [x, y, k] of LOADS[pose.load]) put(x + dx, y + bob, k);
  };
  const liftL = pose.liftL ?? 0;
  const liftR = pose.liftR ?? 0;
  // Ponchos (flyer) cover the arms unless the pose throws them out over it
  const ponchoOver = body.poncho && !pose.armsOver;
  const drawPoncho = (v) => {
    if (!body.poncho) return;
    for (const [x, y, k] of body.poncho[v][pose.poncho ?? 'closed']) put(x, y + bob, k);
  };

  // Leaning: pixels above the hips move forward (side) or to the right (front/back) in whole
  // pixels, the head most and the chest less - the bones shift, nothing rotates
  const lean = pose.lean ?? 0;
  if (lean) {
    shiftX = (y) => {
      const row = y - bob;
      if (row >= 9) return 0;
      if (row >= 7) return Math.round(lean / 3);
      if (row >= 5) return Math.round(lean / 2);
      return lean;
    };
  }
  const stance = pose.stance ?? 0;

  if (side) {
    if (pose.legAngle != null) {
      // Legs as bones from the hip, swung back; the far leg trails a little higher
      for (const [hipX, extra] of [[2, -25], [1, 0]]) line(hipX, 10, pose.legAngle + extra, body.legBone.length, body.legBone);
    } else {
      // Walking from the side: the lifted leg steps forward, the other pushes back
      const stride = liftL - liftR + stance;
      const legs = [[body.legSide(2 - stride), liftR], [body.legSide(1 + stride), liftL]];
      for (const [pixels, lift] of legs) for (const [x, y, k] of pixels) if (y - lift >= 10) put(x, y - lift, k);
    }
    // Carrying: both arms reach forward to hold the load
    const armBack = pose.load ? 60 : -(pose.armR ?? 0) * (pose.tool ? 0 : 1) + (pose.tool ? 20 : 0);
    const armFront = pose.load ? 60 : (pose.armR ?? 0);
    const frontHand = handAt(SHOULDER_SIDE, armFront);
    const backDeg = pose.toolL ? -(pose.armL ?? 0) : armBack;
    if (twoHanded) lineTo(SHOULDER_SIDE[0], SHOULDER_SIDE[1] + bob, ...grip(frontHand), body.arm);
    else line(SHOULDER_SIDE[0], SHOULDER_SIDE[1] + bob, backDeg, ARM_LEN - 1, body.arm);
    // The back hand's fan peeks out from behind the body
    if (pose.toolL) drawTool(handAt(SHOULDER_SIDE, backDeg), pose.toolL, backDeg, 1);
    for (const [x, y, k] of body.torsoSide) put(x, y + bob, k);
    const frontArm = () => arm(SHOULDER_SIDE[0], SHOULDER_SIDE[1] + bob, armFront, ARM_LEN, -1);
    if (ponchoOver) frontArm();
    drawPoncho('side');
    const headY = bob + (pose.head ?? 0);
    for (const [x, y, k] of [...(body.face?.side ?? FACE_SIDE), ...(pose.blink ? BLINK_SIDE : []), ...hairPixels('side')]) put(x, y + headY, k);
    drawLoad(LOAD_SIDE_DX);
    if (!ponchoOver) frontArm();
    drawTool(frontHand);
    drawGust();
    if (twoHanded) put(...grip(frontHand), 'skin');
    return buf;
  }

  const back = view === 'back';
  // Seen from behind, whatever is held in front is hidden by the body
  const hand = handAt(SHOULDER_R, pose.armR ?? 0);
  const handL = handAt(SHOULDER_L, pose.armL ?? 0);
  if (back) {
    drawLoad(0);
    drawTool(hand);
    drawToolL(handL);
    drawGust();
  }
  // Legs stay planted; a lifted leg is shortened from the bottom up
  const [legL, legR] = back ? body.legsBack : body.legs;
  for (const [pixels, lift, dx] of [[legL, liftL, -stance], [legR, liftR, stance]]) {
    for (const [x, y, k] of pixels) if (y < 10 || y - lift >= 10) put(x + dx * (y - 9) / 4, y - lift, k);
  }
  for (const [x, y, k] of back ? body.torsoBack : body.torso) put(x, y + bob, k);
  const arms = () => {
    if (twoHanded) lineTo(SHOULDER_L[0], SHOULDER_L[1] + bob, ...grip(hand), body.arm);
    else arm(SHOULDER_L[0], SHOULDER_L[1] + bob, pose.armL ?? 0, ARM_LEN, -1);
    if (!back) drawLoad(0);
    arm(SHOULDER_R[0], SHOULDER_R[1] + bob, pose.armR ?? 0, ARM_LEN, 1);
  };
  if (ponchoOver) arms();
  drawPoncho(back ? 'back' : 'front');
  const headY = bob + (pose.head ?? 0);
  const face = back ? body.face?.back ?? FACE_BACK : body.face?.front ?? FACE;
  const head = back ? [...face, ...hairPixels('back')] : [...face, ...(pose.blink ? BLINK : []), ...hairPixels('front')];
  for (const [x, y, k] of head) put(x, y + headY, k);
  if (!ponchoOver) arms();
  if (!back) {
    drawTool(hand);
    drawToolL(handL);
    drawGust();
    if (twoHanded) put(...grip(hand), 'skin');
  }
  return buf;
}

export const VIEWS = ['front', 'back', 'side'];

// Swing poses for a tool: wind-up overhead, strike, follow-through
const swing = (type, angles, toolAngle) => angles.map(([armR, bob]) => ({
  armR, armL: 15, bob, tool: { type, angle: toolAngle },
}));

// Animation name -> list of poses (names match the old sprite sheets so game code is unchanged)
const VILLAGER_ANIMATIONS = {
  idle: [{}, {}, {}, { bob: 1 }, { bob: 1 }, { bob: 1, blink: true }],
  run: [
    { liftL: 1, bob: 1, armL: 30, armR: -30 },
    { armL: 0, armR: 0 },
    { liftR: 1, bob: 1, armL: -30, armR: 30 },
    { armL: 0, armR: 0 },
  ],
  axe: swing('axe', [[160, 0], [175, 0], [110, 1], [55, 1], [55, 1], [100, 0]], 70),
  pickaxe: swing('pickaxe', [[150, 0], [170, 0], [100, 1], [45, 1], [45, 1], [100, 0]], 80),
  hammer: swing('hammer', [[130, 0], [140, 0], [80, 1], [55, 1]], 80),
  knife: [
    { armR: 70, armL: 15, tool: { type: 'knife', angle: 20 } },
    { armR: 95, armL: 15, bob: 1, tool: { type: 'knife', angle: 0 } },
    { armR: 45, armL: 15, bob: 1, tool: { type: 'knife', angle: 40 } },
  ],
};
for (const load of ['wood', 'gold', 'meat']) {
  VILLAGER_ANIMATIONS[`run_${load}`] = [
    { liftL: 1, bob: 1, armL: 40, armR: -40, load },
    { armL: 40, armR: -40, load },
    { liftR: 1, bob: 1, armL: 40, armR: -40, load },
    { armL: 40, armR: -40, load },
  ];
}

const staff = (angle, twoHanded = false) => ({ type: 'staff', angle, twoHanded });
const WARRIOR_ANIMATIONS = {
  idle: [
    { armR: 0, tool: staff(180) }, { armR: 0, tool: staff(180) },
    { armR: 0, bob: 1, tool: staff(180) }, { armR: 0, bob: 1, blink: true, tool: staff(180) },
  ],
  run: [
    { liftL: 1, bob: 1, armL: 30, armR: 15, tool: staff(160) },
    { armL: 0, armR: 15, tool: staff(160) },
    { liftR: 1, bob: 1, armL: -30, armR: 15, tool: staff(160) },
    { armL: 0, armR: 15, tool: staff(160) },
  ],
  // Two-handed overhead swing ending in a forward strike
  attack: [[150, 0], [170, 0], [110, 1], [65, 1], [65, 1], [110, 0]].map(([armR, bob]) => ({
    armR, bob, tool: staff(70, true),
  })),
};

const fans = (armR, armL, angle, extra = {}) => ({
  armR, armL, tool: { type: 'fan', angle }, toolL: { type: 'fan', angle }, ...extra,
});
const W = 'windWhite';
const G = 'windGray';
const B = 'windBlue';
const AIR_ANIMATIONS = {
  idle: [
    fans(15, -15, 165), fans(15, -15, 165),
    fans(15, -15, 165, { bob: 1 }), fans(15, -15, 165, { bob: 1, blink: true }),
  ],
  run: [
    fans(40, -10, 150, { liftL: 1, bob: 1 }),
    fans(20, -20, 160),
    fans(10, -40, 150, { liftR: 1, bob: 1 }),
    fans(20, -20, 160),
  ],
  // Fans swept up and back, then flung forward together, releasing a puff of air
  shoot: [
    fans(150, -150, 40),
    fans(170, -170, 20, { bob: 1 }),
    fans(110, -110, 70, { gust: [[8, 4, W], [9, 3, G], [8, 6, B]] }),
    fans(80, -80, 90, {
      bob: 1,
      gust: [[9, 5, W], [10, 4, W], [11, 6, B], [10, 7, G], [12, 4, G], [9, 8, B], [-4, 5, W], [-5, 6, B]],
    }),
    fans(70, -70, 100, { gust: [[12, 5, W], [13, 3, B], [14, 6, G], [12, 8, B], [-7, 6, G]] }),
    fans(40, -40, 140, { gust: [[15, 5, G], [16, 7, B]] }),
  ],
};

// Flyer: rests on the ground with the poncho closed and flaps it like wings in flight. Altitude is
// applied by the game (the frames stay on the ground line). `takeoff` and `attack` are stepped
// through by the game rather than played: takeoff = crouch, crouch, launch; attack = impact,
// rise, rise, apex, dive.
const ring = (r, keys) => Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  return [2 + Math.cos(a) * r * 1.6, 8 + Math.sin(a) * r * 0.7, keys[i % keys.length]];
});
const FLYER_ANIMATIONS = {
  idle: [
    { poncho: 'closed' }, { poncho: 'closed' },
    { poncho: 'closed', bob: 1 }, { poncho: 'closed', bob: 1, blink: true },
  ],
  takeoff: [
    { poncho: 'closed', bob: 2 },
    { poncho: 'closed', bob: 3, gust: ring(4, [W, B]) },
    { poncho: 'wide', liftL: 1, liftR: 1, gust: ring(6, [G, W, B]) },
  ],
  // Wing beat: spread, downstroke, spread, folding, folded, spread; legs trail loosely
  // From the side the body leans forward and the legs stream out behind (legAngle)
  run: [
    { poncho: 'open', lean: 3, legAngle: -55 },
    { poncho: 'wide', liftL: 1, lean: 3, legAngle: -60 },
    { poncho: 'wide', liftL: 1, liftR: 1, lean: 3, legAngle: -65 },
    { poncho: 'open', liftR: 1, lean: 3, legAngle: -60 },
    { poncho: 'flutter', bob: 1, lean: 3, legAngle: -50 },
    { poncho: 'flutter', lean: 3, legAngle: -50 },
  ],
  attack: [
    { poncho: 'open', bob: 3, armsOver: true, armL: -90, armR: 90, gust: ring(5, [W, B, G, W]) },
    { poncho: 'flutter', bob: 1 },
    { poncho: 'wide', liftL: 1, liftR: 1, lean: 1, legAngle: -30 },
    { poncho: 'open', lean: 2, legAngle: -45 },
    // Dive: poncho wrapped tight, arms thrust down-forward, head first, legs kicked up behind
    {
      poncho: 'closed', armsOver: true, armL: 140, armR: 140, liftL: 1, liftR: 1, lean: 4, head: 1, legAngle: -110,
    },
  ],
};

// Monk: walks with the tall staff; heals by raising it, sparkles gathering at its tip
const tall = (angle) => ({ type: 'tallStaff', angle });
const sparkle = (pts) => pts.map(([x, y], i) => [x, y, i % 2 ? 'healGold' : 'healGreen']);
const MONK_ANIMATIONS = {
  idle: [
    { tool: tall(180) }, { tool: tall(180) },
    { bob: 1, tool: tall(180) }, { bob: 1, blink: true, tool: tall(180) },
  ],
  run: [
    { liftL: 1, bob: 1, armL: 25, armR: 10, tool: tall(170) },
    { armL: 0, armR: 10, tool: tall(170) },
    { liftR: 1, bob: 1, armL: -25, armR: 10, tool: tall(170) },
    { armL: 0, armR: 10, tool: tall(170) },
  ],
  heal: [
    { armR: 60, armL: -20, tool: tall(120) },
    { armR: 120, armL: -60, tool: tall(60), gust: sparkle([[5, -8], [8, -7]]) },
    { armR: 150, armL: -90, tool: tall(30), gust: sparkle([[5, -10], [8, -9], [6, -12], [9, -11]]) },
    { armR: 150, armL: -90, bob: 1, tool: tall(30), gust: sparkle([[4, -9], [9, -10], [6, -13], [7, -8], [5, -12]]) },
  ],
};

// Fire swordsman: a sword in each hand; attacks with alternating slashes, right then left
const swords = (armR, armL, angle, extra = {}) => ({
  armR, armL, tool: { type: 'sword', angle }, toolL: { type: 'sword', angle }, ...extra,
});
const DUAL_ANIMATIONS = {
  // Low guard: blades angled down and out
  idle: [
    swords(10, -10, 40), swords(10, -10, 40),
    swords(10, -10, 40, { bob: 1 }), swords(10, -10, 40, { bob: 1, blink: true }),
  ],
  // Sprint leaning forward, both blades swept back behind the body
  run: [
    swords(30, -30, 20, { liftL: 1, bob: 1, lean: 2, side: { armR: -70, armL: 70, tool: { type: 'sword', angle: -45 }, toolL: { type: 'sword', angle: -45 } } }),
    swords(35, -35, 15, { lean: 2, side: { armR: -60, armL: 60, tool: { type: 'sword', angle: -50 }, toolL: { type: 'sword', angle: -50 } } }),
    swords(30, -30, 20, { liftR: 1, bob: 1, lean: 2, side: { armR: -70, armL: 70, tool: { type: 'sword', angle: -45 }, toolL: { type: 'sword', angle: -45 } } }),
    swords(35, -35, 15, { lean: 2, side: { armR: -60, armL: 60, tool: { type: 'sword', angle: -50 }, toolL: { type: 'sword', angle: -50 } } }),
  ],
  // Wide stance: right slash, left slash, then both blades together
  attack: [
    swords(120, -120, 40, { stance: 1, side: { stance: 2 } }),
    { ...swords(50, -130, 10, { stance: 1, bob: 1, side: { stance: 2 } }), toolL: { type: 'sword', angle: 40 } },
    { ...swords(110, -50, 10, { stance: 1, bob: 1, side: { stance: 2, armR: 80, armL: -45 } }), tool: { type: 'sword', angle: 40 } },
    swords(165, -165, 20, { stance: 1, side: { stance: 2 } }),
    swords(60, -60, 10, { stance: 1, bob: 1, lean: 1, side: { stance: 2 } }),
    swords(35, -35, 20, { stance: 1, bob: 1, side: { stance: 2 } }),
  ],
};

// Fire mage: a flame flickers in the right hand; to attack it draws back, gathers a growing fireball
// in both hands and hurls it forward
const FW = 'fireWhite';
const FY = 'fireYellow';
const FO = 'fireOrange';
const FR = 'fireRed';
// Flame pixels at a point (x, y = the flame's base), size 0..3
const flame = (x, y, size, flick = 0) => {
  const px = [[x, y, FY], [x, y - 1, FO]];
  if (size > 0) px.push([x + 1, y, FO], [x - 1, y, FR], [x, y - 2 - flick, FR]);
  if (size > 1) px.push([x, y + 1, FW], [x + 1, y - 1, FY], [x - 1, y - 1, FO], [x + 1, y - 2, FR]);
  if (size > 2) px.push([x - 1, y + 1, FY], [x + 1, y + 1, FY], [x, y + 2, FO], [x - 2, y, FR], [x + 2, y, FR], [x, y - 3, FR]);
  return px;
};
const MAGE_ANIMATIONS = {
  idle: [0, 1, 0, 1].map((f, i) => ({ armR: 60, bob: i > 1 ? 1 : 0, blink: i === 3, gust: flame(7, 6, f, f) })),
  run: [
    { liftL: 1, bob: 1, armL: 30, armR: 60, gust: flame(7, 7, 0, 1) },
    { armL: 0, armR: 60, gust: flame(7, 6, 0) },
    { liftR: 1, bob: 1, armL: -30, armR: 60, gust: flame(7, 7, 0, 1) },
    { armL: 0, armR: 60, gust: flame(7, 6, 0) },
  ],
  shoot: [
    { armR: 150, armL: -150, gust: flame(2, 1, 0) },
    { armR: 170, armL: -170, bob: 1, gust: flame(2, 0, 1) },
    { armR: 120, armL: -120, gust: flame(2, 1, 2) },
    { armR: 90, armL: 90, bob: 1, gust: flame(8, 6, 3) },
    { armR: 80, armL: 80, gust: [...flame(11, 7, 1), [9, 7, FO], [8, 8, FR]] },
    { armR: 40, armL: -20, gust: [[13, 6, FR], [14, 7, FO]] },
  ],
};

// Same animations with the wind pixels swapped for fire
const toFire = { windWhite: 'fireYellow', windBlue: 'fireOrange', windGray: 'fireRed' };
const fireGusts = (anims) => Object.fromEntries(Object.entries(anims).map(([name, poses]) => [name, poses.map((p) => (
  p.gust ? { ...p, gust: p.gust.map(([x, y, k]) => [x, y, toFire[k] ?? k]) } : p))]));

const RIGS = {
  villager: { body: BODIES.villager, animations: VILLAGER_ANIMATIONS },
  warrior: { body: BODIES.warrior, animations: WARRIOR_ANIMATIONS },
  air: { body: BODIES.air, animations: AIR_ANIMATIONS },
  flyer: { body: BODIES.flyer, animations: FLYER_ANIMATIONS },
  // Fire civilization variants (units without one fall back to the air art)
  villager_fire: { body: BODIES.villager_fire, animations: VILLAGER_ANIMATIONS },
  warrior_fire: { body: BODIES.warrior_fire, animations: DUAL_ANIMATIONS },
  air_fire: { body: BODIES.air_fire, animations: MAGE_ANIMATIONS },
  flyer_fire: { body: BODIES.flyer_fire, animations: fireGusts(FLYER_ANIMATIONS) },
  monk: { body: BODIES.monk, animations: MONK_ANIMATIONS },
};
export const RIG_NAMES = Object.keys(RIGS);

/**
 * Renders every animation of one rig in every view and hair style for one team colour.
 * @returns {Record<string, Uint8ClampedArray[]>} `${style}_${view}_${animation}` -> RGBA frames of FRAME_W x FRAME_H
 */
export function buildRigFrames(rig, teamColor = PALETTE.team) {
  const { body, animations } = RIGS[rig];
  const colors = { ...PALETTE, team: teamColor };
  const sheets = {};
  for (const style of HAIR_STYLES) {
    for (const view of VIEWS) {
      for (const [name, poses] of Object.entries(animations)) {
        const hair = { ...HAIR[style], ...body.hair?.[style], band: BAND[style] };
        sheets[`${style}_${view}_${name}`] = poses.map((p) => renderPose(p, colors, view, hair, body));
      }
    }
  }
  return sheets;
}
