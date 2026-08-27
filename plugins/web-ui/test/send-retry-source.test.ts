import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("retryable send errors render an inline retry action", () => {
  assert.match(source, /\(message as AssistantWork\)\.retryableSend/);
  assert.match(source, /retryFailedSend\(message, index\)/);
  assert.match(source, /Retry\s*<\/button>/);
});

test("retry removes only the failed assistant row and continues the original user turn", () => {
  const retry = source.slice(
    source.indexOf("async function retryFailedSend"),
    source.indexOf("function visibleMessages"),
  );
  assert.match(retry, /agent\.state\.messages\.filter/);
  assert.match(retry, /await agent\.continue\(\)/);
  assert.doesNotMatch(retry, /agent\.prompt/);
});
