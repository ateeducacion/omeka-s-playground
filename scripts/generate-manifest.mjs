#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = resolve(args.manifest);
const dataPath = resolve(args.imageData);
const indexPath = resolve(args.imageIndex);

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  channel: args.channel,
  release: args.release,
  source: {
    repository: args.sourceRepository,
    branch: args.sourceBranch,
    commit: args.sourceCommit,
  },
  runtimeVersion: args.runtimeVersion,
  vfs: {
    format: "omeka-vfs-image-v1",
    mountMode: "memfs-hydrate-v1",
    data: {
      path: relative(resolve(manifestPath, ".."), dataPath).replaceAll("\\", "/"),
      fileName: basename(dataPath),
      size: statSync(dataPath).size,
      sha256: sha256(dataPath),
    },
    index: {
      path: relative(resolve(manifestPath, ".."), indexPath).replaceAll("\\", "/"),
      fileName: basename(indexPath),
      size: statSync(indexPath).size,
      sha256: sha256(indexPath),
    },
    fileCount: Number(args.fileCount || 0),
  },
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
