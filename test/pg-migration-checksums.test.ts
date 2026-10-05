import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";

test("as migrações declaradas do session store têm checksums válidos", () => {
  assert.doesNotThrow(() => createPostgresSessionStore("postgresql://unused:unused@127.0.0.1:9/void"));
});
