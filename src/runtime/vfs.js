export async function fetchArrayBuffer(path) {
  const response = await fetch(path, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${path}: ${response.status}`);
  }
  return response.arrayBuffer();
}

async function ensureDir(php, path) {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    const about = await php.analyzePath(current);
    if (!about?.exists) {
      try {
        await php.mkdir(current);
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
    fetch(new URL(`../../assets/manifests/${manifest.vfs.index.path}`, import.meta.url), { cache: "force-cache" }).then((response) => {
      if (!response.ok) {
        throw new Error(`Unable to fetch ${manifest.vfs.index.path}: ${response.status}`);
      }
      return response.json();
    }),
  ]);

  return { data, index };
}

export async function mountReadonlyCore(php, manifest) {
  const vfs = await loadReadonlyVfs(manifest);
  const bytes = new Uint8Array(vfs.data);
  const root = "/persist/www/omeka";

  await ensureDir(php, root);

  for (const entry of vfs.index.entries) {
    const targetPath = `${root}/${entry.path}`.replace(/\/{2,}/gu, "/");
    const dirPath = targetPath.split("/").slice(0, -1).join("/") || "/";
    await ensureDir(php, dirPath);
    const slice = bytes.slice(entry.offset, entry.offset + entry.size);
    await php.writeFile(targetPath, slice);
  }

  return vfs;
}
