// walkin.preflight() — the 30-second check before you present, in one command.
//
// The runbook has a table you read down by hand. At 11:55 in a loud room nobody reads down a table,
// so this runs the same checks and prints a list of ✓ and ✗ with the number that made the call.
// It is read-only about the demo: whatever is in the room is saved before it starts and put back
// after, so running it never costs you your staging.
//
// Nothing here is loaded or called unless someone asks for it.
import { FURNITURE } from './furniture.js';

const ok = (name, note) => ({ name, ok: true, note });
const no = (name, note) => ({ name, ok: false, note });

/** Frames rendered in `ms`, as a rate. */
function fps(ms = 1000) {
  return new Promise((done) => {
    let n = 0;
    const t0 = performance.now();
    (function spin() {
      n++;
      if (performance.now() - t0 < ms) requestAnimationFrame(spin);
      else done(Math.round((n * 1000) / (performance.now() - t0)));
    })();
  });
}

export async function preflight({ quiet = false } = {}) {
  const w = window.walkin;
  const rows = [];
  if (!w || !w.house) {
    rows.push(no('the house', 'the viewer has not finished loading'));
    if (!quiet) print(rows);
    return rows;
  }

  // ---------------------------------------------------------------- the house itself
  const rooms = (w.house.rooms || []).filter((r) => r.poly && r.poly.length >= 3);
  const panos = (w.house.panos || []).length;
  rows.push(rooms.length && panos
    ? ok('the house', `${w.house.name} — ${panos} scan points, ${rooms.length} rooms with outlines`)
    : no('the house', `${panos} scan points, ${rooms.length} rooms with outlines — one of those should not be 0`));

  // ---------------------------------------------------------------- John
  try {
    const h = await (await fetch('/api/health')).json();
    const live = h.gemini || h.openrouter;
    rows.push(live || h.mock
      ? ok('John answers', live ? `${h.provider || 'live'} key, voice ${h.tts ? 'on' : 'OFF — he will be read, not heard'}`
        : 'MOCK replies — every scripted line still works, nothing dies on stage')
      : no('John answers', 'no key and no mock: restart with GEMINI_MOCK=1 python3 serve.py'));
  } catch (e) {
    rows.push(no('John answers', '/api/health did not reply — is serve.py the one you just pulled?'));
  }

  // ---------------------------------------------------------------- staging, without losing the room
  const saved = typeof w.saveLayout === 'function' ? w.saveLayout() : null;
  try {
    const here = w.roomAt(w.current.pos[0], w.current.pos[1], w.current.floor);
    if (typeof w.stageRoom !== 'function') rows.push(no('staging', 'staging.js never loaded'));
    else if (!here) rows.push(no('staging', 'you are not standing in a room — walk inside and run it again'));
    else {
      const t0 = performance.now();
      const r = w.stageRoom(here, 'modern');
      const ms = Math.round(performance.now() - t0);
      rows.push(r.placed.length
        ? ok('staging', `${r.placed.length} pieces in the ${(here.label || '').toLowerCase()} in ${ms} ms, ${r.fits ? 'all of it fits' : 'SOME OF IT DOES NOT FIT'}`)
        : no('staging', r.say));
    }
  } catch (e) {
    rows.push(no('staging', String(e.message || e)));
  }

  // ---------------------------------------------------------------- the sofa-through-the-door beat
  if (typeof w.doorsFor === 'function') {
    const doors = w.doorsFor('sofa');
    const turned = doors.filter((d) => d.fits === 'turned').sort((a, b) => b.width - a.width);
    rows.push(turned.length
      ? ok('the door beat', `${turned.length} of ${doors.length} doorways give the "turn it" answer — the roomiest is `
        + `${turned[0].width} m, ${turned[0].metresAway} m from scan point ${turned[0].scanPoint}`)
      : no('the door beat', `none of ${doors.length} doorways fit a sofa turned: beat 5 will only ever say `
        + '"it won\'t fit through at all" in this house'));
  } else rows.push(no('the door beat', 'fit.js never loaded'));

  // ---------------------------------------------------------------- physics
  if (w.physics && typeof w.physics.probe === 'function') {
    // Probe first, then read the count: the wall graph is built the first time anything asks about it,
    // so reading segments() on a house nobody has moved a piece in yet always answers 0.
    const solid = w.furniture.children.filter((o) => o.userData.kind
      && !(FURNITURE[o.userData.kind] || {}).flat && !(o.userData || {}).on);
    const stuck = solid.filter((o) => w.physics.probe(o, o.position.x, o.position.y, o.rotation.z).hit);
    const segs = w.physics.segments();
    if (!solid.length) {
      // Two red rows for one cause reads like two problems. Say which one to fix.
      const staging = rows.find((r) => r.name === 'staging');
      rows.push(no('physics', staging && !staging.ok
        ? 'nothing to test it against, because the staging check above did not run — fix that one first'
        : 'nothing in the room to test it against — stage a room and run it again'));
    }
    else if (!segs) rows.push(no('physics', 'no wall segments: furniture will walk through walls'));
    else if (stuck.length) rows.push(no('physics', `${stuck.length} of ${solid.length} pieces are stuck in something`));
    else rows.push(ok('physics', `${segs} wall segments, none of ${solid.length} pieces stuck, enabled: ${w.physics.enabled}`));
  } else rows.push(no('physics', 'physics.js never loaded'));

  // ---------------------------------------------------------------- wallpaper
  if (typeof w.setWallMaterial !== 'function') rows.push(no('wallpaper', 'walls.js never loaded'));
  else {
    try {
      const res = await fetch('models/textures/brick_red.jpg', { method: 'HEAD' });
      rows.push(res.ok
        ? ok('wallpaper', 'walls.js ready and the fallback tiles are on disk, so the beat survives a missing key')
        : no('wallpaper', 'walls.js is ready but models/textures/ is missing — run python3 tools/make_tiles.py'));
    } catch (e) { rows.push(no('wallpaper', `models/textures/ unreachable: ${e.message || e}`)); }
  }

  // ---------------------------------------------------------------- what is already stored for this house
  // The single most likely surprise on stage is last night's furniture reappearing, because layouts
  // persist on purpose. Say so before it happens rather than after.
  const stored = typeof w.storedLayout === 'function' ? w.storedLayout(w.house.model) : null;
  const n0 = stored && stored.items ? stored.items.length : 0;
  const w0 = stored && stored.walls ? stored.walls.length : 0;
  rows.push(!n0 && !w0
    ? ok('stored layout', 'nothing stored for this house: it opens empty')
    : no('stored layout', `${n0} piece${n0 === 1 ? '' : 's'}${w0 ? ` and ${w0} wall${w0 === 1 ? '' : 's'}` : ''} `
      + 'from an earlier session will come back on a reload — open with &layout=none to start clean'));

  // ---------------------------------------------------------------- hands and the headset
  // Two different questions, and only one of them is answerable from here. Whether the camera works
  // needs a camera. Whether MediaPipe will load without the venue's Wi-Fi is a HEAD request, and it is
  // the one that bites at a hackathon: the model is 7.8 MB off storage.googleapis.com unless the local
  // copies are both present and used (#50).
  if (typeof w.hands !== 'object' && typeof w.handRay !== 'function') {
    rows.push(no('hands', 'hands.js never loaded'));
  } else {
    let local = false;
    try {
      const [lib, model] = await Promise.all([
        fetch('vendor/mediapipe/tasks-vision@0.10.14/vision_bundle.mjs', { method: 'HEAD' }),
        fetch('vendor/mediapipe/hand_landmarker.task', { method: 'HEAD' }),
      ]);
      local = lib.ok && model.ok;
    } catch (e) { local = false; }
    rows.push(local
      ? ok('hands', 'hooks there and MediaPipe is on disk, so no venue Wi-Fi needed — this still does '
        + 'NOT prove the camera works, press ✋ and look')
      : no('hands', 'hooks are there, but vendor/mediapipe is missing — the hands will try to fetch '
        + '7.8 MB from googleapis.com when you press ✋'));
  }

  // ---------------------------------------------------------------- frame rate, as it stands now
  const rate = await fps(1200);
  const n = w.furniture.children.filter((o) => o.userData.kind).length;
  rows.push(rate >= 45
    ? ok('frame rate', `${rate} fps with ${n} pieces`)
    : no('frame rate', `${rate} fps with ${n} pieces — under 45, check it in the headset before you rely on it`));

  // ---------------------------------------------------------------- put the room back
  if (saved && typeof w.loadLayout === 'function') w.loadLayout(saved);
  else if (typeof w.clearLayout === 'function') w.clearLayout();

  if (!quiet) print(rows);
  return rows;
}

function print(rows) {
  const bad = rows.filter((r) => !r.ok).length;
  console.log(`%cWalk-In preflight — ${rows.length - bad}/${rows.length} ok`,
    `font-weight:600;color:${bad ? '#c0392b' : '#2d7'}`);
  for (const r of rows) {
    console.log(`%c${r.ok ? '✓' : '✗'} ${r.name}%c  ${r.note}`,
      `color:${r.ok ? '#2d7' : '#c0392b'};font-weight:600`, 'color:inherit');
  }
  if (bad) console.log('%cWhat to do about each one is in docs/demo-runbook.md.', 'color:#888');
}

/**
 * The same nine lines, on the screen instead of in the console — because the demo device is a phone
 * in a headset and a phone has no console. `?preflight` in the URL runs it once the house is up and
 * shows the result; tap it to dismiss. Everything else about it is unchanged, including putting back
 * whatever furniture was in the room.
 */
function panel(rows) {
  const bad = rows.filter((r) => !r.ok).length;
  const el = document.createElement('div');
  el.id = 'preflightPanel';
  el.className = 'panel';
  el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:20;'
    + 'max-width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 64px);overflow:auto;'
    + 'padding:16px 18px;border-radius:22px;font:500 13px/1.45 system-ui,sans-serif;cursor:pointer';
  el.innerHTML = `<div style="font-weight:600;margin-bottom:8px;color:${bad ? '#ff5a5f' : '#3ccf8e'}">`
    + `Walk-In preflight — ${rows.length - bad}/${rows.length} ok</div>`
    + rows.map((r) => `<div style="margin:3px 0"><span style="color:${r.ok ? '#3ccf8e' : '#ff5a5f'};`
      + `font-weight:600">${r.ok ? '✓' : '✗'} ${r.name}</span> <span style="opacity:.8">${r.note}</span></div>`).join('')
    + '<div style="margin-top:10px;opacity:.6">tap to dismiss</div>';
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
}

(function start(tries = 0) {
  if (!window.walkin) {
    if (tries < 600) return setTimeout(() => start(tries + 1), 50);
    return;
  }
  window.walkin.preflight = preflight;
  if (new URLSearchParams(location.search).has('preflight')) {
    setTimeout(() => preflight().then(panel).catch((e) => console.warn('preflight:', e)), 1200);
  }
})();
