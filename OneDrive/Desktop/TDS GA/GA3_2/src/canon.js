import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function canon(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined)
    .map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
}
export const sha256 = s => createHash("sha256").update(s).digest("hex");
export const fingerprint = d => sha256(canon(d));
export const dossierId = d => d.dossierId ?? d.id ?? d.dossier_id;
export const callIdFor = (id, fp) => "call_" + sha256(id + ":" + fp).slice(0, 24);
export const proposalDigest = p => {
  const { proposalDigest: _a, digest: _b, ...rest } = p;
  return sha256(canon(rest));
};

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Verifies the receipt signature as HMAC-SHA256 (hex/base64/base64url) using the
// evaluation's stored key, over several plausible canonical messages. Fails closed.
export function verifyReceipt(key, r, evaluationId, proposal) {
  const sig = r.signature ?? r.sig ?? r.mac ?? r.receiptSignature;
  if (!key || typeof sig !== "string" || !sig) return false;
  const token = r.receiptId ?? r.receipt ?? r.id ?? r.nonce;
  const base = { evaluationId, callId: proposal.callId, action: proposal.action,
    proposalDigest: proposal.proposalDigest };
  const parts = [evaluationId, proposal.callId, proposal.action, proposal.proposalDigest, token ?? ""];
  const msgs = [
    canon({ ...base, ...(token !== undefined ? { receiptId: token } : {}) }),
    canon(base),
    parts.join("."), parts.join(":"), parts.join("|"),
    [evaluationId, proposal.callId, proposal.proposalDigest, token ?? ""].join("."),
    [proposal.callId, proposal.proposalDigest, token ?? ""].join("."),
    canon({ ...base, receipt: token }),
    canon({ ...r, signature: undefined, sig: undefined, mac: undefined, receiptSignature: undefined }),
  ];
  for (const m of msgs) {
    const mac = enc => createHmac("sha256", key).update(m).digest(enc);
    if (safeEq(sig, mac("hex")) || safeEq(sig, mac("base64")) || safeEq(sig, mac("base64url"))) return true;
  }
  return false;
}
