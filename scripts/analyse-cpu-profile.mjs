/**
 * Summarise a CDP `Profiler.stop` payload: which functions actually burned the
 * time, both on their own (self) and including callees (total).
 *
 * Usage: node scripts/analyse-cpu-profile.mjs <profile.json> [topN]
 */
import { readFileSync } from "node:fs";

const [, , file, topRaw] = process.argv;
if (!file) {
  console.error("usage: node scripts/analyse-cpu-profile.mjs <profile.json> [topN]");
  process.exit(1);
}
const top = Number(topRaw ?? 30);

const raw = JSON.parse(readFileSync(file, "utf8"));
const profile = raw.profile ?? raw.result?.profile ?? raw;
const { nodes, samples, timeDeltas, startTime, endTime } = profile;

const byId = new Map(nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const label = (n) => {
  const f = n.callFrame;
  const name = f.functionName || "(anonymous)";
  const url = (f.url || "").split("/").slice(-1)[0] || f.url || "";
  return url ? `${name} @ ${url}:${f.lineNumber + 1}` : name;
};

// Self time: the sample's own node. Total time: that node and every ancestor.
const self = new Map();
const total = new Map();
for (let i = 0; i < samples.length; i++) {
  const dt = timeDeltas[i] ?? 0;
  if (dt <= 0) continue;
  const id = samples[i];
  self.set(id, (self.get(id) ?? 0) + dt);
  const seen = new Set();
  let cur = id;
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    total.set(cur, (total.get(cur) ?? 0) + dt);
    cur = parent.get(cur);
  }
}

const ms = (us) => +(us / 1000).toFixed(1);
const wall = ms(endTime - startTime);

// Fold by label so the same function split across call paths reads as one row.
const fold = (map) => {
  const out = new Map();
  for (const [id, us] of map) {
    const n = byId.get(id);
    if (!n) continue;
    const k = label(n);
    out.set(k, (out.get(k) ?? 0) + us);
  }
  return [...out].sort((a, b) => b[1] - a[1]);
};

const selfRows = fold(self);
const totalRows = fold(total);
const busy = selfRows.reduce((a, [, us]) => a + us, 0);
const idle = selfRows.find(([k]) => k.startsWith("(idle)"))?.[1] ?? 0;
const program = selfRows.find(([k]) => k.startsWith("(program)"))?.[1] ?? 0;

console.log(`wall ${wall}ms | sampled ${ms(busy)}ms | idle ${ms(idle)}ms | program ${ms(program)}ms`);
console.log(`\n=== SELF TIME (top ${top}) ===`);
for (const [k, us] of selfRows.slice(0, top)) {
  console.log(`${String(ms(us)).padStart(8)}ms  ${((us / busy) * 100).toFixed(1).padStart(5)}%  ${k}`);
}
console.log(`\n=== TOTAL TIME, app frames only (top ${top}) ===`);
for (const [k, us] of totalRows.filter(([k]) => !/^\(/.test(k)).slice(0, top)) {
  console.log(`${String(ms(us)).padStart(8)}ms  ${((us / busy) * 100).toFixed(1).padStart(5)}%  ${k}`);
}

// `--stacks <regex>` prints the ancestry above every node matching the pattern,
// which is the only way to tell *who* is calling a hot browser builtin.
const stackArg = process.argv.indexOf("--stacks");
if (stackArg !== -1) {
  const pattern = new RegExp(process.argv[stackArg + 1], "i");
  const paths = new Map();
  for (const [id, us] of self) {
    const n = byId.get(id);
    if (!n || !pattern.test(label(n))) continue;
    const chain = [];
    let cur = id;
    const seen = new Set();
    while (cur != null && !seen.has(cur) && chain.length < 12) {
      seen.add(cur);
      chain.push(label(byId.get(cur)));
      cur = parent.get(cur);
    }
    const k = chain.join("\n      ← ");
    paths.set(k, (paths.get(k) ?? 0) + us);
  }
  console.log(`\n=== CALL PATHS matching /${pattern.source}/ ===`);
  for (const [k, us] of [...paths].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`\n  ${ms(us)}ms\n      ${k}`);
  }
}
