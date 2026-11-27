# Resolution fixtures

The schema cannot check how sources resolve. Each case folder holds a `blueprint.json`, the files it
imports, and an `expected.json` for consumers to test their resolvers against. The results are the
same whether the blueprint is read from disk or loaded from a URL.

The root is the folder of `blueprint.json`. A file imported by an absolute URL or by `gh:`/`gl:` has
its own folder as root; a file imported by a relative path keeps its importer's root. Relative paths
resolve against the file that contains them.

`expected.json` is an array of `{ "in", "pointer", "resolved" }`: `in` is a file relative to the case,
and `pointer` a JSON pointer to a string in it. `resolved` is one of:

- `{ "path" }`: a file relative to the case, decoded (`./My%20File.pdf` gives `My File.pdf`);
- `{ "url" }`: a download;
- `{ "repository": "<host>/<path>", "ref": "<ref>" | null }`: a git repository;
- `{ "repository": "<host>/<path>", "ref": "<ref>" | null, "path": "<path in repo>" }`: a file in a git repository;
- `{ "error": "outside-root" }`: a relative path leaves the root;
- `{ "error": "outside-repository" }`: a git source has a `..` segment, also percent-encoded, in its
  owner, group, repository, ref or path, as written;
- `{ "error": "encoded-separator" }`: a segment of a relative path decodes to `/` or `\`.

A case holds only results or only errors, so a harness can stop at the first error. A consumer that
does not support a form (a GitLab or `git@` repository, for example) skips the entries that use it.
