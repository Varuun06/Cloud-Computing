import fs from "node:fs";
import path from "node:path";

const DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, "state.json");

let state = { decisions: {}, evaluations: {} };
try { state = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}

// Atomic durable write: temp file then rename.
export function persist() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, FILE);
}
export const decisions = state.decisions;     // "id|fingerprint" -> proposal
export const evaluations = state.evaluations;  // evaluationId -> record
