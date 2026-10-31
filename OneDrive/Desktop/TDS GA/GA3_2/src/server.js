import http from "node:http";
import { canon, sha256, fingerprint, callIdFor, proposalDigest, verifyReceipt } from "./canon.js";
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

const PROFILE = "ga5-mailroom-action-gate/v2";
const ID_RE = /^[A-Za-z0-9._:-]{12,128}$/;

function lineIdsOf(d) {
  const ids = new Set();
  for (const s of d.sources) for (const l of s.lines) ids.add(l.lineId);
  return ids;
}

function validateDossiers(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_DOSSIERS) throw new HttpError(422, "dossiers must be a non-empty array");
  const seen = new Set();
  for (const d of list) {
    if (!isObj(d) || typeof d.dossierId !== "string" || !d.dossierId) throw new HttpError(422, "dossierId required");
    if (seen.has(d.dossierId)) throw new HttpError(400, "duplicate dossier id");
    seen.add(d.dossierId);
    if (!Array.isArray(d.sources)) throw new HttpError(422, "sources required");
    const lines = new Set();
    for (const s of d.sources) {
      if (!isObj(s) || typeof s.sourceId !== "string" || !Array.isArray(s.lines)) throw new HttpError(422, "malformed source");
      for (const l of s.lines) {
        if (!isObj(l) || typeof l.lineId !== "string" || typeof l.text !== "string") throw new HttpError(422, "malformed line");
        if (lines.has(l.lineId)) throw new HttpError(422, "duplicate lineId");
        lines.add(l.lineId);
      }
    }
  }
}

const K = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
// Frozen target/payload shapes per action; constants are forced by code, not the model.
function shape(action, target, payload) {
  const t = (kind, id) => ({ kind, id });
  switch (action) {
    case "create_draft": return [t("draft_queue", target?.id), { ...K(payload, ["recipient", "referenceId", "status"]), template: "order_status" }];
    case "update_internal_record": return [t("case_record", target?.id), K(payload, ["field", "sourceEventId", "value"])];
    case "send_approved_notice": return [t("email", target?.id), { ...K(payload, ["referenceId", "status"]), template: "approved_delivery_notice" }];
    case "request_confirmation": return [t("approval_queue", target?.id), { ...K(payload, ["claimedSender", "referenceId"]), questionCode: "VERIFY_REQUEST" }];
    case "quarantine_item": return [t("security_queue", "mailroom"), { ...K(payload, ["artifactId"]), reasonCode: "INDIRECT_PROMPT_INJECTION" }];
    default: {
      const rc = ["ALREADY_COMPLETED", "DUPLICATE", "INFORMATIONAL"].includes(payload.reasonCode) ? payload.reasonCode : "INFORMATIONAL";
      return [null, { reasonCode: rc, ...K(payload, ["referenceId"]) }];
    }
  }
}

function buildProposal(d, fp, raw) {
  const id = d.dossierId;
  const valid = lineIdsOf(d);
  let action = raw && ACTIONS.has(raw.action) ? raw.action : null;
  const ok = !!action;
  let ok2 = true;
  let evidence = [...new Set((Array.isArray(raw?.evidence) ? raw.evidence : []).map(String))].filter(x => valid.has(x));
  let target = null;
  if (isObj(raw?.target) && typeof raw.target.id === "string") {
    target = { kind: String(raw.target.kind ?? "").slice(0, 60), id: raw.target.id.slice(0, 160) };
  }
  let payload = isObj(raw?.payload) ? clean(raw.payload) : {};
  // Fail safe: outbound send needs cited evidence and a target; otherwise route to a human.
  if (!action || (action === "send_approved_notice" && (!evidence.length || !target))) {
    action = "request_confirmation";
    if (!ok) { target = null; payload = {}; evidence = []; }
  }
  [target, payload] = shape(action, target, payload);
  if (target && typeof target.id !== "string") { action = "request_confirmation"; ok2 = false; [target, payload] = shape(action, null, {}); }
  const p = { dossierId: id, callId: callIdFor(id, fp), action, target, payload, evidence: evidence.sort() };
  return { p, ok: ok && ok2 };
}

async function propose(body, t0) {
  const evalId = body.evaluationId;
  if (typeof evalId !== "string" || !evalId || evalId.length > 200) throw new HttpError(400, "evaluationId required");
  if (body.profile !== undefined && body.profile !== PROFILE) throw new HttpError(422, "unsupported profile");
  const jwk = body.receiptVerifier?.publicKeyJwk;
  if (!isObj(jwk) || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string")
    throw new HttpError(422, "receiptVerifier.publicKeyJwk required");
  if (body.allowedActions !== undefined && !(Array.isArray(body.allowedActions) && body.allowedActions.every(a => ACTIONS.has(a))))
    throw new HttpError(422, "bad allowedActions");
  validateDossiers(body.dossiers);

  const reqFp = fingerprint(body);
  const prior = evaluations[evalId];
  if (prior) {
    if (prior.requestFp !== reqFp) throw new HttpError(409, "evaluationId reused with changed content");
    return prior.response;
  }

  const items = body.dossiers.map(d => ({ d, id: d.dossierId, fp: fingerprint(d) }));
  const todo = items.filter(i => !decisions[i.id + "|" + i.fp]);
  let fresh = new Map();
  if (todo.length) fresh = await decide(todo.map(i => i.d), t0 + 50000);

  const proposals = [];
  for (const i of items) {
    const key = i.id + "|" + i.fp;
    let p = decisions[key];
    if (!p) {
      const { p: built, ok } = buildProposal(i.d, i.fp, fresh.get(i.id));
      p = built;
      if (ok) decisions[key] = p; // only cache real model decisions
    }
    proposals.push(p);
  }
  const digests = Object.fromEntries(proposals.map(p => [p.callId, proposalDigest(p)]));
  const response = { profile: PROFILE, evaluationId: evalId, status: "awaiting_receipts",
    inputDigest: sha256(canon(body.dossiers)), proposals };
  evaluations[evalId] = { requestFp: reqFp, key: jwk, proposals, digests, response, commitFp: null, commitResponse: null };
  persist();
  return response;
}

function commit(body) {
  if (body.profile !== PROFILE) throw new HttpError(422, "unsupported profile");
  const evalId = body.evaluationId;
  if (typeof evalId !== "string" || !evalId) throw new HttpError(422, "evaluationId required");
  if (!Array.isArray(body.receipts) || !body.receipts.length || body.receipts.length > MAX_DOSSIERS)
    throw new HttpError(422, "receipts must be a non-empty array");
  const ev = evaluations[evalId];
  if (!ev) throw new HttpError(404, "unknown evaluation");
  if (body.inputDigest !== ev.response.inputDigest) throw new HttpError(422, "inputDigest mismatch");
  const cfp = fingerprint(body);
  if (ev.commitFp) {
    if (ev.commitFp === cfp) return ev.commitResponse;
    throw new HttpError(409, "commit already recorded with different content");
  }
  const byCall = new Map(ev.proposals.map(p => [p.callId, p]));
  const done = new Set();
  const outcomes = [];
  for (const r of body.receipts) {
    if (!isObj(r) || typeof r.accepted !== "boolean" || typeof r.receiptId !== "string") throw new HttpError(422, "malformed receipt");
    const p = byCall.get(r.callId);
    if (!p) throw new HttpError(422, "unknown callId");
    if (done.has(p.callId)) throw new HttpError(422, "duplicate receipt");
    if (r.dossierId !== p.dossierId || r.action !== p.action) throw new HttpError(422, "receipt does not match proposal");
    if (r.proposalDigest !== ev.digests[p.callId]) throw new HttpError(422, "digest mismatch");
    if (!verifyReceipt(ev.key, r, PROFILE, evalId, ev.response.inputDigest)) throw new HttpError(422, "invalid receipt signature");
    done.add(p.callId);
    outcomes.push({ dossierId: p.dossierId, callId: p.callId, action: p.action,
      proposalDigest: r.proposalDigest, receiptId: r.receiptId, status: r.accepted === true ? "executed" : "rejected" });
  }
  if (done.size !== ev.proposals.length) throw new HttpError(422, "a receipt is required for every proposal");
  const response = { profile: PROFILE, evaluationId: evalId, status: "completed",
    inputDigest: ev.response.inputDigest, outcomes };
  ev.commitFp = cfp; ev.commitResponse = response; ev.receipts = body.receipts;
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
