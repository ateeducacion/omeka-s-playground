#!/usr/bin/env node

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(scriptDir, "..");
const vendorDir = resolve(repoDir, "vendor");

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function copyPackage(packageName, targetName = packageName) {
  const sourceDir = resolve(repoDir, "node_modules", packageName);
  const targetDir = resolve(vendorDir, targetName);
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(sourceDir, targetDir, { recursive: true });
}

// Only fflate is still served directly from vendor/
ensureDir(vendorDir);
copyPackage("fflate");

console.log("Synced browser dependencies into vendor/.");
