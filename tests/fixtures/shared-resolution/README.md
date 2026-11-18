# Resolution fixtures

The schema cannot check how sources resolve. Each case folder holds a `blueprint.json`, the files it
imports, and an `expected.json` for consumers to test their resolvers against.
The root is the folder of `blueprint.json`, also when the blueprint is loaded from a URL; a file imported
by an absolute URL is its own root. Relative paths resolve against the file that contains them.
`expected.json` is an array of `{ "in", "pointer", "resolved" }`: `in` is a file relative to the case,
`pointer` a JSON pointer to a string in it, and `resolved` one of `{ "path" }` (relative to the case),
`{ "url" }`, `{ "repository": "github.com/<owner>/<repo>", "ref": "<ref>" | null }`, or `{ "error": "outside-root" }`.
