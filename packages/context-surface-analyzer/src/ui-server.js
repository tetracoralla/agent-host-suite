#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LIMITS } from "./constants.js";
import { executeAnalyze, executeDiff } from "./core.js";
import { boundedErrorResult, ContextSurfaceError } from "./errors.js";

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/app-logic.js", ["app-logic.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
]);
const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

async function readJsonBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > LIMITS.maxHttpBodyBytes) {
      throw new ContextSurfaceError("LIMIT_EXCEEDED", "Request body exceeds the HTTP byte limit.", {
        actual: bytes,
        limit: LIMITS.maxHttpBodyBytes
      });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ContextSurfaceError("INVALID_JSON", "Request body is not valid JSON.");
  }
}

function assertBody(body, allowed, required) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ContextSurfaceError("INVALID_ARGUMENT", "Request body must be an object.");
  }
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ContextSurfaceError("UNKNOWN_FIELD", "Request body contains unsupported fields.", { fieldCount: unknown.length });
  }
  const missing = required.filter((key) => !(key in body));
  if (missing.length > 0) {
    throw new ContextSurfaceError("INVALID_ARGUMENT", "Request body is missing required fields.", { fields: missing });
  }
}

async function handleApi(request, response, pathname) {
  let failureLimit = LIMITS.defaultResultBytes;
  try {
    const body = await readJsonBody(request);
    if (
      Number.isSafeInteger(body?.maxOutputBytes) &&
      body.maxOutputBytes >= LIMITS.minResultBytes &&
      body.maxOutputBytes <= LIMITS.hardMaxResultBytes
    ) {
      failureLimit = body.maxOutputBytes;
    }
    if (pathname === "/api/analyze") {
      assertBody(body, ["snapshotJson", "maxOutputBytes"], ["snapshotJson"]);
      return sendJson(response, 200, executeAnalyze(body.snapshotJson, body.maxOutputBytes).result);
    }
    assertBody(body, ["beforeSnapshotJson", "afterSnapshotJson", "maxOutputBytes"], ["beforeSnapshotJson", "afterSnapshotJson"]);
    return sendJson(
      response,
      200,
      executeDiff(body.beforeSnapshotJson, body.afterSnapshotJson, body.maxOutputBytes).result
    );
  } catch (error) {
    return sendJson(response, 400, boundedErrorResult(error, failureLimit));
  }
}

export function createUiServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST" && (url.pathname === "/api/analyze" || url.pathname === "/api/diff")) {
      return handleApi(request, response, url.pathname);
    }
    if (request.method !== "GET" || !STATIC_FILES.has(url.pathname)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const [file, contentType] = STATIC_FILES.get(url.pathname);
    const body = await readFile(`${WEB_ROOT}/${file}`);
    response.writeHead(200, { "content-type": contentType, "content-length": body.byteLength });
    response.end(body);
  });
}

function parsePort(argv) {
  const index = argv.indexOf("--port");
  if (index === -1) return 4173;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ContextSurfaceError("INVALID_ARGUMENT", "--port must be an integer from 0 through 65535.");
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = parsePort(process.argv.slice(2));
  const server = createUiServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    process.stdout.write(`${JSON.stringify({ status: "ready", url: `http://127.0.0.1:${address.port}` })}\n`);
  });
}
