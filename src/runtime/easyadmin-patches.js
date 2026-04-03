export function patchEasyAdminGitLabArchiveFallback(rawPhp) {
  return String(rawPhp).replace(
    /(\s+case 'gitlab\.com':\s+)(\$zip = \$url \. '\/repository\/archive\.zip';)(\s+break;)/u,
    "$1// EasyAdmin builds an obsolete GitLab archive URL here. GitLab serves\n                    // public repository archives from the web archive route instead.\n                    $repoName = basename(parse_url($url, PHP_URL_PATH) ?: trim($url, '/'));\n                    $zip = rtrim($url, '/') . '/-/archive/master/' . $repoName . '-master.zip';$3",
  );
}

export function patchEasyAdminSqliteSessionSupport(rawPhp) {
  return String(rawPhp)
    .replaceAll(
      "'SHOW INDEX FROM `session` WHERE `column_name` = \"modified\";'",
      "'SELECT 1'",
    )
    .replaceAll(
      "DELETE `session` FROM `session` WHERE `modified` < :time;",
      "DELETE FROM `session` WHERE `modified` < :time;",
    )
    .replace(
      "$result = $this->connectionDbal->executeQuery(\"SHOW INDEX FROM `$table` WHERE `column_name` = '$column';\");\n        if (!$result->fetchOne()) {\n            try {\n                $this->connectionDbal->executeStatement(\"ALTER TABLE `$table` ADD INDEX `$column` (`$column`);\");\n            } catch (\\Exception $e) {\n                $this->logger->warn(\n                    'Unable to add index \"{column}\" in table \"{table}\" to improve performance: {msg}', // @translate\n                    ['column' => $column, 'table' => $table, 'msg' => $e->getMessage()]\n                );\n            }\n        }\n\n        $time = time();\n        $sql = 'DELETE FROM `session` WHERE `modified` < :time;';",
      "$platform = $this->connectionDbal->getDatabasePlatform()->getName();\n        if ($platform !== 'sqlite') {\n            $result = $this->connectionDbal->executeQuery(\"SHOW INDEX FROM `$table` WHERE `column_name` = '$column';\");\n            if (!$result->fetchOne()) {\n                try {\n                    $this->connectionDbal->executeStatement(\"ALTER TABLE `$table` ADD INDEX `$column` (`$column`);\");\n                } catch (\\Exception $e) {\n                    $this->logger->warn(\n                        'Unable to add index \"{column}\" in table \"{table}\" to improve performance: {msg}', // @translate\n                        ['column' => $column, 'table' => $table, 'msg' => $e->getMessage()]\n                    );\n                }\n            }\n        }\n\n        $time = time();\n        $sql = 'DELETE FROM `session` WHERE `modified` < :time;';",
    )
    .replace(
      "$dbname = $this->connection->getDatabase();\n        $sqlSize = <<<'SQL'\n            SELECT ROUND((data_length + index_length) / 1024 / 1024, 2)\n            FROM information_schema.TABLES\n            WHERE table_schema = ?\n                AND table_name = ?\n            SQL;\n        $size = $this->connection->executeQuery($sqlSize, [$dbname, $this->table])->fetchOne();",
      "$platform = $this->connection->getDatabasePlatform()->getName();\n        if ($platform === 'sqlite') {\n            $size = null;\n        } else {\n            $dbname = $this->connection->getDatabase();\n            $sqlSize = <<<'SQL'\n            SELECT ROUND((data_length + index_length) / 1024 / 1024, 2)\n            FROM information_schema.TABLES\n            WHERE table_schema = ?\n                AND table_name = ?\n            SQL;\n            $size = $this->connection->executeQuery($sqlSize, [$dbname, $this->table])->fetchOne();\n        }",
    )
    .replace(
      "        if ($recreate) {\n            $this->connection->executeStatement('SET foreign_key_checks = 0');\n            $this->connection->executeStatement('CREATE TABLE `session_new` LIKE `session`');\n            $this->connection->executeStatement('RENAME TABLE `session` TO `session_old`, `session_new` TO `session`');\n            $this->connection->executeStatement('DROP TABLE `session_old`');\n            $this->connection->executeStatement('SET foreign_key_checks = 1');\n            return;\n        }\n",
      "        if ($recreate) {\n            if ($platform === 'sqlite') {\n                $this->logger->warn(\n                    'Session table recreation is not supported on SQLite.' // @translate\n                );\n                return;\n            }\n            $this->connection->executeStatement('SET foreign_key_checks = 0');\n            $this->connection->executeStatement('CREATE TABLE `session_new` LIKE `session`');\n            $this->connection->executeStatement('RENAME TABLE `session` TO `session_old`, `session_new` TO `session`');\n            $this->connection->executeStatement('DROP TABLE `session_old`');\n            $this->connection->executeStatement('SET foreign_key_checks = 1');\n            return;\n        }\n",
    )
    .replace(
      "$size = $this->connection->executeQuery($sqlSize, [$dbname, $this->table])->fetchOne();",
      "$size = $platform === 'sqlite'\n                ? null\n                : $this->connection->executeQuery($sqlSize, [$dbname, $this->table])->fetchOne();",
    );
}
