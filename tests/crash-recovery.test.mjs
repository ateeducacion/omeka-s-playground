import assert from "node:assert/strict";
import { test } from "node:test";

import { bootAfterUnreplayedCrash } from "../src/runtime/crash-recovery.js";

test("boots a replacement runtime after an unreplayed crash, never resending the request", async () => {
  const cases = [
    // [didReset, isRetry, canReplay, shouldBoot]
    [true, false, false, true], // POST crashed: 503 + boot so the shell unlocks
    [true, false, true, false], // GET is replayed by the normal retry path
    [true, true, false, false], // already a retry: manual reload required
    [false, false, false, false], // restart limit reached: do not boot
  ];
  for (const [didReset, isRetry, canReplay, shouldBoot] of cases) {
    let boots = 0;
    const attempted = await bootAfterUnreplayedCrash({
      didReset,
      isRetry,
      canReplay,
      boot: async () => {
        boots += 1;
      },
      onError: assert.fail,
    });
    assert.equal(attempted, shouldBoot);
    assert.equal(boots, shouldBoot ? 1 : 0);
  }

  // A failed boot is reported, not thrown back into the bridge listener.
  const errors = [];
  await bootAfterUnreplayedCrash({
    didReset: true,
    isRetry: false,
    canReplay: false,
    boot: async () => {
      throw new Error("bootstrap failed");
    },
    onError: (error) => errors.push(error.message),
  });
  assert.deepEqual(errors, ["bootstrap failed"]);
});
