// #58: put a plant on a table by hand, the way walkin.placeObject already does by voice, and take it off again.
//
// The frame loop in physics.js treats a table as a solid neighbour, so a plant carried at a coffee table bumps
// into it and stops beside it on the floor, while the hand is over the table. So the moment that matters is
// letting go: app.js calls setDown() with where the hand wanted the piece, and if that is on a table the piece
// is close to, the piece goes on top, linked with userData.on exactly like placeObject does (physics then
// carries it with the table, layout.js saves the link). Grabbing it again calls liftOff(), because physics
// skips anything standing on something and the plant would otherwise never move in the hand.
import { FURNITURE, PLANTS } from './furniture.js';
import { footprint, pointInPoly } from './fit.js';

// Things you can stand something on: the same list staging.js's placeObject uses.
export const SUPPORTS = ['table', 'desk', 'coffeetable', 'sidetable', 'nightstand', 'tvstand', 'bookcase'];
// What a hand may stand on one. A chair let go at a dining table stays on the floor.
export const ON_TOP = [...PLANTS, 'tv'];
// How far from the table's edge the piece may have stopped. It stops where it touched the table (#58 measured
// 0.69 m short of the table's centre), plus the hand's own grab offset.
export const REACH = 0.9;

const z0Of = (item, w) => (typeof item.userData.z0 === 'number' ? item.userData.z0 : (w.current && w.current.floorZ) || 0);
const fpOf = (o, pad = 0) => footprint(o.userData.kind, o.position.x, o.position.y, o.rotation.z, pad);

/** Picked up: it stands on nothing now, so physics moves it with the hand again. */
export function liftOff(item) {
  if (!item || !item.userData || !item.userData.on) return false;
  item.userData.on = null;
  return true;
}

/** The support the hand put (x, y) on, if the piece is close enough to it and in the same room. */
export function supportFor(item, x, y) {
  const w = window.walkin;
  if (!w || !w.furniture || !item || !ON_TOP.includes(item.userData.kind) || x == null || y == null) return null;
  const room = (px, py) => (w.roomAt ? w.roomAt(px, py, item.userData.floor) : null);
  const mine = room(item.position.x, item.position.y);
  return w.furniture.children.find((o) => o !== item && SUPPORTS.includes(o.userData.kind)
    && o.userData.floor === item.userData.floor
    && pointInPoly(x, y, fpOf(o))                                       // the hand is over its top
    && pointInPoly(item.position.x, item.position.y, fpOf(o, REACH))    // the piece is at it, not across the room
    && room(o.position.x, o.position.y) === mine) || null;              // ...and not through a wall
}

/** Pull (x, y) far enough inside the support's top that the piece doesn't hang over the edge. */
function onto(support, x, y, spec) {
  const s = FURNITURE[support.userData.kind];
  const c = Math.cos(support.rotation.z), sn = Math.sin(support.rotation.z);
  const dx = x - support.position.x, dy = y - support.position.y;
  const mx = Math.max(0, s.w / 2 - spec.w / 2), my = Math.max(0, s.d / 2 - spec.d / 2);
  const lx = Math.max(-mx, Math.min(mx, dx * c + dy * sn)), ly = Math.max(-my, Math.min(my, -dx * sn + dy * c));
  return [support.position.x + lx * c - ly * sn, support.position.y + lx * sn + ly * c];
}

/**
 * Let go. (x, y) is where the hand wanted the piece, or null for a throw.
 * On a table it is close to: stand it on top and return the table. Otherwise, if it was lifted off something,
 * put it back on the floor. Returns the support or null.
 */
export function setDown(item, x, y) {
  const w = window.walkin;
  if (!w || !item || !item.userData || !item.userData.kind) return null;
  const z0 = z0Of(item, w);
  const support = supportFor(item, x, y);
  if (!support) {
    if (!item.userData.on && item.position.z > z0 + 0.05) item.position.z = z0;   // carried off a table
    return null;
  }
  const spec = FURNITURE[item.userData.kind];
  const [sx, sy] = onto(support, x, y, spec);
  item.position.set(sx, sy, support.position.z + FURNITURE[support.userData.kind].h);
  if (item.userData.kind === 'tv') item.rotation.z = support.rotation.z;          // a television faces the room
  item.userData.on = support.uuid;
  item.userData.z0 = z0;               // where it goes if the table is taken away (physics.js)
  return support;
}
