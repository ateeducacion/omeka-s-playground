import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  createUstarTar,
  normalizeEntries,
  readUstarTar,
} from "../scripts/lib/tar-ustar.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const bytes = (s) => new Uint8Array(Buffer.from(s));

describe("tar-ustar empty directory preservation", () => {
  // Regression: a source tree can carry a directory whose only files were removed
  // by the build trim. The source ZIP still ships it as an explicit empty
  // directory member; the files-only tar writer used to drop it, so the
  // semantically-meaningful empty directory never existed in the extracted tree.

  it("preserves an explicit empty directory (no file descendant)", () => {
    const entries = normalizeEntries({
      "extras/": bytes(""),
      "modules/quiz/version.php": bytes("<?php"),
    });
    const dir = entries.find((e) => e.name === "extras");
    assert.ok(dir, "empty extras/ directory must be preserved");
    assert.equal(dir.type, "dir");
    // Directories implied by a file are NOT emitted as redundant members —
    // the streaming extractor reconstructs them from each file's parent path.
    assert.ok(!entries.some((e) => e.type === "dir" && e.name === "modules"));
    assert.ok(
      !entries.some((e) => e.type === "dir" && e.name === "modules/quiz"),
    );
  });

  it("drops populated directory members that a file recreates (real fflate shape)", () => {
    // fflate's unzipSync() yields an EXPLICIT trailing-slash member for EVERY
    // directory in the ZIP, including populated ones. Only the truly empty
    // `keepme/` must survive; `a/` and `a/b/` are recreated by their file and
    // MUST be dropped (invariant: no redundant directory members, else the tar
    // gains spurious typeflag-5 entries and dirCount / sha256 drift). Guards the
    // impliedDirs dedup, which the empty-only maps above never exercise.
    const entries = normalizeEntries({
      "a/": bytes(""),
      "a/b/": bytes(""),
      "a/b/f.txt": bytes("data"),
      "keepme/": bytes(""),
    });
    const dirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
    assert.deepEqual(dirs, ["keepme"]);
  });

  it("preserves a nested empty directory but not those implied by files", () => {
    const entries = normalizeEntries({
      "plugin/tool/version.php": bytes("<?php"),
      "plugin/tool/lang/en/tool.php": bytes("<?php"),
      "plugin/tool/widgets/": bytes(""),
    });
    const dirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
    assert.deepEqual(dirs, ["plugin/tool/widgets"]);
  });

  it("emits a USTAR directory header (typeflag 5, size 0) that round-trips", () => {
    const tar = createUstarTar(
      normalizeEntries({ "extras/": bytes(""), "a.txt": bytes("a") }),
      { mtime: 0 },
    );
    const back = readUstarTar(tar);
    const dir = back.find((e) => e.name === "extras");
    assert.ok(dir, "directory entry should round-trip via the reader");
    assert.equal(dir.type, "dir");
    assert.equal(dir.data, undefined);
    // Files still round-trip alongside directories.
    const file = back.find((e) => e.name === "a.txt");
    assert.ok(file && Buffer.from(file.data).equals(Buffer.from(bytes("a"))));
  });

  it("does not count directories as files", () => {
    const entries = normalizeEntries({
      "extras/": bytes(""),
      "a.txt": bytes("a"),
      "b.txt": bytes("b"),
    });
    assert.equal(entries.filter((e) => e.type !== "dir").length, 2);
    assert.equal(entries.filter((e) => e.type === "dir").length, 1);
  });

  it("skips unsafe directory paths (path traversal)", () => {
    const entries = normalizeEntries({
      "../evil/": bytes(""),
      "plugin/tool/../../evil/": bytes(""),
      "ok/": bytes(""),
    });
    const dirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
    assert.deepEqual(dirs, ["ok"]);
  });

  it("is deterministic with directory entries (stable sha256 across two builds)", () => {
    const map = {
      "extras/": bytes(""),
      "admin/tool/": bytes(""),
      "modules/quiz/version.php": bytes("<?php"),
      "z.txt": bytes("z"),
    };
    const a = createUstarTar(normalizeEntries(map), { mtime: 0 });
    const b = createUstarTar(normalizeEntries(map), { mtime: 0 });
    assert.ok(Buffer.from(a).equals(Buffer.from(b)));
    assert.equal(sha256(a), sha256(b));
    assert.equal(a.length % 512, 0);
  });
});
