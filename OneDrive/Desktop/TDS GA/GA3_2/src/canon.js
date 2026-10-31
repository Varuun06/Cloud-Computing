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

export const proposalDigest = p => sha256(canon({
  dossierId: p.dossierId, callId: p.callId, action: p.action, target: p.target ?? null,
  payload: p.payload, evidence: [...p.evidence].sort(),
}));

// Receipt signature: Ed25519 over canonical {profile, evaluationId, inputDigest, receipt}.
export function verifyReceipt(jwk, receipt, profile, evaluationId, inputDigest) {
  const { receiptSignature, ...inner } = receipt;
  if (!jwk || typeof receiptSignature !== "string" || !receiptSignature) return false;
  try {
    const pub = createPublicKey({ key: jwk, format: "jwk" });
    const sig = Buffer.from(receiptSignature, "base64");
    const msg = Buffer.from(canon({ profile, evaluationId, inputDigest, receipt: inner }), "utf8");
    return sig.length === 64 && verify(null, msg, pub, sig);
  } catch { return false; }
}
