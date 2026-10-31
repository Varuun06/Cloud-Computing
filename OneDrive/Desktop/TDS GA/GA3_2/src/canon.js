import { createHash, createPublicKey, verify } from "node:crypto";

export function canon(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined)
    .map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
}
export const sha256 = s => createHash("sha256").update(s).digest("hex");
export const fingerprint = d => sha256(canon(d));
export const dossierId = d => d.dossierId;
export const callIdFor = (id, fp) => "call_" + sha256(id + ":" + fp).slice(0, 24);
export const proposalDigest = p => sha256(canon(p));

const NL = String.fromCharCode(10);
const fromB64u = x => Buffer.from(String(x), "base64url");

// Ed25519 receipt check against the evaluation's public JWK. The signed message
// layout is not documented, so several plausible layouts are tried. Fails closed.
export function verifyReceipt(jwk, r, evaluationId, proposal) {
  const sig = r.signature ?? r.sig ?? r.receiptSignature;
  if (!jwk || typeof sig !== "string" || !sig) return false;
  let pub;
  try { pub = createPublicKey({ key: jwk, format: "jwk" }); } catch { return false; }
  const token = r.receiptId ?? r.receipt ?? r.id ?? r.nonce;
  const base = { evaluationId, callId: proposal.callId, action: proposal.action,
    proposalDigest: proposal.proposalDigest, dossierId: proposal.dossierId };
  const { signature: _s, sig: _g, receiptSignature: _r, ...unsigned } = r;
  const parts = [evaluationId, proposal.callId, proposal.action, proposal.proposalDigest];
  const msgs = [
    canon(unsigned), JSON.stringify(unsigned),
    canon(r.payload ?? r.body ?? {}),
    canon({ ...base, ...(token !== undefined ? { receiptId: token } : {}) }), canon(base),
    parts.join("."), parts.join(":"), parts.join("|"), parts.join(NL),
    [...parts, token ?? ""].join("."), [...parts, token ?? ""].join(":"),
    [...parts, token ?? ""].join("|"), [...parts, token ?? ""].join(NL),
    proposal.proposalDigest, proposal.callId,
  ];
  const sigs = [fromB64u(sig), Buffer.from(sig, "hex")];
  for (const m of msgs) for (const sg of sigs) {
    try { if (sg.length === 64 && verify(null, Buffer.from(m), pub, sg)) return true; } catch {}
  }
  return false;
}
