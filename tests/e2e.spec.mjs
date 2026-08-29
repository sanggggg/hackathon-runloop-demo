import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(ROOT, "qa", "manifest.json"), "utf8"),
);
const host = process.env.QA_E2E_HOST ?? "127.0.0.1";
const fixtureURLs = {
  baseline: `http://${host}:${process.env.QA_BASELINE_PORT ?? 4173}`,
  regression: `http://${host}:${process.env.QA_REGRESSION_PORT ?? 4174}`,
  discovery: `http://${host}:${process.env.QA_DISCOVERY_PORT ?? 4175}`,
};

test.describe.configure({ mode: "serial" });

function actionLabel(profileName, actionId) {
  return (
    manifest.profiles[profileName].labelOverrides[actionId] ??
    manifest.actions[actionId].label
  );
}

function expectedTerminal(profileName, flowId) {
  const flow = manifest.flows[flowId];
  const expectation = manifest.profiles[profileName].expectations[flowId];
  return expectation.terminal ?? flow.baselineTerminal;
}

function expectedPath(terminal) {
  return manifest.stateContract.pathTemplates[terminal.stage].replace(
    ":outcome",
    terminal.outcome ?? "",
  );
}

async function jsonRequest(context, baseURL, pathname, options) {
  const response = await context.request.fetch(`${baseURL}${pathname}`, options);
  const contentType = response.headers()["content-type"] ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : null;
  return { body, response };
}

function unwrapSession(payload) {
  return payload?.session ?? payload;
}

function unwrapState(payload) {
  return payload?.state ?? payload?.session?.state ?? payload;
}

async function getSession(context, baseURL) {
  const { body, response } = await jsonRequest(
    context,
    baseURL,
    manifest.api.session,
  );
  expect(response.status()).toBe(200);
  return unwrapSession(body);
}

async function resetAndLogin(page, profileName) {
  const baseURL = fixtureURLs[profileName];
  const reset = await jsonRequest(
    page.context(),
    baseURL,
    manifest.api.qa.reset,
    { data: {} , method: "POST" },
  );
  expect(reset.response.ok()).toBeTruthy();

  await page.goto(baseURL);
  await page
    .getByLabel(manifest.ui.login.emailLabel, { exact: true })
    .fill(manifest.account.email);
  await page
    .getByLabel(manifest.ui.login.passwordLabel, { exact: true })
    .fill(manifest.account.password);
  await page
    .getByRole("button", {
      name: manifest.ui.login.submitLabel,
      exact: true,
    })
    .click();

  await expect.poll(async () => (await getSession(page.context(), baseURL)).authenticated)
    .toBe(true);
  const session = await getSession(page.context(), baseURL);
  expect(session.user.email).toBe(manifest.account.email);
  expect(session.profile).toBe(profileName);
  expect(session.state.stage).toBe("use-case");
  await expect(page).toHaveURL(
    `${baseURL}${manifest.stateContract.pathTemplates["use-case"]}`,
  );
  return baseURL;
}

async function clickAction(page, profileName, actionId) {
  const baseURL = fixtureURLs[profileName];
  const before = await getSession(page.context(), baseURL);
  const actionResponse = page.waitForResponse(
    (response) =>
      response.url() === `${baseURL}${manifest.api.action}` &&
      response.request().method() === "POST",
  );

  await page
    .getByRole("button", {
      name: actionLabel(profileName, actionId),
      exact: true,
    })
    .click();
  const response = await actionResponse;
  expect(response.status(), `${actionId} action response`).toBe(200);

  await expect
    .poll(async () => (await getSession(page.context(), baseURL)).state.path)
    .not.toBe(before.state.path);
}

async function runFlow(page, profileName, flowId) {
  const baseURL = await resetAndLogin(page, profileName);
  for (const actionId of manifest.flows[flowId].steps) {
    await clickAction(page, profileName, actionId);
  }

  const terminal = expectedTerminal(profileName, flowId);
  const session = await getSession(page.context(), baseURL);
  expect(session.state.stage).toBe(terminal.stage);
  expect(session.state.outcome).toBe(terminal.outcome);
  expect(session.state.path).toBe(expectedPath(terminal));
  await expect(page).toHaveURL(`${baseURL}${expectedPath(terminal)}`);

  const oracleResult = await jsonRequest(
    page.context(),
    baseURL,
    manifest.api.qa.state,
  );
  expect(oracleResult.response.status()).toBe(200);
  expect(unwrapState(oracleResult.body)).toEqual(session.state);
  return session.state;
}

for (const flowId of [
  "team-invite",
  "team-skip",
  "solo-starter",
  "solo-blank",
  "setup-later",
]) {
  test(`baseline UI completes ${flowId}`, async ({ page }) => {
    await runFlow(page, "baseline", flowId);
  });
}

test("the authenticated browser session survives a reload", async ({ page }) => {
  const baseURL = await resetAndLogin(page, "baseline");
  await clickAction(page, "baseline", "choose_solo");
  const beforeReload = await getSession(page.context(), baseURL);
  expect(beforeReload.state.stage).toBe("solo");

  await page.reload();
  await expect(page).toHaveURL(
    `${baseURL}${manifest.stateContract.pathTemplates.solo}`,
  );
  await expect(
    page.getByRole("button", {
      name: actionLabel("baseline", "choose_starter"),
      exact: true,
    }),
  ).toBeVisible();

  const afterReload = await getSession(page.context(), baseURL);
  expect(afterReload).toEqual(beforeReload);
});

test("regression keeps the renamed starter path green", async ({ page }) => {
  const baseURL = await resetAndLogin(page, "regression");
  await clickAction(page, "regression", "choose_solo");
  await expect(
    page.getByRole("button", { name: "Starter template", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Use a starter", exact: true }),
  ).toBeVisible();

  await clickAction(page, "regression", "choose_starter");
  const terminal = expectedTerminal("regression", "solo-starter");
  const session = await getSession(page.context(), baseURL);
  expect(session.state).toMatchObject(terminal);
  expect(manifest.profiles.regression.expectations["solo-starter"].note).toBe(
    "ui-changed",
  );
});

for (const flowId of ["solo-blank", "setup-later"]) {
  test(`regression sends ${flowId} to its declared error oracle`, async ({
    page,
  }) => {
    const state = await runFlow(page, "regression", flowId);
    expect(state.stage).toBe("error");
    expect(
      manifest.profiles.regression.expectations[flowId].failureReason,
    ).toBe("error-screen");
  });
}

test("the import control is absent at baseline and discoverable in discovery", async ({
  page,
}) => {
  await resetAndLogin(page, "baseline");
  await clickAction(page, "baseline", "choose_solo");
  await expect(
    page.getByRole("button", {
      name: manifest.actions.choose_import.label,
      exact: true,
    }),
  ).toHaveCount(0);

  const state = await runFlow(page, "discovery", "solo-import");
  expect(state.stage).toBe("done");
  expect(state.outcome).toBe("solo-import");
  expect(manifest.profiles.discovery.discoveries).toEqual(["choose_import"]);

  const eventsResult = await jsonRequest(
    page.context(),
    fixtureURLs.discovery,
    manifest.api.qa.events,
  );
  const events = eventsResult.body?.events ?? eventsResult.body;
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: "choose_import" }),
    ]),
  );
});
