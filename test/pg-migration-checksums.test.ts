import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";

// Tripwire do patch Albatroz: definePgMigration valida o checksum pinado de cada
// migração na DECLARAÇÃO (sem conectar no banco). Um patch que edite uma migração
// upstream em vez de declarar a própria (albatroz/...) explode aqui, não no boot
// de produção — foi exatamente o modo de falha do deploy de 2026-09-09.
test("as migrações declaradas do session store têm checksums válidos", () => {
  assert.doesNotThrow(() => createPostgresSessionStore("postgresql://unused:unused@127.0.0.1:9/void"));
});
