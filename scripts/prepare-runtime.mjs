#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(scriptDir, "..");

for (const path of [
  resolve(repoDir, ".cache"),
  resolve(repoDir, ".cache/omeka-source"),
  resolve(repoDir, "assets/omeka"),
  resolve(repoDir, "assets/manifests"),
  resolve(repoDir, "vendor"),
]) {
  mkdirSync(path, { recursive: true });
}

console.log("Prepared cache, asset, and vendor directories.");

