import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { scopeId } from "../src/types.ts";

test("markSessionDeleted esconde a sessão de listByParticipant e listDeletedBefore respeita o corte", async () => {
  const store = createMemorySessionStore();
  const scope = scopeId("personal", "alice");
  const s = await store.getOrCreateByThread("web:alice:t1", "dm", scope);
  await store.addParticipant(s.id, "alice");

  assert.equal((await store.listByParticipant("alice")).length, 1);

  await store.markSessionDeleted(s.id, 1_000);
  assert.equal((await store.listByParticipant("alice")).length, 0, "deletada some da listagem");

  assert.deepEqual(await store.listDeletedBefore(500), [], "antes do corte: nada");
  assert.deepEqual(await store.listDeletedBefore(2_000), [s.id], "após o corte: aparece para purga");
});
