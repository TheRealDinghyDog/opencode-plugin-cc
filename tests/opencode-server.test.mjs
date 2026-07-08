import test from "node:test";
import assert from "node:assert/strict";

import { OpencodeServerClient } from "../plugins/opencode/scripts/lib/opencode-server.mjs";

test("subscribeEvents cancels the response body if onOpen throws", async () => {
  let cancelled = false;
  const expectedError = new Error("open failed");
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    }
  });
  const client = new OpencodeServerClient("http://opencode.test", {
    fetch: async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
  });

  await assert.rejects(
    client.subscribeEvents(() => {}, {
      onOpen() {
        throw expectedError;
      }
    }),
    (error) => error === expectedError
  );
  assert.equal(cancelled, true);
});
