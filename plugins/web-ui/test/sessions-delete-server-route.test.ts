import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

function isNoncedCoreCall(url: string, pathname: string): boolean {
  const u = new URL(url, "http://core");
  if (u.pathname !== pathname) return false;
  const keys = [...u.searchParams.keys()];
  return (
    keys.length === 1 && keys[0] === "_sourceAuthNonce" && (u.searchParams.get("_sourceAuthNonce") ?? "").length > 0
  );
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ method: req.method ?? "GET", url: req.url ?? "", body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "sessions-delete-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "sessions-delete-route-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

test("session delete binds the signed-in principal, ignoring any client-sent principalId", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/sessions/s1/delete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ principalId: "mallory" }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.slice(before).find((call) => isNoncedCoreCall(call.url, "/v1/sessions/s1/delete"))?.body, {
    principalId: "alice",
  });
});
