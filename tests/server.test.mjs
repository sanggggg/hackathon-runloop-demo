import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(ROOT, "qa", "manifest.json"), "utf8"),
);

async function reservePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHealth(baseURL, processLog, child) {
  const deadline = Date.now() + 15_000;
  let lastError;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `fixture server exited with ${child.exitCode}\n${processLog.join("")}`,
      );
    }

    try {
      const response = await fetch(
        `${baseURL}${manifest.api.qa.health}`,
        { signal: AbortSignal.timeout(1_000) },
      );
      if (response.ok) return;
      lastError = new Error(`health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }

  throw new Error(
    `fixture server did not become healthy: ${lastError?.message ?? "timeout"}\n${processLog.join("")}`,
  );
}

async function startFixture(profile, options = {}) {
  const port = options.port ?? (await reservePort());
  const stateDirectory =
    options.stateDirectory ??
    (await mkdtemp(path.join(tmpdir(), "nimbus-qa-state-")));
  const ownsStateDirectory = options.stateDirectory === undefined;
  const processLog = [];
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "test",
      QA_PROFILE: profile,
      QA_STATE_DIR: stateDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => processLog.push(chunk.toString()));
  child.stderr.on("data", (chunk) => processLog.push(chunk.toString()));

  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseURL, processLog, child);
  } catch (error) {
    child.kill("SIGTERM");
    if (ownsStateDirectory) {
      await rm(stateDirectory, { recursive: true, force: true });
    }
    throw error;
  }

  return {
    baseURL,
    port,
    processLog,
    profile,
    stateDirectory,
    async stop({ preserveState = false } = {}) {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      if (ownsStateDirectory && !preserveState) {
        await rm(stateDirectory, { recursive: true, force: true });
      }
    },
  };
}

async function withFixture(profile, callback) {
  const fixture = await startFixture(profile);
  try {
    return await callback(fixture);
  } finally {
    await fixture.stop();
  }
}

function createClient(baseURL, initialCookies = {}) {
  const cookies = new Map(Object.entries(initialCookies));
  let origin = baseURL;

  return {
    cookies,
    setBaseURL(nextBaseURL) {
      origin = nextBaseURL;
    },
    async request(pathname, { body, headers, method = "GET" } = {}) {
      const requestHeaders = new Headers(headers);
      if (body !== undefined) requestHeaders.set("content-type", "application/json");
      if (cookies.size > 0) {
        requestHeaders.set(
          "cookie",
          [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        );
      }

      const response = await fetch(`${origin}${pathname}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: requestHeaders,
        method,
        redirect: "manual",
      });

      const setCookies =
        response.headers.getSetCookie?.() ??
        (response.headers.get("set-cookie")
          ? [response.headers.get("set-cookie")]
          : []);
      for (const setCookie of setCookies) {
        const [pair] = setCookie.split(";", 1);
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        if (value) cookies.set(name, value);
        else cookies.delete(name);
      }

      const text = await response.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(
            `${method} ${pathname} returned non-JSON HTTP ${response.status}: ${text.slice(0, 200)}`,
          );
        }
      }
      return { json, response };
    },
  };
}

function unwrapSession(payload) {
  return payload?.session ?? payload;
}

function unwrapState(payload) {
  return payload?.state ?? payload?.session?.state ?? payload;
}

function unwrapEvents(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.events ?? [];
}

function errorCode(payload) {
  return payload?.error?.code ?? payload?.code ?? payload?.error;
}

function expectedTerminal(profileName, flowId) {
  const flow = manifest.flows[flowId];
  const expectation = manifest.profiles[profileName].expectations[flowId];
  return expectation.terminal ?? flow.baselineTerminal;
}

function assertPublicState(actual, expected, message = "public state") {
  assert.equal(actual.stage, expected.stage, `${message}: stage`);
  assert.equal(actual.outcome, expected.outcome, `${message}: outcome`);
  assert.equal(typeof actual.path, "string", `${message}: path is a string`);
  assert.match(actual.path, /^\//, `${message}: path is absolute`);
  const template = manifest.stateContract.pathTemplates[expected.stage];
  const expectedPath = template.replace(":outcome", expected.outcome ?? "");
  assert.equal(actual.path, expectedPath, `${message}: canonical path`);
}

async function reset(client) {
  const { response } = await client.request(manifest.api.qa.reset, {
    body: {},
    method: "POST",
  });
  assert.ok(response.ok, `reset returned HTTP ${response.status}`);
}

async function login(client) {
  const { json, response } = await client.request(manifest.api.login, {
    body: manifest.account,
    method: "POST",
  });
  assert.equal(response.status, 200, JSON.stringify(json));
  const session = unwrapSession(json);
  assert.equal(session.authenticated, true);
  assert.equal(session.user.email, manifest.account.email);
  assert.equal(session.state.stage, "use-case");
  return session;
}

async function performAction(client, action) {
  const { json, response } = await client.request(manifest.api.action, {
    body: { action },
    method: "POST",
  });
  assert.equal(response.status, 200, `${action}: ${JSON.stringify(json)}`);
  assert.ok(json.event, `${action}: event is present`);
  assert.equal(typeof json.navigateTo, "string", `${action}: navigateTo`);
  assert.deepEqual(json.state.path, json.navigateTo, `${action}: state.path`);
  return json.state;
}

async function runFlow(client, flowId) {
  const flow = manifest.flows[flowId];
  let state;
  for (const action of flow.steps) state = await performAction(client, action);
  return state;
}

test("manifest has a complete and internally consistent contract", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.account.email, "demo@example.com");
  assert.equal(manifest.account.password, "branchpoint");

  const knownStages = new Set(manifest.stateContract.stages);
  for (const [actionId, action] of Object.entries(manifest.actions)) {
    assert.ok(knownStages.has(action.fromStage), `${actionId}.fromStage`);
    assert.ok(knownStages.has(action.toStage), `${actionId}.toStage`);
    assert.ok(action.label, `${actionId}.label`);
  }

  for (const [flowId, flow] of Object.entries(manifest.flows)) {
    assert.ok(flow.steps.length > 0, `${flowId} has steps`);
    for (const action of flow.steps) {
      assert.ok(manifest.actions[action], `${flowId} references ${action}`);
    }
    assert.ok(
      manifest.stateContract.terminalStages.includes(flow.baselineTerminal.stage),
      `${flowId} has a terminal baseline stage`,
    );
  }

  for (const [profileName, profile] of Object.entries(manifest.profiles)) {
    for (const action of profile.visibleActions) {
      assert.ok(manifest.actions[action], `${profileName} exposes ${action}`);
    }
    for (const flowId of Object.keys(profile.expectations)) {
      assert.ok(manifest.flows[flowId], `${profileName} expects ${flowId}`);
    }
  }
});

test("authentication, persisted sessions, and the QA oracle agree", async () => {
  const first = await startFixture("baseline");
  const client = createClient(first.baseURL);
  const stateDirectory = first.stateDirectory;

  try {
    await reset(client);

    const anonymous = unwrapSession(
      (await client.request(manifest.api.session)).json,
    );
    assert.equal(anonymous.authenticated, false);

    const rejected = await client.request(manifest.api.login, {
      body: { ...manifest.account, password: "not-the-password" },
      method: "POST",
    });
    assert.ok([401, 403].includes(rejected.response.status));

    await login(client);
    const state = await performAction(client, "choose_solo");
    assert.equal(state.stage, "solo");

    const sessionBeforeRestart = unwrapSession(
      (await client.request(manifest.api.session)).json,
    );
    assert.equal(sessionBeforeRestart.authenticated, true);
    assert.deepEqual(sessionBeforeRestart.state, state);

    const oracleBeforeRestart = unwrapState(
      (await client.request(manifest.api.qa.state)).json,
    );
    assert.deepEqual(oracleBeforeRestart, state);

    const events = unwrapEvents(
      (await client.request(manifest.api.qa.events)).json,
    );
    assert.ok(events.length >= 2, "login and action are recorded");

    await first.stop({ preserveState: true });
    const second = await startFixture("baseline", { stateDirectory });
    try {
      client.setBaseURL(second.baseURL);
      const restored = unwrapSession(
        (await client.request(manifest.api.session)).json,
      );
      assert.equal(restored.authenticated, true);
      assert.deepEqual(restored.state, state);

      await reset(client);
      const cleared = unwrapSession(
        (await client.request(manifest.api.session)).json,
      );
      assert.equal(cleared.authenticated, false);
    } finally {
      await second.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  } catch (error) {
    await first.stop();
    throw error;
  }
});

test("baseline completes every advertised path with the manifest oracle", async () => {
  await withFixture("baseline", async ({ baseURL }) => {
    const client = createClient(baseURL);
    const profile = manifest.profiles.baseline;

    for (const [flowId, expectation] of Object.entries(profile.expectations)) {
      await reset(client);
      await login(client);

      if (expectation.status === "unavailable") {
        await performAction(client, "choose_solo");
        const action = manifest.flows[flowId].steps.at(-1);
        const result = await client.request(manifest.api.action, {
          body: { action },
          method: "POST",
        });
        assert.equal(result.response.status, expectation.httpStatus);
        assert.equal(errorCode(result.json), expectation.error);
        continue;
      }

      const state = await runFlow(client, flowId);
      assertPublicState(state, expectedTerminal("baseline", flowId), flowId);

      const session = unwrapSession(
        (await client.request(manifest.api.session)).json,
      );
      assert.deepEqual(session.state, state, `${flowId}: session oracle`);
      const qaState = unwrapState(
        (await client.request(manifest.api.qa.state)).json,
      );
      assert.deepEqual(qaState, state, `${flowId}: QA oracle`);
    }
  });
});

test("regression exposes the intended rename and two exact failures", async () => {
  await withFixture("regression", async ({ baseURL }) => {
    const client = createClient(baseURL);
    const profile = manifest.profiles.regression;

    const health = (await client.request(manifest.api.qa.health)).json;
    assert.equal(health.profile, "regression");
    assert.equal(profile.labelOverrides.choose_starter, "Use a starter");

    for (const flowId of ["solo-starter", "solo-blank", "setup-later"]) {
      await reset(client);
      await login(client);
      const state = await runFlow(client, flowId);
      assertPublicState(state, expectedTerminal("regression", flowId), flowId);
    }

    assert.equal(profile.expectations["solo-starter"].note, "ui-changed");
    assert.equal(
      profile.expectations["solo-blank"].failureReason,
      "error-screen",
    );
    assert.equal(
      profile.expectations["setup-later"].failureReason,
      "error-screen",
    );
  });
});

test("discovery adds one usable action without changing baseline outcomes", async () => {
  await withFixture("discovery", async ({ baseURL }) => {
    const client = createClient(baseURL);
    const profile = manifest.profiles.discovery;
    assert.deepEqual(profile.discoveries, ["choose_import"]);

    await reset(client);
    await login(client);
    const state = await runFlow(client, "solo-import");
    assertPublicState(
      state,
      expectedTerminal("discovery", "solo-import"),
      "solo-import",
    );

    const events = unwrapEvents(
      (await client.request(manifest.api.qa.events)).json,
    );
    assert.ok(
      events.some(
        (event) =>
          event.action === "choose_import" || event.actionId === "choose_import",
      ),
      "the oracle records the discovered action",
    );
  });
});

test("fault profiles model unresolved and timeout outcomes deterministically", async () => {
  await withFixture("removed-control", async ({ baseURL }) => {
    const client = createClient(baseURL);
    await reset(client);
    await login(client);
    await performAction(client, "choose_solo");
    const expectation =
      manifest.profiles["removed-control"].expectations["solo-starter"];
    const result = await client.request(manifest.api.action, {
      body: { action: "choose_starter" },
      method: "POST",
    });
    assert.equal(result.response.status, expectation.httpStatus);
    assert.equal(errorCode(result.json), expectation.error);
  });

  await withFixture("timeout", async ({ baseURL }) => {
    const client = createClient(baseURL);
    await reset(client);
    await login(client);
    const state = await runFlow(client, "setup-later");
    assertPublicState(
      state,
      expectedTerminal("timeout", "setup-later"),
      "timeout",
    );
  });
});
