import { expect, test } from "@playwright/test";

// `$import`, `vocabularies` and `resourceTemplates` of the shared blueprint
// format, provisioned into a real Omeka S. Fixtures: tests/e2e/fixtures/blueprints.

test.describe.configure({ timeout: 300_000 });

const FIXTURES = "/tests/e2e/fixtures/blueprints";

async function waitForRuntimeReady(page) {
  await expect(page.locator("#runtime-id-value")).not.toHaveText("-");
  await expect(page.locator("#address-input")).toBeEnabled();
  await expect(page.locator("#site-frame")).toHaveAttribute("src", /scope=/);
}

function remoteFrame(page) {
  return page.frameLocator("#site-frame").frameLocator("#remote-frame");
}

async function open(page, path) {
  await page.locator("#address-input").fill(path);
  await page.locator("#address-input").press("Enter");
}

async function expectProvisioned(page) {
  const remote = remoteFrame(page);
  await open(page, "/admin/vocabulary");
  const rows = remote.locator("table tbody tr");
  // imported once, with its properties; dcterms (declared too) is left as is
  await expect(rows.filter({ hasText: "Playground Test" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Playground Test" })).toContainText("2");
  await expect(rows.filter({ hasText: /\bdcterms\b/u })).toHaveCount(1);

  await open(page, "/admin/resource-template");
  for (const label of [
    "Test Book",
    "Test Book (relabelled)",
    "Needs Missing",
  ]) {
    await expect(
      remote.getByRole("link", { name: label, exact: true }),
    ).toHaveCount(1);
  }
}

test("provisions vocabularies and resource templates through relative imports", async ({
  page,
}) => {
  await page.goto(`/?blueprint-url=${FIXTURES}/blueprint.json`);
  await waitForRuntimeReady(page);
  await expect(page.locator("#address-input")).toHaveValue("/admin/vocabulary");
  await expectProvisioned(page);

  // the imported settings partial
  await open(page, "/admin/setting");
  await expect(
    remoteFrame(page).locator('input[name$="pagination_per_page"]'),
  ).toHaveValue("17");

  // the template keeps its class, and the property of the imported vocabulary
  await open(page, "/admin/resource-template");
  await remoteFrame(page)
    .getByRole("link", { name: "Test Book", exact: true })
    .click();
  await expect(remoteFrame(page).locator("body")).toContainText("Book");
  await expect(remoteFrame(page).locator("body")).toContainText("ISBN");

  // Reload: the journal is replayed and provisioning finds everything in place.
  await page.waitForTimeout(2500);
  await page.reload({ waitUntil: "commit" });
  await waitForRuntimeReady(page);
  await expectProvisioned(page);
  const log = page.locator("#log-panel");
  await expect(log).toContainText(
    'Blueprint vocabulary "pgtest" (https://example.org/omeka-s-playground/test#) already exists.',
  );
  await expect(log).toContainText(
    'Blueprint resource template "Test Book" already exists.',
  );
  await expect(log).not.toContainText("Imported blueprint");
});

test("boots an inline blueprint that combines a module, imports, a vocabulary and templates", async ({
  page,
  baseURL,
}) => {
  const fixture = (path) => new URL(`${FIXTURES}/${path}`, baseURL).href;
  const blueprint = {
    $schema:
      "https://omeka-s-contrib.github.io/omeka-s-blueprints/schema/v0/blueprint-schema.json",
    modules: [
      {
        name: "InsertIgnoreProbe",
        source: new URL("/tests/e2e/fixtures/InsertIgnoreProbe.zip", baseURL)
          .href,
      },
    ],
    vocabularies: [{ $import: fixture("partials/vocabularies.json") }],
    resourceTemplates: [
      { $import: fixture("partials/resource-templates.json") },
    ],
    "x-playground": { landingPage: "/admin/module" },
  };
  const payload = Buffer.from(JSON.stringify(blueprint)).toString("base64url");
  await page.goto(`/?blueprint=${payload}`);
  await waitForRuntimeReady(page);
  await expect(remoteFrame(page).locator("body")).toContainText(
    "Insert Ignore Probe",
  );

  await open(page, "/admin/vocabulary");
  await expect(
    remoteFrame(page)
      .locator("table tbody tr")
      .filter({ hasText: "Playground Test" }),
  ).toHaveCount(1);
  await open(page, "/admin/resource-template");
  await expect(
    remoteFrame(page).getByRole("link", { name: "Test Book", exact: true }),
  ).toHaveCount(1);
});

test("stops on a resource template whose dependencies are missing", async ({
  page,
  baseURL,
}) => {
  const blueprint = {
    resourceTemplates: [
      {
        source: new URL(`${FIXTURES}/templates/needs-missing.json`, baseURL)
          .href,
      },
    ],
  };
  const payload = Buffer.from(JSON.stringify(blueprint)).toString("base64url");
  await page.goto(`/?blueprint=${payload}`);
  await expect(page.locator("#log-panel")).toContainText(
    'Blueprint resource template "Needs Missing" needs what this installation lacks',
    { timeout: 180_000 },
  );
  await expect(page.locator("#log-panel")).toContainText(
    "property https://example.org/not-installed#thing",
  );
});

test("reports schema and import errors before booting", async ({ page }) => {
  const encode = (blueprint) =>
    Buffer.from(JSON.stringify(blueprint)).toString("base64url");

  await page.goto(
    `/?blueprint=${encode({
      $schema:
        "https://omeka-s-contrib.github.io/omeka-s-blueprints/schema/v0/blueprint-schema.json",
      vocabularies: [{ prefix: "x" }],
    })}`,
  );
  await expect(page.locator("#log-panel")).toContainText(
    "BlueprintSchemaError",
  );

  await page.goto(
    `/?blueprint=${encode({ modules: [{ $import: "./m.json" }] })}`,
  );
  await expect(page.locator("#log-panel")).toContainText(
    'BlueprintImportError: Blueprint modules $import: "./m.json" cannot be resolved',
  );
});

test("stops on invalid vocabulary and resource template sources", async ({
  page,
  baseURL,
}) => {
  const fixture = (path) => new URL(`${FIXTURES}/${path}`, baseURL).href;
  const vocabulary = {
    prefix: "pgtest",
    namespaceUri: "https://example.org/omeka-s-playground/test#",
    label: "Playground Test",
  };
  const cases = [
    [
      // not RDF
      {
        vocabularies: [
          {
            ...vocabulary,
            source: fixture("templates/book.json"),
            format: "turtle",
          },
        ],
      },
      'Unable to import blueprint vocabulary "pgtest"',
    ],
    [
      // RDF without terms in that namespace
      {
        vocabularies: [
          {
            ...vocabulary,
            namespaceUri: "https://example.org/other#",
            source: fixture("vocabularies/playground-test.ttl"),
          },
        ],
      },
      "No classes or properties found",
    ],
    [
      {
        vocabularies: [
          { ...vocabulary, source: fixture("vocabularies/missing.ttl") },
        ],
      },
      'Blueprint vocabulary "pgtest": unable to download',
    ],
    [
      {
        resourceTemplates: [
          { source: fixture("vocabularies/playground-test.ttl") },
        ],
      },
      "is not a valid resource template export",
    ],
  ];
  for (const [blueprint, message] of cases) {
    const payload = Buffer.from(JSON.stringify(blueprint)).toString(
      "base64url",
    );
    await page.goto(`/?blueprint=${payload}`);
    await expect(page.locator("#log-panel")).toContainText(message, {
      timeout: 180_000,
    });
  }
});
