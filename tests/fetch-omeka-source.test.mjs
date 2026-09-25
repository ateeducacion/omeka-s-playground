import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/fetch-omeka-source.sh", import.meta.url),
);
const root = mkdtempSync(join(tmpdir(), "fetch-omeka-source-"));
const source = join(root, "source");
const env = { ...process.env, CACHE_DIR: join(root, "cache") };

function git(...args) {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args],
    { encoding: "utf8" },
  ).trim();
}

function fetchBranch(branch) {
  const dir = execFileSync(script, [`file://${source}`, branch, "v"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return git("-C", dir, "log", "-1", "--format=%s");
}

after(() => rmSync(root, { recursive: true, force: true }));

describe("fetch-omeka-source.sh", () => {
  git("init", "-q", "-b", "a", source);
  git("-C", source, "commit", "-q", "--allow-empty", "-m", "a1");
  git("-C", source, "switch", "-q", "-c", "b");
  git("-C", source, "commit", "-q", "--allow-empty", "-m", "b1");

  it("switches a cached shallow clone to another branch", () => {
    assert.equal(fetchBranch("a"), "a1");
    assert.equal(fetchBranch("b"), "b1");
  });

  it("updates a cached clone to the latest commit of its branch", () => {
    git("-C", source, "switch", "-q", "a");
    git("-C", source, "commit", "-q", "--allow-empty", "-m", "a2");
    assert.equal(fetchBranch("a"), "a2");
  });
});
