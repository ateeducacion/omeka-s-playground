const GITHUB_ARCHIVE_HOSTS = new Set(["github.com", "www.github.com"]);
const GITHUB_CODELOAD_HOST = "codeload.github.com";

function normalizeHost(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function parseGitHubArchiveUrl(rawUrl, baseUrl = "http://localhost/") {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""), baseUrl);
  } catch {
    return null;
  }

  const hostname = normalizeHost(parsed.hostname);
  const segments = parsed.pathname.split("/").filter(Boolean);

  if (
    GITHUB_ARCHIVE_HOSTS.has(hostname) &&
    segments.length >= 6 &&
    segments[2] === "archive" &&
    segments[3] === "refs" &&
    ["heads", "tags"].includes(segments[4])
  ) {
    const ref = decodeURIComponent(
      segments
        .slice(5)
        .join("/")
        .replace(/\.zip$/iu, ""),
    );
    if (!ref) {
      return null;
    }

    return {
      owner: segments[0],
      repo: segments[1],
      refType: segments[4],
      ref,
      sourceUrl: parsed.toString(),
    };
  }

  if (
    hostname === GITHUB_CODELOAD_HOST &&
    segments.length >= 6 &&
    segments[2] === "zip" &&
    segments[3] === "refs" &&
    ["heads", "tags"].includes(segments[4])
  ) {
    const ref = decodeURIComponent(segments.slice(5).join("/"));
    if (!ref) {
      return null;
    }

    return {
      owner: segments[0],
      repo: segments[1],
      refType: segments[4],
      ref,
      sourceUrl: parsed.toString(),
    };
  }

  return null;
}
