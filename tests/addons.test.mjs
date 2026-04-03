import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  patchEasyAdminGitLabArchiveFallback,
  patchEasyAdminSqliteSessionSupport,
} from "../src/runtime/addons.js";
import { parseGitHubArchiveUrl } from "../src/shared/github.js";

describe("parseGitHubArchiveUrl", () => {
  it("parses GitHub archive branch URLs with nested branch names", () => {
    assert.deepEqual(
      parseGitHubArchiveUrl(
        "https://github.com/exelearning/omeka-s-exelearning/archive/refs/heads/feature/remote-embeded-editor.zip",
      ),
      {
        owner: "exelearning",
        repo: "omeka-s-exelearning",
        refType: "heads",
        ref: "feature/remote-embeded-editor",
        sourceUrl:
          "https://github.com/exelearning/omeka-s-exelearning/archive/refs/heads/feature/remote-embeded-editor.zip",
      },
    );
  });

  it("parses codeload archive tag URLs", () => {
    assert.deepEqual(
      parseGitHubArchiveUrl(
        "https://codeload.github.com/exelearning/omeka-s-exelearning/zip/refs/tags/v1.2.3",
      ),
      {
        owner: "exelearning",
        repo: "omeka-s-exelearning",
        refType: "tags",
        ref: "v1.2.3",
        sourceUrl:
          "https://codeload.github.com/exelearning/omeka-s-exelearning/zip/refs/tags/v1.2.3",
      },
    );
  });

  it("returns null for non-GitHub archive URLs", () => {
    assert.equal(
      parseGitHubArchiveUrl("https://example.com/downloads/addon.zip"),
      null,
    );
  });
});

describe("patchEasyAdminGitLabArchiveFallback", () => {
  it("rewrites the obsolete GitLab archive fallback used by EasyAdmin", () => {
    const original = `                case 'gitlab.com':
                    $zip = $url . '/repository/archive.zip';
                    break;`;

    const patched = patchEasyAdminGitLabArchiveFallback(original);

    assert.match(patched, /GitLab serves/u);
    assert.match(
      patched,
      /\$zip = rtrim\(\$url, '\/'\) \. '\/-\/archive\/master\/' \. \$repoName \. '-master\.zip';/u,
    );
    assert.doesNotMatch(patched, /repository\/archive\.zip/u);
  });
});

describe("patchEasyAdminSqliteSessionSupport", () => {
  it("replaces MySQL-specific session cleanup SQL with SQLite-safe fallbacks", () => {
    const original = `
        $result = $this->connection->executeQuery(
            'SHOW INDEX FROM \`session\` WHERE \`column_name\` = "modified";'
        );

        $result = $this->connectionDbal->executeQuery("SHOW INDEX FROM \`$table\` WHERE \`column_name\` = '$column';");
        if (!$result->fetchOne()) {
            try {
                $this->connectionDbal->executeStatement("ALTER TABLE \`$table\` ADD INDEX \`$column\` (\`$column\`);");
            } catch (\\Exception $e) {
                $this->logger->warn(
                    'Unable to add index "{column}" in table "{table}" to improve performance: {msg}', // @translate
                    ['column' => $column, 'table' => $table, 'msg' => $e->getMessage()]
                );
            }
        }

        $time = time();
        $sql = 'DELETE \`session\` FROM \`session\` WHERE \`modified\` < :time;';
    `;

    const patched = patchEasyAdminSqliteSessionSupport(original);

    assert.doesNotMatch(
      patched,
      /'SHOW INDEX FROM `session` WHERE `column_name` = "modified";'/u,
    );
    assert.match(patched, /SELECT 1/u);
    assert.doesNotMatch(patched, /DELETE `session` FROM `session`/u);
    assert.match(patched, /DELETE FROM `session` WHERE `modified` < :time;/u);
    assert.match(
      patched,
      /\$platform = \$this->connectionDbal->getDatabasePlatform\(\)->getName\(\);/u,
    );
  });
});
