import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:8085";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  timeout: 180_000,
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer:
    process.env.PLAYWRIGHT_EXTERNAL_SERVER === "1"
      ? undefined
      : {
          // Reuse a pre-built bundle if present; otherwise build the default
          // version (git clone + composer + runtime) then serve. The build is
          // slow, so allow a generous startup window.
          command:
            "sh -lc 'if [ -f assets/manifests/latest.json ]; then PORT=8085 make serve; else PORT=8085 make bundle && PORT=8085 make serve; fi'",
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 600_000,
        },
  reporter: process.env.CI ? "line" : "list",
});
