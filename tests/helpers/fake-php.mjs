// In-memory stand-ins for the Emscripten FS and the @php-wasm PHP instance, so
// runtime modules (bootstrap, addons, php-compat, crash recovery) run under Node
// without WASM. Semantics follow Emscripten where the runtime relies on them:
// analyzePath() follows a final symlink unless asked not to, readdir() lists
// "." and "..", and mkdir() throws on an existing path.
import { __private__dont__use } from "@php-wasm/universal";

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFMT = 0o170000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalize(path) {
  const parts = [];
  for (const part of String(path).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function fsError(code, path) {
  const error = new Error(`${code}: ${path}`);
  error.code = code;
  return error;
}

export function createFakeFs(initialFiles = {}) {
  // path -> { mode, data?: Uint8Array, target?: string }
  const nodes = new Map([["/", { mode: S_IFDIR | 0o755 }]]);
  let cwd = "/";

  const resolve = (path, followLast = true, depth = 0) => {
    const parts = normalize(path).split("/").filter(Boolean);
    let current = "";
    for (let index = 0; index < parts.length; index += 1) {
      current = `${current}/${parts[index]}`;
      const node = nodes.get(current);
      const isLast = index === parts.length - 1;
      if (node && (node.mode & S_IFMT) === S_IFLNK && (!isLast || followLast)) {
        if (depth > 16) throw fsError("ELOOP", path);
        const target = node.target.startsWith("/")
          ? node.target
          : `${current.slice(0, current.lastIndexOf("/"))}/${node.target}`;
        current = resolve(target, true, depth + 1);
      }
    }
    return current || "/";
  };

  const parentOf = (path) => path.slice(0, path.lastIndexOf("/")) || "/";

  const FS = {
    nodes,
    analyzePath(path, dontResolveLastLink = false) {
      const resolved = resolve(path, !dontResolveLastLink);
      const node = nodes.get(resolved);
      return node
        ? { exists: true, path: resolved, object: { mode: node.mode } }
        : { exists: false, path: resolved, object: null };
    },
    isDir: (mode) => (mode & S_IFMT) === S_IFDIR,
    isFile: (mode) => (mode & S_IFMT) === S_IFREG,
    isLink: (mode) => (mode & S_IFMT) === S_IFLNK,
    stat(path) {
      const node = nodes.get(resolve(path));
      if (!node) throw fsError("ENOENT", path);
      return { mode: node.mode, size: node.data?.byteLength ?? 4096 };
    },
    lstat(path) {
      const node = nodes.get(resolve(path, false));
      if (!node) throw fsError("ENOENT", path);
      return { mode: node.mode, size: node.data?.byteLength ?? 4096 };
    },
    readdir(path) {
      const dir = resolve(path);
      const node = nodes.get(dir);
      if (!node) throw fsError("ENOENT", path);
      if (!FS.isDir(node.mode)) throw fsError("ENOTDIR", path);
      const prefix = dir === "/" ? "/" : `${dir}/`;
      const names = [];
      for (const key of nodes.keys()) {
        if (key !== dir && key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (!rest.includes("/")) names.push(rest);
        }
      }
      return [".", "..", ...names.sort()];
    },
    mkdir(path) {
      const target = resolve(path, false);
      if (nodes.has(target)) throw fsError("EEXIST", path);
      const parent = nodes.get(parentOf(target));
      if (!parent || !FS.isDir(parent.mode)) throw fsError("ENOENT", path);
      nodes.set(target, { mode: S_IFDIR | 0o755 });
    },
    mkdirTree(path) {
      let current = "";
      for (const part of normalize(path).split("/").filter(Boolean)) {
        current = `${current}/${part}`;
        const resolved = resolve(current);
        if (!nodes.has(resolved))
          nodes.set(resolved, { mode: S_IFDIR | 0o755 });
        current = resolved;
      }
    },
    writeFile(path, data) {
      const target = resolve(path);
      const parent = nodes.get(parentOf(target));
      if (!parent || !FS.isDir(parent.mode)) throw fsError("ENOENT", path);
      const existing = nodes.get(target);
      if (existing && FS.isDir(existing.mode)) throw fsError("EISDIR", path);
      const bytes =
        typeof data === "string"
          ? encoder.encode(data)
          : new Uint8Array(
              data instanceof ArrayBuffer
                ? data
                : data.buffer.slice(
                    data.byteOffset,
                    data.byteOffset + data.byteLength,
                  ),
            );
      nodes.set(target, { mode: S_IFREG | 0o644, data: bytes });
    },
    readFile(path, options = {}) {
      const node = nodes.get(resolve(path));
      if (!node) throw fsError("ENOENT", path);
      if (FS.isDir(node.mode)) throw fsError("EISDIR", path);
      return options.encoding === "utf8"
        ? decoder.decode(node.data)
        : node.data;
    },
    unlink(path) {
      const target = resolve(path, false);
      const node = nodes.get(target);
      if (!node) throw fsError("ENOENT", path);
      if (FS.isDir(node.mode)) throw fsError("EISDIR", path);
      nodes.delete(target);
    },
    rmdir(path) {
      const target = resolve(path, false);
      const node = nodes.get(target);
      if (!node) throw fsError("ENOENT", path);
      if (!FS.isDir(node.mode)) throw fsError("ENOTDIR", path);
      if (FS.readdir(target).length > 2) throw fsError("ENOTEMPTY", path);
      nodes.delete(target);
    },
    rename(from, to) {
      const source = resolve(from, false);
      const target = resolve(to, false);
      for (const key of [...nodes.keys()]) {
        if (key === source || key.startsWith(`${source}/`)) {
          nodes.set(target + key.slice(source.length), nodes.get(key));
          nodes.delete(key);
        }
      }
    },
    symlink(targetPath, linkPath) {
      const link = resolve(linkPath, false);
      if (nodes.has(link)) throw fsError("EEXIST", linkPath);
      nodes.set(link, { mode: S_IFLNK | 0o777, target: targetPath });
    },
    readlink(path) {
      const node = nodes.get(resolve(path, false));
      if (!node || !FS.isLink(node.mode)) throw fsError("EINVAL", path);
      return node.target;
    },
    chdir(path) {
      cwd = resolve(path);
    },
    cwd: () => cwd,
  };

  for (const [path, content] of Object.entries(initialFiles)) {
    FS.mkdirTree(parentOf(normalize(path)));
    FS.writeFile(path, content);
  }

  return FS;
}

// A stand-in for the @php-wasm `PHP` instance. `run` receives the request the
// runtime builds and returns a PHPResponse-shaped object; tests pass `onRun` to
// script what PHP "prints" for each script path.
export function createFakeRawPhp({ files = {}, onRun } = {}) {
  const FS = createFakeFs(files);
  const runs = [];
  const listeners = new Map();
  const php = {
    FS,
    runs,
    listeners,
    [__private__dont__use]: Promise.resolve({ FS }),
    fileExists: (path) => FS.analyzePath(path).exists,
    isDir(path) {
      const about = FS.analyzePath(path);
      return about.exists && FS.isDir(about.object.mode);
    },
    isFile(path) {
      const about = FS.analyzePath(path);
      return about.exists && FS.isFile(about.object.mode);
    },
    mkdir: (path) => FS.mkdirTree(path),
    mkdirTree: (path) => FS.mkdirTree(path),
    writeFile: (path, data) => FS.writeFile(path, data),
    readFileAsBuffer: (path) => FS.readFile(path),
    readFileAsText: (path) => FS.readFile(path, { encoding: "utf8" }),
    unlink: (path) => FS.unlink(path),
    listFiles: (path) =>
      FS.readdir(path).filter((n) => n !== "." && n !== ".."),
    async run(request) {
      runs.push(request);
      const result = onRun ? await onRun(request, php) : {};
      return {
        httpStatusCode: result.status ?? 200,
        headers: result.headers ?? {},
        bytes: encoder.encode(result.body ?? ""),
        text: result.body ?? "",
        errors: result.errors ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) || []), handler]);
    },
    removeEventListener(type, handler) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter((entry) => entry !== handler),
      );
    },
  };
  return php;
}

export function textResponse(body, init = {}) {
  return new Response(body, init);
}

// Replace globalThis.fetch with a router for the duration of a test.
export function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : (input.url ?? String(input));
    calls.push({ url, init });
    return handler(url, init);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}
