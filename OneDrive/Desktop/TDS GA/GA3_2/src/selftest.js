// Offline smoke test: starts the server without an LLM key and checks validation/conflict paths.
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { canon } from "./canon.js";

const port = 3911;
const srv = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(port), DATA_DIR: "data-test", LLM_API_KEY: "", LLM_BASE_URL: "http://127.0.0.1:1" },
  stdio: "inherit",
});
await new Promise(r => setTimeout(r, 800));
const post = async b => {
  const r = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { s: r.status, j: await r.json() };
};
let fail = 0;
const ok = (n, c) => { console.log(c ? "PASS" : "FAIL", n); if (!c) fail++; };

const ev = "e-" + Date.now();
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const mk = id => ({ dossierId: id, partition: "stable_core", sources: [{ sourceId: "s", lines: [{ lineId: id + "-l1", text: "hi" }] }] });
const body = { operation: "propose", evaluationId: ev, profile: "ga5-mailroom-action-gate/v2", receiptVerifier: { algorithm: "Ed25519", publicKeyJwk: publicKey.export({ format: "jwk" }) }, dossiers: [mk("a"), mk("b")] };
ok("dup ids 400", (await post({ ...body, evaluationId: "z", dossiers: [mk("a"), mk("a")] })).s === 400);
ok("bad op 400", (await post({ operation: "nope" })).s === 400);
const p1 = await post(body);
ok("propose 200", p1.s === 200 && p1.j.status === "awaiting_receipts");
const p2 = await post(body);
ok("replay identical", canon(p1.j) === canon(p2.j));
ok("conflict 409", (await post({ ...body, dossiers: [{ ...mk("a"), objective: "changed" }, mk("b")] })).s === 409);
const unsigned = p => ({ evaluationId: ev, callId: p.callId, action: p.action, receiptId: "r-" + p.dossierId });
const sign = p => edSign(null, Buffer.from(canon(unsigned(p))), privateKey).toString("base64url");
const bad = await post({ operation: "commit", evaluationId: ev, receipts: p1.j.proposals.map(p => ({ callId: p.callId, action: p.action, receiptId: "r", signature: "00" })) });
ok("bad signature rejected", bad.s === 422);
const good = { operation: "commit", evaluationId: ev, receipts: p1.j.proposals.map(p => ({ ...unsigned(p), signature: sign(p) })) };
const c1 = await post(good);
ok("commit completed", c1.s === 200 && c1.j.status === "completed");
ok("commit replay", canon((await post(good)).j) === canon(c1.j));
ok("unknown eval rejected", (await post({ ...good, evaluationId: "nope" })).s >= 400);
srv.kill();
process.exit(fail ? 1 : 0);
