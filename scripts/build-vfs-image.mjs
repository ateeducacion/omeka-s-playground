#!/usr/bin/env node

import { createWriteStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

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

function listFiles(rootDir) {
  const files = [];

  function walk(currentDir) {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  walk(rootDir);
  return files;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = resolve(args.source);
  const dataPath = resolve(args.data);
  const indexPath = resolve(args.index);
  const files = listFiles(sourceDir);
  const stream = createWriteStream(dataPath);
  mkdirSync(dirname(dataPath), { recursive: true });
  mkdirSync(dirname(indexPath), { recursive: true });

  const entries = [];
  let offset = 0;

  for (const absolute of files) {
    const data = readFileSync(absolute);
    const stats = statSync(absolute);
    await new Promise((resolveWrite, rejectWrite) => {
      stream.write(data, (error) => {
        if (error) {
          rejectWrite(error);
          return;
        }
        resolveWrite();
      });
    });
    entries.push({
      path: relative(sourceDir, absolute).replaceAll("\\", "/"),
      offset,
      size: data.byteLength,
      mode: stats.mode,
      mtimeMs: Math.trunc(stats.mtimeMs),
    });
    offset += data.byteLength;
  }

  await new Promise((resolveStream, rejectStream) => {
    stream.end((error) => {
      if (error) {
        rejectStream(error);
        return;
      }
      resolveStream();
    });
  });

  writeFileSync(indexPath, `${JSON.stringify({
    schemaVersion: 1,
    format: "omeka-vfs-image-v1",
    generatedAt: new Date().toISOString(),
    root: "/",
    fileCount: entries.length,
    totalBytes: offset,
    entries,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

