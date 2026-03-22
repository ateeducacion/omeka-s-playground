import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGitHubArchiveUrl } from "../src/runtime/addons.js";

describe("parseGitHubArchiveUrl", () => {
  it("parses GitHub archive branch URLs with nested branch names", () => {
    assert.deepEqual(
      parseGitHubArchiveUrl(
        "https://github.com/exelearning/omeka-s-exelearning/archive/refs/heads/feature/remote-embeded-editor.zip",
      ),
      {
        owner: "exelearning",
        repo: "omeka-s-exelearning",
        refType: "heads",
        ref: "feature/remote-embeded-editor",
        sourceUrl:
          "https://github.com/exelearning/omeka-s-exelearning/archive/refs/heads/feature/remote-embeded-editor.zip",
      },
    );
  });

  it("parses codeload archive tag URLs", () => {
    assert.deepEqual(
      parseGitHubArchiveUrl(
        "https://codeload.github.com/exelearning/omeka-s-exelearning/zip/refs/tags/v1.2.3",
      ),
      {
        owner: "exelearning",
        repo: "omeka-s-exelearning",
        refType: "tags",
        ref: "v1.2.3",
        sourceUrl:
          "https://codeload.github.com/exelearning/omeka-s-exelearning/zip/refs/tags/v1.2.3",
      },
    );
  });

  it("returns null for non-GitHub archive URLs", () => {
    assert.equal(
      parseGitHubArchiveUrl("https://example.com/downloads/addon.zip"),
      null,
    );
  });
});
