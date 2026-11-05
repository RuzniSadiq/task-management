// HTTP API for tasks, on Node's built-in node:http. No framework.
//
// Routes:
//   POST  /tasks              {"title": string, "status"?: string} → 201 task
//   GET   /tasks              → 200 [task, ...] in creation order
//   GET   /tasks?status=S     → 200, only the tasks whose status is S (todo,
//                               in_progress or done); 400 if S is anything
//                               else (empty, wrong case) or given twice.
//   GET   /tasks?title=T      → 200, only the tasks whose title contains T as plain
//                               text, ignoring case (T is trimmed; no wildcards or
//                               regex); 400 if T is blank or given twice. Combines
//                               with status: both must match.
//                               Other query parameters are ignored.
//   PATCH /tasks/:id/status   {"status": string} → 200 task
//
// Every error response is application/json with body {"error": string}.
// Start with `node src/server.ts`; configure with TASKS_FILE, HOST, PORT.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { TaskStore } from "./store.ts";
import { NotFoundError, ValidationError } from "./tasks.ts";

/** Largest accepted request body, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

export const DEFAULT_TASKS_FILE = "data/tasks.json";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;

export interface ServerConfig {
  tasksFile: string;
  host: string;
  port: number;
}

/** A request that must be answered with `status` and {"error": message}. */
class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.headers = headers;
  }
}

/** Reads TASKS_FILE, HOST and PORT. Unset or empty values use the defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const tasksFile = env.TASKS_FILE === undefined || env.TASKS_FILE === "" ? DEFAULT_TASKS_FILE : env.TASKS_FILE;
  const host = env.HOST === undefined || env.HOST === "" ? DEFAULT_HOST : env.HOST;
  let port = DEFAULT_PORT;
  if (env.PORT !== undefined && env.PORT !== "") {
    if (!/^\d+$/.test(env.PORT) || Number(env.PORT) > 65535) {
      throw new Error(`PORT must be an integer from 0 to 65535, got: ${env.PORT}`);
    }
    port = Number(env.PORT);
  }
  return { tasksFile, host, port };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
  });
  response.end(payload);
}

/** Reads the whole body, refusing with 413 once it passes MAX_BODY_BYTES. */
function readBody(request: IncomingMessage): Promise<string> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
    return Promise.reject(tooLarge());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    request.on("data", (chunk: Buffer) => {
      if (done) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    request.on("error", (error) => {
      if (!done) {
        done = true;
        reject(error);
      }
    });
  });
}

function tooLarge(): HttpError {
  // The rest of the body is not read, so the connection cannot be reused.
  return new HttpError(413, `request body must be at most ${MAX_BODY_BYTES} bytes`, { connection: "close" });
}

/** Parses a JSON object body whose keys are all in `allowed`. */
async function readJsonObject(request: IncomingMessage, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const raw = await readBody(request);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  const record = data as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new HttpError(400, `unknown field: ${key}`);
    }
  }
  return record;
}

function methodNotAllowed(allowed: readonly string[]): HttpError {
  return new HttpError(405, `method not allowed; use ${allowed.join(", ")}`, { allow: allowed.join(", ") });
}

async function route(store: TaskStore, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "";
  const { pathname, searchParams } = new URL(request.url ?? "/", "http://localhost");
  const segments = pathname.split("/");

  if (pathname === "/tasks") {
    if (method === "GET") {
      // Which statuses are valid is the store's rule; only repetition is checked here.
      const statuses = searchParams.getAll("status");
      if (statuses.length > 1) {
        throw new HttpError(400, "status may be given at most once");
      }
      const titles = searchParams.getAll("title");
      if (titles.length > 1) {
        throw new HttpError(400, "title may be given at most once");
      }
      sendJson(response, 200, store.list(statuses[0], titles[0]));
      return;
    }
    if (method === "POST") {
      const body = await readJsonObject(request, ["title", "status"]);
      const task = await store.create({ title: body.title, status: body.status });
      sendJson(response, 201, task);
      return;
    }
    throw methodNotAllowed(["GET", "POST"]);
  }

  // ["", "tasks", ":id", "status"]
  if (segments.length === 4 && segments[1] === "tasks" && segments[2] !== "" && segments[3] === "status") {
    if (method !== "PATCH") {
      throw methodNotAllowed(["PATCH"]);
    }
    let id: string;
    try {
      id = decodeURIComponent(segments[2] ?? "");
    } catch {
      throw new HttpError(404, "task not found");
    }
    const body = await readJsonObject(request, ["status"]);
    if (!("status" in body)) {
      throw new HttpError(400, "status is required");
    }
    const task = await store.updateStatus(id, body.status);
    sendJson(response, 200, task);
    return;
  }

  throw new HttpError(404, `no route for ${pathname}`);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: error.message }, error.headers);
  } else if (error instanceof ValidationError) {
    sendJson(response, 400, { error: error.message });
  } else if (error instanceof NotFoundError) {
    sendJson(response, 404, { error: "task not found" });
  } else {
    console.error(error);
    sendJson(response, 500, { error: "internal server error" });
  }
}

/** Builds an HTTP server that serves `store`. It is not listening yet. */
export function createApp(store: TaskStore): Server {
  return createServer((request, response) => {
    route(store, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendError(response, error);
    });
  });
}

export interface RunningServer {
  server: Server;
  store: TaskStore;
  /** The address actually bound; port is the real port when 0 was asked for. */
  address: AddressInfo;
  /** Stops accepting connections, drops open ones, and resolves when closed. */
  close(): Promise<void>;
}

/** Opens the store and listens on exactly config.host:config.port. */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const store = await TaskStore.open(config.tasksFile);
  const server = createApp(store);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    store,
    address,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        server.closeAllConnections();
      }),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const running = await startServer(config);
  const { address, port } = running.address;
  const shown = address.includes(":") ? `[${address}]` : address;
  console.log(`Task API listening on http://${shown}:${port} (tasks file: ${config.tasksFile})`);
  const shutdown = (): void => {
    running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
