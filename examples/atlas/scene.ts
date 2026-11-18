// Atlas shot: lines, words and a camera that moves on cue, with neutral content.
//
// A route draws itself across the frame behind a bead that travels along it;
// its last stretch is dotted at first and then closes into a solid line. A
// jagged line falls, a dashed outline runs round a block, and a ring fills
// part of the way round. The camera pushes in on what lies ahead while it is
// made certain, and pulls back to the whole picture. A title and a note belong
// to the frame and stay where they are; a word lies on the block and goes
// where the block goes. Three bars grow from their feet, and one comes down
// again in two steps. A counter runs with the route. Under it all lies an
// island with a bay, one shape with one light. In the ring a cog spins, and
// slows to rest. A scout runs the last stretch, faster and then slower. A
// line between two posts hangs slack, pulls taut and grows thick, then thins
// as it sags again. A kite comes nearer from far off: its place and its size
// change together, from rest to rest.
//
// It shows: stroke() with points, dash and glow, drawOn() with a share and a
// profile, solidTo(), arcPoints(), cameraTo(), text() in the frame's own layer
// and on a shape, scaleTo() along one axis with a pivot, a counter with
// countTo(), region(), a free-form outline, turnTo() with a speed and a
// profile, travel() with keys of speed, bendTo(), widthTo(), and scaleTo()
// with the profile of a move.

import { arcPoints, bendTo, cameraTo, circle, countTo, drawOn, fadeTo, layer, link, moveTo, polygon, popIn, popOut, rect, region, Rng, scaleTo, shot, solidTo, stagger, stroke, text, travel, turnTo, widthTo, type Key, type StringTables, type Vec2 } from 'skink3-engine';
import { palette } from '../demo/palette.ts';

const SEED = 20261117;

// The route: its first part is certain, its last part is not yet.
const ROUTE: Vec2[] = [[-760, 250], [-520, 60], [-260, 150], [-40, -40], [200, 40]];
const AHEAD: Vec2[] = [[200, 40], [380, 120], [560, -20], [690, -110]];
// The island the route crosses: a few points, clockwise, with a bay on its lower side.
const ISLAND: Vec2[] = [[-820, 130], [-560, -70], [-200, -20], [60, -150], [330, -60], [420, 150], [230, 250], [40, 170], [-180, 330], [-470, 280], [-700, 360]];
const CHART: Vec2[] = [[-760, -330], [-690, -380], [-630, -300], [-560, -350], [-490, -240], [-420, -290], [-350, -170]];

const strings: StringTables = {
  en: { 'title.main': 'Ways to draw a line', 'note.data': 'Example data, made up', 'block.tag': 'Depot', 'count.way': '{n} km' },
  // A pseudo-locale with long strings: the layout has to hold these too.
  'x-long': { 'title.main': 'Several different ways in which a line can be drawn', 'note.data': 'Example data that was made up for this picture', 'block.tag': 'Central depot', 'count.way': '{n} kilometres so far' },
};

const timeline: Key[] = [
  // The bead and the line behind it share a path, a start, a length and a profile.
  popIn('title', { at: 0.3 }),
  fadeTo('note', { at: 1, to: 1, dur: 0.8 }),
  popIn('bead', { at: 0.4 }),
  travel('bead', { at: 1, path: ROUTE, dur: 3, profile: 'ease' }),
  drawOn('route', { at: 1, dur: 3, profile: 'ease' }),
  // The counter runs with the line, and on when the stretch ahead is made certain.
  countTo('way', { at: 1, to: 1280, dur: 3, profile: 'ease' }),
  countTo('way', { at: 7, to: 1940, dur: 1.2 }),
  // What lies ahead appears as dots, and is made a line later.
  drawOn('ahead', { at: 4.2, dur: 1.4 }),
  solidTo('ahead', { at: 7, dur: 1.2 }),
  // A scout runs it while it closes: slow at first, then faster and faster, and slow again where it ends.
  popIn('scout', { at: 6.5 }),
  travel('scout', { at: 7, path: AHEAD, speeds: [[0, 80], [0.9, 620], [1.5, 90]] }),
  popOut('scout', { at: 8.8 }),
  // A share: the ring fills to 62 % and stays there.
  drawOn('share', { at: 2, dur: 1.6, to: 0.62 }),
  drawOn('chart', { at: 0.6, dur: 2.2, profile: 'steady' }),
  fadeTo('fence', { at: 5.5, to: 1, dur: 0.8 }),
  // The line between the posts: taut when the bars are up, slack again later.
  bendTo('line', { at: 3.4, to: 0, dur: 0.9 }),
  bendTo('line', { at: 6.2, to: 0.22, dur: 1.2 }),
  // Taut, it grows thick where it lies; it thins again as it sags.
  widthTo('line', { at: 4.4, to: 16 }),
  widthTo('line', { at: 6.2, to: 5, dur: 1.2 }),
  // The cog is under way when the shot starts, turns at one speed, and comes to rest with the same speed handed on.
  turnTo('cog', { at: -1, dur: 7, speed: 50 }),
  turnTo('cog', { at: 6, dur: 3, speed: 50, profile: 'out' }),
  // Bars: each grows to its height from its lower edge, with an overshoot; the middle one comes down in two steps.
  ...stagger(['bar0', 'bar1', 'bar2'], { at: 2.4, each: 0.25 }, (id, at, i) => scaleTo(id, { at, to: [1, [1.7, 2.8, 2.2][i]!], pivot: [0, 30], dur: 0.7 })),
  scaleTo('bar1', { at: 4.4, to: [1, 2], pivot: [0, 30], dur: 0.5 }),
  scaleTo('bar1', { at: 5, to: [1, 1.2], pivot: [0, 30], dur: 0.5 }),
  // The kite comes nearer: its move and its size share a start, a length and a profile, so it grows as it comes.
  moveTo('kite', { at: 1.6, to: [330, -150], dur: 2.6, profile: 'ease', ramp: 0.5, arc: 0 }),
  scaleTo('kite', { at: 1.6, to: 3.4, dur: 2.6, profile: 'ease', ramp: 0.5 }),
  // The camera: in on the stretch ahead while it closes, and back out to everything.
  cameraTo({ at: 5.6, zoom: 1.7, to: [470, 90], dur: 1.4 }),
  cameraTo({ at: 8.3, zoom: 1, to: [0, 0], dur: 1.3 }),
];

// A far layer of faint dots: it moves and grows less than the stage when the camera does.
const rng = new Rng(SEED, 'far');
const far = Array.from({ length: 34 }, (_, i) => circle({ id: `far${i}`, at: [rng.range(-1500, 1500), rng.range(-800, 800)], r: rng.range(5, 12), fill: 'mid.violet', lit: false, opacity: 0.5 }));

export default shot({
  id: 'atlas',
  seconds: 10,
  seed: SEED,
  palette,
  strings,
  background: { inner: 'deep.night', outer: 'deep.abyss' },
  atmosphere: 'mid.mist',
  layers: [
    layer({ id: 'far', depth: 1.6, nodes: far }),
    layer({
      id: 'stage',
      depth: 0,
      nodes: [
        region({ id: 'island', points: ISLAND, fill: 'deep.ink', backdrop: true }),
        stroke({ id: 'route', points: ROUTE, color: 'accent.amber', width: 9, glow: 0.5 }),
        stroke({ id: 'ahead', points: AHEAD, color: 'accent.amber', width: 9, dash: [0, 22] }),
        circle({ id: 'bead', at: ROUTE[0]!, r: 20, fill: 'light.cream', glow: 0.6 }),
        circle({ id: 'scout', at: AHEAD[0]!, r: 12, fill: 'accent.aqua', glow: 0.5 }),
        stroke({ id: 'chart', points: CHART, color: 'accent.coral', width: 7, smooth: 0 }),
        rect({ id: 'block', at: [560, 300], w: 240, h: 150, fill: 'dark.indigo', children: [text({ id: 'tag', text: 'block.tag', ink: 'light.cream', size: 34, maxWidth: 200 })] }),
        stroke({ id: 'fence', at: [560, 300], points: [[-150, -105], [150, -105], [150, 105], [-150, 105]], closed: true, smooth: 0.25, color: 'mid.mist', width: 5, dash: [18, 14], opacity: 0 }),
        link({ id: 'line', from: 'post0', to: 'post1', color: 'mid.mist', width: 5, bend: -0.3 }),
        circle({ id: 'post0', at: [-760, -120], r: 14, fill: 'mid.rose' }),
        circle({ id: 'post1', at: [-480, -150], r: 14, fill: 'mid.rose' }),
        ...[0, 1, 2].map((i) => rect({ id: `bar${i}`, at: [762 + i * 58, 440], w: 46, h: 60, radius: 8, fill: 'mid.ocean' })),
        polygon({ id: 'kite', at: [860, -385], sides: 4, r: 11, fill: 'accent.pink' }),
        polygon({ id: 'cog', at: [-180, -300], sides: 6, r: 38, fill: 'mid.violet' }),
        stroke({ id: 'ring', at: [-180, -300], points: arcPoints([0, 0], 70, 0, 360), closed: true, color: 'dark.haze', width: 16 }),
        stroke({ id: 'share', at: [-180, -300], points: arcPoints([0, 0], 70, -90, 270), color: 'accent.aqua', width: 16, glow: 0.4 }),
      ],
    }),
    // What belongs to the frame: the camera neither moves nor zooms a layer with parallax 0.
    layer({
      id: 'frame',
      depth: 0,
      parallax: 0,
      nodes: [
        text({ id: 'title', text: 'title.main', ink: 'light.cream', at: [0, -455], size: 60, maxWidth: 1100, maxLines: 2 }),
        text({ id: 'note', text: 'note.data', ink: 'mid.mist', at: [-900, 490], align: 'left', size: 26, weight: 600, opacity: 0 }),
        text({ id: 'way', text: 'count.way', ink: 'accent.amber', at: [900, -455], align: 'right', size: 40, count: 0 }),
      ],
    }),
  ],
  timeline,
});
