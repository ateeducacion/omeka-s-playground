#!/usr/bin/env node

import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(scriptDir, "..");
const vendorDir = resolve(repoDir, "vendor");
const extensionPackages = [
  "fflate",
  "php-wasm-iconv",
  "php-wasm-intl",
  "php-wasm-libxml",
  "php-wasm-xml",
  "php-wasm-sqlite",
  "php-wasm-dom",
  "php-wasm-gd",
  "php-wasm-simplexml",
  "php-wasm-libzip",
  "php-wasm-mbstring",
  "php-wasm-openssl",
  "php-wasm-zlib",
  "php-wasm-phar",
];

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function copyTree(sourceDir, targetDir, transform = null) {
  ensureDir(targetDir);

  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);
    const stats = statSync(sourcePath);

    if (stats.isDirectory()) {
      copyTree(sourcePath, targetPath, transform);
      continue;
    }

    const transformed = transform ? transform(sourcePath, targetPath) : null;
    if (transformed) {
      ensureDir(dirname(transformed.path));
      writeFileSync(transformed.path, transformed.contents);
      continue;
    }

    cpSync(sourcePath, targetPath);
  }
}

function transformEsm(sourcePath, targetPath) {
  const extension = extname(sourcePath);

  if (extension === ".mjs") {
    const contents = readFileSync(sourcePath, "utf8")
      .replaceAll(".mjs", ".js")
      .replace(
        /const moduleRoot = url \+ \(String\(url\)\.substr\(-10\) !== '\/index\.js' \? '\/' : ''\);/gu,
        "const moduleRoot = new URL('./', importMeta.url);",
      )
      .replace(
        /const moduleRoot = url \+ \(String\(url\)\.substr\(-10\) !== '\/index\.mjs' \? '\/' : ''\);/gu,
        "const moduleRoot = new URL('./', importMeta.url);",
      );

    return {
      path: targetPath.replace(/\.mjs$/u, ".js"),
      contents,
    };
  }

  return null;
}

function copyPackage(packageName, targetName = packageName) {
  const sourceDir = resolve(repoDir, "node_modules", packageName);
  const targetDir = resolve(vendorDir, targetName);
  rmSync(targetDir, { recursive: true, force: true });
  copyTree(sourceDir, targetDir, transformEsm);
}

rmSync(resolve(vendorDir, "php-wasm"), { recursive: true, force: true });
rmSync(resolve(vendorDir, "php-cgi-wasm"), { recursive: true, force: true });
rmSync(resolve(vendorDir, "pglite"), { recursive: true, force: true });

copyPackage("php-wasm", "php-wasm");
copyPackage("php-cgi-wasm", "php-cgi-wasm");
for (const packageName of extensionPackages) {
  copyPackage(packageName);
}
cpSync(
  resolve(repoDir, "node_modules", "@electric-sql", "pglite", "dist"),
  resolve(vendorDir, "pglite"),
  {
    recursive: true,
  },
);

console.log("Synced browser dependencies into vendor/.");
