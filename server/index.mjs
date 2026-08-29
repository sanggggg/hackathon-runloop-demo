import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DomainError,
  SESSION_COOKIE,
  applyAction,
  featuresForProfile,
  login,
  logout,
  normalizeProfile,
  qaStateView,
  sessionView,
} from "./domain.mjs";
import { JsonStateStore } from "./store.mjs";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SERVER_DIR, "..");
const MAX_BODY_BYTES = 64 * 1024;

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function empty(res, status, headers = {}) {
  res.writeHead(status, { "cache-control": "no-store", ...headers });
  res.end();
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const rawValue = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
  }
  return cookies;
}

function sessionCookie(sessionId) {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new DomainError(413, "body_too_large", "Request body is too large.");
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new DomainError(400, "invalid_json", "Request body must be a JSON object.");
  }
}

function errorResponse(res, error) {
  if (error instanceof DomainError) {
    json(res, error.status, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }
  console.error(error);
  json(res, 500, {
    error: { code: "internal_error", message: "Internal server error." },
  });
}

async function readConfiguredProfile(repoRoot, env) {
  const explicit = env.QA_PROFILE?.trim() || env.QA_VARIANT?.trim();
  if (explicit) return normalizeProfile(explicit);

  const configPath = join(repoRoot, "fixture.config.json");
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    return normalizeProfile(config?.profile);
  } catch (error) {
    if (error?.code === "ENOENT") return "baseline";
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${configPath}`, { cause: error });
    }
    throw error;
  }
}

export async function resolveConfiguredProfile({
  repoRoot = REPO_ROOT,
  env = process.env,
} = {}) {
  return readConfiguredProfile(repoRoot, env);
}

async function handleApi(req, res, context) {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;
  const { store, profile } = context;
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];

  if (req.method === "POST" && pathname === "/api/login") {
    const body = await readJsonBody(req);
    const { result } = await store.update((root) => login(root, body));
    json(
      res,
      200,
      {
        ok: true,
        authenticated: true,
        profile,
        user: result.user,
        state: result.state,
        features: featuresForProfile(profile),
        event: result.event,
        navigateTo: result.state.path,
      },
      { "set-cookie": sessionCookie(result.sessionId) },
    );
    return true;
  }

  if (req.method === "GET" && pathname === "/api/session") {
    const root = await store.read();
    json(res, 200, sessionView(root, sessionId));
    return true;
  }

  if (req.method === "POST" && pathname === "/api/action") {
    const body = await readJsonBody(req);
    const { result } = await store.update((root) =>
      applyAction(root, sessionId, body),
    );
    json(res, 200, {
      ok: true,
      profile,
      state: result.state,
      event: result.event,
      navigateTo: result.state.path,
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const { result } = await store.update((root) => logout(root, sessionId));
    empty(res, 204, { "set-cookie": clearSessionCookie() });
    return true;
  }

  if (req.method === "GET" && pathname === "/__qa/health") {
    json(res, 200, {
      ok: true,
      ready: true,
      app: "nimbus",
      profile,
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/__qa/reset") {
    const root = await store.reset();
    json(
      res,
      200,
      { ok: true, ...qaStateView(root) },
      { "set-cookie": clearSessionCookie() },
    );
    return true;
  }

  if (req.method === "GET" && pathname === "/__qa/state") {
    const root = await store.read();
    json(res, 200, qaStateView(root));
    return true;
  }

  if (req.method === "GET" && pathname === "/__qa/events") {
    const root = await store.read();
    json(res, 200, { profile, events: root.events });
    return true;
  }

  if (
    pathname.startsWith("/api/") ||
    pathname === "/api" ||
    pathname.startsWith("/__qa/") ||
    pathname === "/__qa"
  ) {
    json(res, 404, {
      error: { code: "not_found", message: "API route not found." },
    });
    return true;
  }

  return false;
}

function safeStaticPath(distRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new DomainError(400, "invalid_path", "Malformed URL path.");
  }
  if (decoded.includes("\0")) {
    throw new DomainError(400, "invalid_path", "Malformed URL path.");
  }
  const candidate = resolve(distRoot, `.${decoded === "/" ? "/index.html" : decoded}`);
  const prefix = distRoot.endsWith(sep) ? distRoot : `${distRoot}${sep}`;
  if (candidate !== distRoot && !candidate.startsWith(prefix)) {
    throw new DomainError(400, "invalid_path", "Path escapes the public directory.");
  }
  return candidate;
}

async function serveFile(req, res, filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) return false;
  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "cache-control": "no-cache",
    "content-length": info.size,
    "content-type": contentType,
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(filePath).pipe(res);
  return true;
}

async function serveProduction(req, res, distRoot) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, {
      error: { code: "method_not_allowed", message: "Method not allowed." },
    });
    return;
  }

  const pathname = new URL(req.url, "http://localhost").pathname;
  const requested = safeStaticPath(distRoot, pathname);
  try {
    if (await serveFile(req, res, requested)) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const fallback = join(distRoot, "index.html");
  try {
    if (await serveFile(req, res, fallback)) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  json(res, 503, {
    error: {
      code: "frontend_not_built",
      message: "Production assets are missing. Run npm run build first.",
    },
  });
}

export async function createApplication(options = {}) {
  const repoRoot = resolve(options.repoRoot || REPO_ROOT);
  const env = options.env || process.env;
  const profile = normalizeProfile(
    options.profile || (await resolveConfiguredProfile({ repoRoot, env })),
  );
  const configuredStatePath =
    options.stateFile ||
    env.QA_STATE_FILE ||
    (env.QA_STATE_DIR ? join(env.QA_STATE_DIR, "state.json") : join(repoRoot, "var", "state.json"));
  const stateFile = isAbsolute(configuredStatePath)
    ? configuredStatePath
    : resolve(repoRoot, configuredStatePath);
  const store = options.store || new JsonStateStore({ filePath: stateFile, profile });
  await store.init();

  const development = options.development ?? env.NODE_ENV === "development";
  let vite = null;
  if (development && !options.disableVite) {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({
      root: repoRoot,
      appType: "spa",
      server: { middlewareMode: true },
    });
  }

  const distRoot = resolve(repoRoot, options.distDir || "dist");
  const server = createServer(async (req, res) => {
    try {
      if (await handleApi(req, res, { store, profile })) return;
      if (vite) {
        await new Promise((resolveMiddleware, rejectMiddleware) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolveMiddleware();
          };
          res.once("finish", finish);
          res.once("close", finish);
          vite.middlewares(req, res, (error) => {
            if (settled) return;
            settled = true;
            res.off("finish", finish);
            res.off("close", finish);
            if (error) rejectMiddleware(error);
            else resolveMiddleware();
          });
        });
        if (!res.writableEnded && !res.headersSent) {
          json(res, 404, {
            error: { code: "not_found", message: "Page not found." },
          });
        }
        return;
      }
      await serveProduction(req, res, distRoot);
    } catch (error) {
      if (!res.headersSent) errorResponse(res, error);
      else res.destroy(error);
    }
  });

  return {
    server,
    store,
    profile,
    stateFile,
    async close() {
      await new Promise((resolveClose, rejectClose) => {
        if (!server.listening) return resolveClose();
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
      await vite?.close();
    },
  };
}

export async function start(options = {}) {
  const app = await createApplication(options);
  const env = options.env || process.env;
  const port = Number.parseInt(options.port ?? env.PORT ?? "3000", 10);
  const host = options.host || env.HOST || "0.0.0.0";
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${options.port ?? env.PORT}`);
  }
  await new Promise((resolveListen, rejectListen) => {
    app.server.once("error", rejectListen);
    app.server.listen(port, host, () => {
      app.server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = app.server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(
    `Nimbus QA fixture listening on http://${host}:${listeningPort} (${app.profile})`,
  );
  return app;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const app = await start();
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
