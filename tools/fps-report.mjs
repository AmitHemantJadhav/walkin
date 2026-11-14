// A1: read back the frame rates the page reported from the headset (app.js reportFps, one line per 10 s).
//   node tools/fps-report.mjs <server access log>     e.g. the log scripts/live.sh writes serve.py's output to
// One row per page load (sid): device, screen, how many reports, the median and worst 10 s median, and the
// resolution / hand rate / draws it ended on, then every 10 s window as fps@pixelRatio.
// A1 is met when an ios row says OK: the session median AND the last window are both >= 45. The pixel ratio
// climbs while frames are cheap, so the last window is where the phone settled; a good median alone can hide
// a session that ended at 38 (#2). Under 3 windows (30 s) is marked SHORT: wear it longer.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node tools/fps-report.mjs <server log>'); process.exit(2); }

const sessions = new Map();
for (const line of readFileSync(file, 'utf8').split('\n')) {
  const m = line.match(/\[([^\]]+)\] "HEAD \/index\.html\?(fpsreport=[^ "]+) HTTP/);
  if (!m) continue;
  const q = Object.fromEntries(new URLSearchParams(m[2]));
  if (!q.sid || !q.med) continue;
  const s = sessions.get(q.sid) ?? { first: m[1], meds: [], mins: [], prs: [] };
  s.last = m[1]; s.q = q;
  s.meds.push(Number(q.med)); s.mins.push(Number(q.min)); s.prs.push(q.pr);
  sessions.set(q.sid, s);
}

if (!sessions.size) { console.log('no fps reports yet (headset mode + hands on, 10 s at least)'); process.exit(0); }
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
for (const [sid, s] of sessions) {
  const q = s.q, med = median(s.meds), worst = Math.min(...s.meds), end = s.meds.at(-1);
  const verdict = med < 45 ? 'UNDER 45' : end < 45 ? `UNDER 45 (ended at ${end})` : 'OK >= 45';
  console.log(`${sid} ${q.dev} ${q.scr}  ${s.first} -> ${s.last}  ${s.meds.length} x 10 s`
    + `  median ${med} fps (worst 10 s ${worst}, worst 1 s ${Math.min(...s.mins)})`
    + `  last: ${q.pr}x ${q.px}, hands ${q.src} ${q.hz}/s ${q.hms} ms, ${q.draws} draws/eye ${q.ktris}k tris`
    + `  ${verdict}${s.meds.length < 3 ? ' SHORT' : ''}`
    + `\n    windows: ${s.meds.map((f, i) => `${f}@${s.prs[i]}`).join(' ')}`);
}
