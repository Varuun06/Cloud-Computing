import http from "node:http";
import { canon, fingerprint, dossierId, callIdFor, proposalDigest, verifyReceipt } from "./canon.js";
import { decisions, evaluations, persist } from "./store.js";
import { decide } from "./llm.js";

const PORT = +(process.env.PORT || 3000);
const MAX_BODY = 4 * 1024 * 1024;
const MAX_RESP = 512 * 1024 - 1024;
const MAX_DOSSIERS = 300;
const ACTIONS = new Set(["create_draft", "update_internal_record", "send_approved_notice",
  "request_confirmation", "quarantine_item", "no_action"]);
const SECRET_RE = /canary|vault|api[_-]?key|password|secret|sk-[a-z0-9]{8,}/i;

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const isObj = v => v && typeof v === "object" && !Array.isArray(v);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => {
      n += c.length;
      if (n > MAX_BODY) { reject(new HttpError(413, "body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  let body = JSON.stringify(obj);
  if (status < 300 && Buffer.byteLength(body) > MAX_RESP) {
    status = 500; body = JSON.stringify({ error: "response too large" });
  }
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body),
    "cache-control": "no-store" });
  res.end(body);
}

// Strip long / secret-looking strings so raw mail or canaries never reach tool arguments.
function clean(v, depth = 0) {
  if (typeof v === "string") return SECRET_RE.test(v) || v.length > 160 ? undefined : v;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (depth > 3) return undefined;
  if (Array.isArray(v)) return v.slice(0, 8).map(x => clean(x, depth + 1)).filter(x => x !== undefined);
  if (isObj(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 12)) {
      const c = clean(x, depth + 1);
      if (c !== undefined && /^[\w.\-]{1,40}$/.test(k)) o[k] = c;
    }
    return o;
  }
  return undefined;
}

function buildProposal(id, fp, raw) {
  let action = raw && ACTIONS.has(raw.action) ? raw.action : null;
  let evidence = Array.isArray(raw?.evidence) ? clean(raw.evidence).slice(0, 4) : [];
  let target = isObj(raw?.target) ? clean(raw.target) : {};
  let payload = isObj(raw?.payload) ? clean(raw.payload) : {};
  let ok = !!action;
  // Fail safe: outbound send requires cited evidence; otherwise route to a human.
  if (!action || (action === "send_approved_notice" && !evidence.length)) {
    action = "request_confirmation";
    if (!ok) { target = {}; payload = {}; evidence = []; }
  }
  const p = { dossierId: id, callId: callIdFor(id, fp), action, target, payload, evidence };
  p.proposalDigest = proposalDigest(p);
  return { p, ok };
}

function findKey(body) {
  for (const [k, v] of Object.entries(body)) if (/key|secret/i.test(k) && typeof v === "string") return v;
  for (const [k, v] of Object.entries(body)) {
    if (isObj(v)) for (const [k2, v2] of Object.entries(v)) if (/key/i.test(k2) && typeof v2 === "string") return v2;
  }
  return null;
}

async function propose(body, t0) {
  const evalId = body.evaluationId;
  if (typeof evalId !== "string" || !evalId || evalId.length > 200) throw new HttpError(400, "evaluationId required");
  if (!Array.isArray(body.dossiers) || !body.dossiers.length || body.dossiers.length > MAX_DOSSIERS)
    throw new HttpError(422, "dossiers must be a non-empty array");
  const seen = new Set();
  for (const d of body.dossiers) {
    const id = isObj(d) ? dossierId(d) : undefined;
    if (typeof id !== "string" || !id) throw new HttpError(422, "dossier id required");
    if (seen.has(id)) throw new HttpError(400, "duplicate dossier id");
    seen.add(id);
  }
  const reqFp = fingerprint(body);
  const prior = evaluations[evalId];
  if (prior) {
    if (prior.requestFp !== reqFp) throw new HttpError(409, "evaluationId reused with changed content");
    return prior.response;
  }

  const items = body.dossiers.map(d => ({ d, id: dossierId(d), fp: fingerprint(d) }));
  const todo = items.filter(i => !decisions[i.id + "|" + i.fp]);
  let fresh = new Map();
  if (todo.length) fresh = await decide(todo.map(i => ({ ...i.d, id: i.id })), t0 + 50000);

  const proposals = [];
  for (const i of items) {
    const key = i.id + "|" + i.fp;
    let p = decisions[key];
    if (!p) {
      const { p: built, ok } = buildProposal(i.id, i.fp, fresh.get(i.id));
      p = built;
      if (ok) decisions[key] = p; // only cache real model decisions
    }
    proposals.push(p);
  }
  const response = { status: "awaiting_receipts", evaluationId: evalId, proposals };
  evaluations[evalId] = { requestFp: reqFp, key: findKey(body), proposals, response, commitFp: null, commitResponse: null };
  persist();
  return response;
}

function commit(body) {
  if (!Array.isArray(body.receipts) || !body.receipts.length || body.receipts.length > MAX_DOSSIERS)
    throw new HttpError(422, "receipts must be a non-empty array");
  for (const r of body.receipts) if (!isObj(r)) throw new HttpError(422, "malformed receipt");
  const evalId = body.evaluationId ?? body.receipts[0].evaluationId;
  if (typeof evalId !== "string") throw new HttpError(422, "evaluationId required");
  const ev = evaluations[evalId];
  if (!ev) throw new HttpError(404, "unknown evaluation");
  const cfp = fingerprint(body);
  if (ev.commitFp) {
    if (ev.commitFp === cfp) return ev.commitResponse;
    throw new HttpError(409, "commit already recorded with different content");
  }
  const byCall = new Map(ev.proposals.map(p => [p.callId, p]));
  const done = new Set();
  const outcomes = [];
  for (const r of body.receipts) {
    if ((r.evaluationId ?? evalId) !== evalId) throw new HttpError(422, "receipt evaluation mismatch");
    const p = byCall.get(r.callId);
    if (!p) throw new HttpError(422, "unknown callId");
    if (done.has(p.callId)) throw new HttpError(422, "duplicate receipt");
    if (r.action !== undefined && r.action !== p.action) throw new HttpError(422, "action mismatch");
    const dg = r.proposalDigest ?? r.digest;
    if (dg !== undefined && dg !== p.proposalDigest) throw new HttpError(422, "digest mismatch");
    if (!verifyReceipt(ev.key, r, evalId, p)) throw new HttpError(422, "invalid receipt signature");
    done.add(p.callId);
    outcomes.push({ dossierId: p.dossierId, callId: p.callId, action: p.action, status: "completed",
      receiptId: r.receiptId ?? r.receipt ?? r.id ?? null });
  }
  const response = { status: done.size === ev.proposals.length ? "completed" : "partial",
    evaluationId: evalId, outcomes };
  ev.commitFp = cfp; ev.commitResponse = response;
  persist();
  return response;
}

// Serialize work per evaluationId so concurrent identical requests do not repeat model calls.
const locks = new Map();
async function locked(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(key, run);
  try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
}

let inflight = 0;
const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) return send(res, 200, { ok: true });
    if (req.method !== "POST") throw new HttpError(405, "POST only");
    if (inflight >= 8) throw new HttpError(429, "busy");
    inflight++;
    try {
      const ct = req.headers["content-type"] || "";
      if (!/json/i.test(ct)) throw new HttpError(415, "application/json required");
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, "invalid JSON");
      }
      if (!isObj(body)) throw new HttpError(400, "body must be an object");
      if (body.operation === "propose") {
        const out = await locked(String(body.evaluationId), () => propose(body, t0));
        return send(res, 200, out);
      }
      if (body.operation === "commit") {
        const evalId = body.evaluationId ?? (Array.isArray(body.receipts) && isObj(body.receipts[0]) ? body.receipts[0].evaluationId : "");
        return send(res, 200, await locked(String(evalId), async () => commit(body)));
      }
      throw new HttpError(400, "invalid operation");
    } finally { inflight--; }
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: "internal error" });
  }
});
server.requestTimeout = 60000;
server.listen(PORT, () => console.log("mailroom agent listening on " + PORT));
