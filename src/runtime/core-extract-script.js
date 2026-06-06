const escapePhp = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");

/**
 * Extract the readonly core bundle into the webroot using PHP's ZipArchive
 * instead of decompressing the whole archive in JavaScript.
 *
 * Why: the JS path (fflate `unzipSync`) decompresses every entry into the JS
 * heap at once and then copies it into MEMFS. For the core bundle
 * (~19 MB / 9 310 files, re-extracted on every boot) that peak risks MEMFS OOM
 * on constrained clients; the streaming `decodeZip` alternative spins up a
 * DecompressionStream per entry and is far too slow at this file count (boot
 * exceeds the readiness gate). libzip's `extractTo()` inflates + writes one
 * entry at a time in native code — fast regardless of file count and ~one-entry
 * peak.
 *
 * The bundle stores files at the archive root (no wrapping folder); a lone
 * top-level wrapper is descended into when present so the same builder is reused
 * across the sibling playgrounds.
 *
 * Contract: prints exactly one sentinel on stdout:
 *   - `NO_ZIP_EXT`            → the build lacks ext/zip (caller fails loud).
 *   - `INSTALL_OK <count>`    → extracted <count> entries into the target.
 *   - `INSTALL_ERR <message>` → anything else (caller fails loud).
 * On success the temp zip is removed.
 */
export function buildCoreExtractScript(zipPath, stagePath, targetRoot) {
  const zip = escapePhp(zipPath);
  const stage = escapePhp(stagePath);
  const target = escapePhp(targetRoot);
  return `<?php
echo (function () {
  $zipPath = '${zip}';
  $stage = '${stage}';
  $target = '${target}';
  if (!class_exists('ZipArchive')) { return 'NO_ZIP_EXT'; }
  $rrmdir = function ($dir) use (&$rrmdir) {
    if (!is_dir($dir)) { return; }
    foreach (scandir($dir) as $e) {
      if ($e === '.' || $e === '..') { continue; }
      $p = $dir . '/' . $e;
      is_dir($p) ? $rrmdir($p) : @unlink($p);
    }
    @rmdir($dir);
  };
  try {
    $rrmdir($stage);
    @mkdir($stage, 0777, true);
    $zip = new ZipArchive();
    $rc = $zip->open($zipPath);
    if ($rc !== true) { $rrmdir($stage); return 'INSTALL_ERR open=' . $rc; }
    $ok = $zip->extractTo($stage);
    $count = $zip->numFiles;
    $zip->close();
    if (!$ok) { $rrmdir($stage); return 'INSTALL_ERR extract'; }
    // Descend into a lone wrapping folder; root-level bundles keep several top
    // entries and are used as-is.
    $top = array_values(array_diff(scandir($stage), ['.', '..']));
    $src = $stage;
    if (count($top) === 1 && is_dir($stage . '/' . $top[0])) {
      $src = $stage . '/' . $top[0];
    }
    $rrmdir($target);
    @mkdir(dirname($target), 0777, true);
    if (!@rename($src, $target)) { $rrmdir($stage); return 'INSTALL_ERR rename'; }
    $rrmdir($stage);
    @unlink($zipPath);
    return 'INSTALL_OK ' . $count;
  } catch (\\Throwable $e) {
    $rrmdir($stage);
    return 'INSTALL_ERR ' . $e->getMessage();
  }
})();
`;
}
