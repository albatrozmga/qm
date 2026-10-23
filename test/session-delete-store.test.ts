import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
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

const databaseUrl = process.env.DATABASE_URL;
const backends = [
  { name: "memory", skip: false, make: () => createMemorySessionStore() },
  {
    name: "postgres",
    skip: databaseUrl ? false : "set DATABASE_URL to run the Postgres variant",
    make: () => createPostgresSessionStore(databaseUrl!),
  },
] as const;

for (const backend of backends) {
  test(`${backend.name}: apagar um chat apaga junto os subagentes que ele criou`, { skip: backend.skip }, async () => {
    const store = backend.make();
    const owner = `alice-${randomUUID()}`;
    const scope = scopeId("personal", owner);
    const root = await store.getOrCreateByThread(`web:${owner}:root`, "dm", scope);
    const child = await store.getOrCreateByThread(`sub:${owner}:child`, "dm", scope);
    const grandchild = await store.getOrCreateByThread(`sub:${owner}:grandchild`, "dm", scope);
    await store.setParentSession(child.id, root.id);
    await store.setParentSession(grandchild.id, child.id);
    for (const s of [root, child, grandchild]) await store.addParticipant(s.id, owner);

    await store.markSessionDeleted(root.id, 1_000);

    assert.deepEqual(await store.listByParticipant(owner), [], "nenhum da árvore aparece na listagem");
    assert.equal(await store.getForParticipant(child.id, owner), null, "o subagente não abre direto");
    assert.equal(await store.getForParticipant(grandchild.id, owner), null, "nem o neto");
    const purge = new Set(await store.listDeletedBefore(2_000));
    for (const s of [root, child, grandchild]) assert.ok(purge.has(s.id), "a árvore inteira vai para a purga");
  });

  test(
    `${backend.name}: o endereço de um chat apagado volta a abrir uma conversa nova`,
    { skip: backend.skip },
    async () => {
      const store = backend.make();
      const owner = `alice-${randomUUID()}`;
      const scope = scopeId("personal", owner);
      const threadRef = `web:${owner}:inbox`;
      const deleted = await store.getOrCreateByThread(threadRef, "dm", scope);
      await store.addParticipant(deleted.id, owner);

      await store.markSessionDeleted(deleted.id, 1_000);
      const fresh = await store.getOrCreateByThread(threadRef, "dm", scope);
      await store.addParticipant(fresh.id, owner);

      assert.notEqual(fresh.id, deleted.id);
      assert.equal((await store.getByThread(threadRef))?.id, fresh.id);
      assert.deepEqual(
        (await store.listByParticipant(owner)).map((s) => s.id),
        [fresh.id],
      );
      assert.ok(await store.get(deleted.id), "o apagado segue guardado até a purga");
      assert.ok((await store.listDeletedBefore(2_000)).includes(deleted.id));
    },
  );
}

test(
  "postgres: a migração estende a exclusão já feita aos subagentes e libera o endereço",
  { skip: databaseUrl ? false : "set DATABASE_URL to run the Postgres variant" },
  async () => {
    const store = createPostgresSessionStore(databaseUrl!);
    const owner = `alice-${randomUUID()}`;
    const scope = scopeId("personal", owner);
    const threadRef = `web:${owner}:inbox`;
    const root = await store.getOrCreateByThread(threadRef, "dm", scope);
    const child = await store.getOrCreateByThread(`sub:${owner}:child`, "dm", scope);
    await store.setParentSession(child.id, root.id);
    await store.addParticipant(child.id, owner);
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: databaseUrl! });
    try {
      await pool.query("UPDATE sessions SET deleted_at = 1000 WHERE id = $1", [root.id]);
      const backfill = registeredPgMigrations(databaseUrl!).filter((m) =>
        m.id.startsWith("sessions/store/albatroz-0002"),
      );
      assert.equal(backfill.length, 1);
      await pool.query("DELETE FROM qm_schema_migrations WHERE id = $1", [backfill[0]!.id]);
      await applyPgMigrations(pool, backfill);
    } finally {
      await pool.end();
    }

    assert.equal(await store.getForParticipant(child.id, owner), null);
    assert.ok((await store.listDeletedBefore(2_000)).includes(child.id));
    const fresh = await store.getOrCreateByThread(threadRef, "dm", scope);
    assert.notEqual(fresh.id, root.id);
  },
);
