import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { scopeId } from "../src/types.ts";
import { sweepDeletedSessions, PURGE_AFTER_MS } from "../src/sessions/deleted-session-sweeper.ts";

test("purga só o que passou dos 30 dias e não toca o resto", async () => {
  const store = createMemorySessionStore();
  const scope = scopeId("personal", "a");
  const now = 100 * 24 * 3600 * 1000;

  const old = await store.getOrCreateByThread("web:a:t-old", "dm", scope);
  const fresh = await store.getOrCreateByThread("web:a:t-fresh", "dm", scope);
  const alive = await store.getOrCreateByThread("web:a:t-alive", "dm", scope);
  await store.markSessionDeleted(old.id, now - PURGE_AFTER_MS - 1);
  await store.markSessionDeleted(fresh.id, now - 1000);

  assert.equal(await sweepDeletedSessions(store, now), 1);
  assert.equal(await store.get(old.id), null, "antiga purgada de verdade");
  assert.ok(await store.get(fresh.id), "recém-deletada preservada (janela)");
  assert.ok(await store.get(alive.id), "viva intacta");
});
