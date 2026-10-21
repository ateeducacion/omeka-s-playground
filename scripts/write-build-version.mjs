#!/usr/bin/env node
// Writes the Playground Build ID metadata consumed by the shell, the Service
// Worker and the deployed site. Run via `npm run build:version`.
//
//   node scripts/write-build-version.mjs                 # generate both files
//   node scripts/write-build-version.mjs --print-version # print the ID only
//
// CI computes the Build ID once with --print-version, exports it as
// BUILD_VERSION, and every later step reuses that exact value — so one
// pipeline run produces one Build ID, and the GitHub Pages and Cloudflare
// Pages deployments of the same _site report the same build.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderBuildVersionModule,
  resolveBuildMetadata,
} from "./lib/build-version.mjs";

const defaultRepoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function tryGit(repoDir, args) {
  try {
    return execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Resolve the build metadata and write it (or print the ID with --print-version). */
export function writeBuildVersion({
  argv = process.argv,
  env = process.env,
  repoDir = defaultRepoDir,
  stdout = process.stdout,
  log = console.log,
} = {}) {
  const git = {
    sha: () => tryGit(repoDir, ["rev-parse", "HEAD"]),
    dirty: () => Boolean(tryGit(repoDir, ["status", "--porcelain"])),
  };
  const metadata = resolveBuildMetadata({ env, git });

  if (argv.includes("--print-version")) {
    stdout.write(`${metadata.buildVersion}\n`);
    return metadata;
  }
  const jsOutputPath = resolve(repoDir, "src/generated/build-version.js");
  const jsonOutputPath = resolve(repoDir, "assets/build-version.json");
  mkdirSync(dirname(jsOutputPath), { recursive: true });
  mkdirSync(dirname(jsonOutputPath), { recursive: true });
  writeFileSync(jsOutputPath, renderBuildVersionModule(metadata), "utf8");
  writeFileSync(
    jsonOutputPath,
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  log(`Wrote build metadata ${metadata.buildVersion}`);
  return metadata;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  writeBuildVersion();
}
