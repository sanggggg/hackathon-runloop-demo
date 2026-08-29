import { defineConfig, devices } from "@playwright/test";

const host = process.env.QA_E2E_HOST ?? "127.0.0.1";
const ports = {
  baseline: Number(process.env.QA_BASELINE_PORT ?? 4173),
  discovery: Number(process.env.QA_DISCOVERY_PORT ?? 4175),
  regression: Number(process.env.QA_REGRESSION_PORT ?? 4174),
};

export const fixtureURLs = Object.fromEntries(
  Object.entries(ports).map(([profile, port]) => [
    profile,
    `http://${host}:${port}`,
  ]),
);

export default defineConfig({
  testDir: "./tests",
  testMatch: "e2e.spec.mjs",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: fixtureURLs.baseline,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: Object.entries(fixtureURLs).map(([profile, url]) => ({
    command: "npm start",
    env: {
      ...process.env,
      HOST: host,
      PORT: String(ports[profile]),
      QA_PROFILE: profile,
      QA_STATE_FILE: `.qa-state/e2e-${profile}.json`,
    },
    reuseExistingServer: false,
    timeout: 30_000,
    url: `${url}/__qa/health`,
  })),
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
