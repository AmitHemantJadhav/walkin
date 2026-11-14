// A1: read back the frame rates the page reported from the headset (app.js reportFps, one line per 10 s).
//   node tools/fps-report.mjs <server access log>     e.g. the log scripts/live.sh writes serve.py's output to
// One row per page load (sid): device, screen, how many reports, the median and worst 10 s median, and the
// resolution / hand rate / draws it ended on. A1 is met when an ios row's median is >= 45.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node tools/fps-report.mjs <server log>'); process.exit(2); }

const sessions = new Map();
for (const line of readFileSync(file, 'utf8').split('\n')) {
  const m = line.match(/\[([^\]]+)\] "HEAD \/index\.html\?(fpsreport=[^ "]+) HTTP/);
  if (!m) continue;
  const q = Object.fromEntries(new URLSearchParams(m[2]));
  if (!q.sid || !q.med) continue;
  const s = sessions.get(q.sid) ?? { first: m[1], meds: [], mins: [] };
  s.last = m[1]; s.q = q;
  s.meds.push(Number(q.med)); s.mins.push(Number(q.min));
  sessions.set(q.sid, s);
}

if (!sessions.size) { console.log('no fps reports yet (headset mode + hands on, 10 s at least)'); process.exit(0); }
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
for (const [sid, s] of sessions) {
  const q = s.q, med = median(s.meds), worst = Math.min(...s.meds);
  console.log(`${sid} ${q.dev} ${q.scr}  ${s.first} -> ${s.last}  ${s.meds.length} x 10 s`
    + `  median ${med} fps (worst 10 s ${worst}, worst 1 s ${Math.min(...s.mins)})`
    + `  last: ${q.pr}x ${q.px}, hands ${q.src} ${q.hz}/s ${q.hms} ms, ${q.draws} draws/eye ${q.ktris}k tris`
    + `  ${med >= 45 ? 'OK >= 45' : 'UNDER 45'}`);
}
