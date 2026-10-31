import fs from "node:fs";
import path from "node:path";

// Durable state. If UPSTASH_REDIS_REST_URL/TOKEN are set (free tier works on Render free,
// where the local disk is wiped on restart) state is written through to Redis; the local
// JSON file is always written too and used when Redis is not configured.
const DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DIR, "state.json");
const URL_ = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const REDIS = !!(URL_ && TOKEN);

export const decisions = {};     // "id|fingerprint" -> proposal
export const evaluations = {};   // evaluationId -> record

async function redis(cmds) {
  const res = await fetch(URL_ + "/pipeline", {
    method: "POST",
    headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    body: JSON.stringify(cmds),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("redis http " + res.status);
  return (await res.json()).map(x => x.result);
}

export async function init() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    Object.assign(decisions, s.decisions); Object.assign(evaluations, s.evaluations);
  } catch {}
  if (!REDIS) return;
  try {
    const [d, idx] = await redis([["GET", "mr:decisions"], ["GET", "mr:evidx"]]);
    if (d) Object.assign(decisions, JSON.parse(d));
    const ids = idx ? JSON.parse(idx) : [];
    if (ids.length) {
      const recs = await redis(ids.map(id => ["GET", "mr:ev:" + id]));
      ids.forEach((id, i) => { if (recs[i]) evaluations[id] = JSON.parse(recs[i]); });
    }
    console.log(`loaded ${Object.keys(decisions).length} decisions, ${ids.length} evaluations from redis`);
  } catch (e) { console.error("redis load failed:", String(e)); }
}

// Persist before replying. evalId limits the write to the changed evaluation.
export async function persist(evalId) {
  try {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ decisions, evaluations }));
    fs.renameSync(tmp, FILE);
  } catch {}
  if (!REDIS) return;
  const cmds = [["SET", "mr:decisions", JSON.stringify(decisions)],
    ["SET", "mr:evidx", JSON.stringify(Object.keys(evaluations))]];
  if (evalId && evaluations[evalId]) cmds.push(["SET", "mr:ev:" + evalId, JSON.stringify(evaluations[evalId])]);
  try { await redis(cmds); } catch (e) { console.error("redis write failed:", String(e)); }
}
