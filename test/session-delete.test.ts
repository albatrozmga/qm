import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-session-delete-"));
  return buildApp(testConfig({ dataDir }));
}
function dm(text: string, thread: string, externalId: string): TurnRequest {
  return { surface: "test", actor: { externalId }, conversation: { kind: "dm", threadRef: thread }, text };
}

test("o dono soft-deleta o próprio chat pessoal e ele some de toda visão", async () => {
  const { app } = freshApp();
  const outcome = await app.turn(dm("apaga depois", "web:alice:del1", "alice"));
  const sessionId = outcome.sessionId!;

  assert.equal(await app.deleteSessionForViewer(sessionId, "alice"), "ok");
  assert.equal(await app.getSessionForViewer(sessionId, "alice"), null, "some até para o dono");
  assert.ok(!(await app.listSessions("alice")).some((s) => s.id === sessionId), "fora da lista");
  assert.equal(await app.deleteSessionForViewer(sessionId, "alice"), "not_found", "repetido: já invisível");
});

test("não-participante não deleta (e não descobre que existe)", async () => {
  const { app } = freshApp();
  const outcome = await app.turn(dm("privado", "web:alice:del2", "alice"));
  assert.equal(await app.deleteSessionForViewer(outcome.sessionId!, "carol"), "not_found");
  assert.ok((await app.listSessions("alice")).some((s) => s.id === outcome.sessionId), "segue viva para o dono");
});

test("sessão de canal/grupo é recusada", async () => {
  const { app } = freshApp();
  const outcome = await app.turn({
    surface: "test",
    actor: { externalId: "alice" },
    conversation: { kind: "channel", threadRef: "ch:C1:t1", channelRef: "C1", audience: [{ externalId: "alice" }] },
    text: "num canal",
  });
  assert.equal(await app.deleteSessionForViewer(outcome.sessionId!, "alice"), "forbidden");
});
