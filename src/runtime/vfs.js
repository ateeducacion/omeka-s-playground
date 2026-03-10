export async function fetchArrayBuffer(path, cache = "default") {
  const response = await fetch(path, { cache });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${path}: ${response.status}`);
  }
  return response.arrayBuffer();
}

function ensureDirSync(FS, path) {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    const about = FS.analyzePath(current);
    if (!about?.exists) {
      try {
        FS.mkdir(current);
      } catch {
        // Ignore existing directories.
      }
    }
  }
}

export async function loadReadonlyVfs(manifest) {
  if (!manifest.vfs?.data?.path || !manifest.vfs?.index?.path) {
    throw new Error("Manifest does not describe a VFS image.");
  }

  const [data, index] = await Promise.all([
    fetchArrayBuffer(new URL(`../../assets/manifests/${manifest.vfs.data.path}`, import.meta.url)),
    fetch(new URL(`../../assets/manifests/${manifest.vfs.index.path}`, import.meta.url), { cache: "default" }).then((response) => {
      if (!response.ok) {
        throw new Error(`Unable to fetch ${manifest.vfs.index.path}: ${response.status}`);
      }
      return response.json();
    }),
  ]);

  return { data, index };
}

export async function mountReadonlyCore(php, manifest, { root = "/www/omeka" } = {}) {
  const vfs = await loadReadonlyVfs(manifest);
  const binary = await php.binary;
  const { FS } = binary;
  const bytes = new Uint8Array(vfs.data);

  ensureDirSync(FS, root);

  for (const entry of vfs.index.entries) {
    const targetPath = `${root}/${entry.path}`.replace(/\/{2,}/gu, "/");
    const dirPath = targetPath.split("/").slice(0, -1).join("/") || "/";
    ensureDirSync(FS, dirPath);
    FS.writeFile(targetPath, bytes.subarray(entry.offset, entry.offset + entry.size));
  }

  return vfs;
}
