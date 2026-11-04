import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TASKS_FILE,
  MAX_BODY_BYTES,
  loadConfig,
  startServer,
  type RunningServer,
} from "../src/server.ts";
import { isIsoUtcTimestamp, isUuid, type Task } from "../src/tasks.ts";

let root: string;
let counter = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "task-server-test-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A path to a tasks file in a fresh, empty directory. */
async function freshTasksFile(): Promise<string> {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  await mkdir(dir, { recursive: true });
  return join(dir, "tasks.json");
}

async function start(tasksFile?: string): Promise<{ running: RunningServer; base: string }> {
  const running = await startServer({ tasksFile: tasksFile ?? (await freshTasksFile()), host: "127.0.0.1", port: 0 });
  return { running, base: `http://127.0.0.1:${running.address.port}` };
}

/** Starts a server on a fresh file, runs `body`, and always stops the server. */
async function withServer(body: (base: string, running: RunningServer) => Promise<void>): Promise<void> {
  const { running, base } = await start();
  try {
    await body(base, running);
  } finally {
    await running.close();
  }
}

function postJson(base: string, path: string, body: unknown, method = "POST"): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function createTask(base: string, body: unknown): Promise<Task> {
  const response = await postJson(base, "/tasks", body);
  assert.equal(response.status, 201);
  return (await response.json()) as Task;
}

/** Asserts an error response: status, application/json, body exactly {"error": string}. */
async function assertError(response: Response, status: number): Promise<string> {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
  assert.ok((body.error as string).length > 0);
  return body.error as string;
}

/** Sends a request with node:http so the body can be streamed without Content-Length. */
function rawRequest(
  base: string,
  options: { method: string; path: string; headers?: Record<string, string>; chunks: Buffer[] },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${options.path}`, { method: options.method, headers: options.headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString("utf8") });
      });
      res.on("error", reject);
    });
    // The server may answer 413 and close before the whole body is sent.
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") {
        reject(error);
      }
    });
    for (const chunk of options.chunks) {
      req.write(chunk);
    }
    req.end();
  });
}

describe("AC1 POST /tasks", () => {
  test("creates a task: 201 and the task JSON", async () => {
    await withServer(async (base) => {
      const response = await postJson(base, "/tasks", { title: "  Buy milk  " });
      assert.equal(response.status, 201);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
      const task = (await response.json()) as Task;
      assert.deepEqual(Object.keys(task).sort(), ["createdAt", "id", "status", "title", "updatedAt"]);
      assert.ok(isUuid(task.id));
      assert.equal(task.title, "Buy milk");
      assert.equal(task.status, "todo");
      assert.ok(isIsoUtcTimestamp(task.createdAt));
      assert.equal(task.createdAt, task.updatedAt);
    });
  });

  test("accepts an optional valid status", async () => {
    await withServer(async (base) => {
      const task = await createTask(base, { title: "Write report", status: "in_progress" });
      assert.equal(task.status, "in_progress");
    });
  });
});

describe("AC2 GET /tasks", () => {
  test("an empty store returns 200 and []", async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/tasks`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
      assert.deepEqual(await response.json(), []);
    });
  });

  test("returns every task in creation order", async () => {
    await withServer(async (base) => {
      const created: Task[] = [];
      for (const title of ["first", "second", "third"]) {
        created.push(await createTask(base, { title }));
      }
      const response = await fetch(`${base}/tasks`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), created);
    });
  });

  test("a query string does not change the route", async () => {
    await withServer(async (base) => {
      const task = await createTask(base, { title: "only" });
      const response = await fetch(`${base}/tasks?x=1`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), [task]);
    });
  });
});

describe("AC3 PATCH /tasks/:id/status", () => {
  test("returns 200 and the updated task; the list shows the change", async () => {
    await withServer(async (base) => {
      const task = await createTask(base, { title: "Ship it" });
      const other = await createTask(base, { title: "Untouched" });
      const response = await postJson(base, `/tasks/${task.id}/status`, { status: "done" }, "PATCH");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
      const updated = (await response.json()) as Task;
      assert.equal(updated.id, task.id);
      assert.equal(updated.title, task.title);
      assert.equal(updated.createdAt, task.createdAt);
      assert.equal(updated.status, "done");
      assert.ok(isIsoUtcTimestamp(updated.updatedAt));
      assert.ok(updated.updatedAt >= task.updatedAt);
      const list = (await (await fetch(`${base}/tasks`)).json()) as Task[];
      assert.deepEqual(list, [updated, other]);
    });
  });
});

describe("AC4 errors", () => {
  test("400 for invalid JSON on POST and PATCH", async () => {
    await withServer(async (base) => {
      await assertError(await postJson(base, "/tasks", "{not json"), 400);
      await assertError(await postJson(base, "/tasks", ""), 400);
      const task = await createTask(base, { title: "t" });
      await assertError(await postJson(base, `/tasks/${task.id}/status`, "{", "PATCH"), 400);
    });
  });

  const nonObjects: [string, string][] = [
    ["array", "[]"],
    ["null", "null"],
    ["number", "42"],
    ["string", '"title"'],
    ["boolean", "true"],
  ];
  for (const [label, raw] of nonObjects) {
    test(`400 for a non-object body (${label}) on POST and PATCH`, async () => {
      await withServer(async (base) => {
        await assertError(await postJson(base, "/tasks", raw), 400);
        const task = await createTask(base, { title: "t" });
        await assertError(await postJson(base, `/tasks/${task.id}/status`, raw, "PATCH"), 400);
      });
    });
  }

  const badCreates: [string, unknown][] = [
    ["missing title", {}],
    ["non-string title", { title: 5 }],
    ["blank title", { title: "   " }],
    ["title over 200 characters", { title: "x".repeat(201) }],
    ["invalid status", { title: "ok", status: "finished" }],
    ["null status", { title: "ok", status: null }],
    ["unknown field", { title: "ok", priority: "high" }],
  ];
  for (const [label, body] of badCreates) {
    test(`POST /tasks 400 for ${label}, nothing created`, async () => {
      await withServer(async (base) => {
        await assertError(await postJson(base, "/tasks", body), 400);
        assert.deepEqual(await (await fetch(`${base}/tasks`)).json(), []);
      });
    });
  }

  const badPatches: [string, unknown][] = [
    ["missing status", {}],
    ["invalid status", { status: "finished" }],
    ["non-string status", { status: 1 }],
    ["unknown field", { status: "done", title: "renamed" }],
  ];
  for (const [label, body] of badPatches) {
    test(`PATCH status 400 for ${label}, task unchanged`, async () => {
      await withServer(async (base) => {
        const task = await createTask(base, { title: "t" });
        await assertError(await postJson(base, `/tasks/${task.id}/status`, body, "PATCH"), 400);
        assert.deepEqual(await (await fetch(`${base}/tasks`)).json(), [task]);
      });
    });
  }

  test("404 for an unknown task id", async () => {
    await withServer(async (base) => {
      const missing = "00000000-0000-4000-8000-000000000000";
      await assertError(await postJson(base, `/tasks/${missing}/status`, { status: "done" }, "PATCH"), 404);
      await assertError(await postJson(base, "/tasks/not-a-uuid/status", { status: "done" }, "PATCH"), 404);
      await assertError(await postJson(base, "/tasks/%E0%A4%A/status", { status: "done" }, "PATCH"), 404);
    });
  });

  const unknownRoutes = ["/", "/task", "/tasks/", "/tasks/abc", "/tasks//status", "/tasks/abc/status/extra", "/other"];
  for (const path of unknownRoutes) {
    test(`404 for unknown route ${path}`, async () => {
      await withServer(async (base) => {
        await assertError(await fetch(`${base}${path}`), 404);
        await assertError(await postJson(base, path, { title: "x" }), 404);
      });
    });
  }

  const wrongMethods: [string, string, string][] = [
    ["PUT", "/tasks", "GET, POST"],
    ["DELETE", "/tasks", "GET, POST"],
    ["PATCH", "/tasks", "GET, POST"],
    ["GET", "/tasks/abc/status", "PATCH"],
    ["POST", "/tasks/abc/status", "PATCH"],
    ["PUT", "/tasks/abc/status", "PATCH"],
  ];
  for (const [method, path, allow] of wrongMethods) {
    test(`405 for ${method} ${path} with Allow: ${allow}`, async () => {
      await withServer(async (base) => {
        const response = await fetch(`${base}${path}`, { method });
        assert.equal(response.headers.get("allow"), allow);
        await assertError(response, 405);
      });
    });
  }

  test("a body of exactly 64 KiB is read (not 413)", async () => {
    await withServer(async (base) => {
      const prefix = '{"title":"ok","status":"todo"}';
      const body = prefix + " ".repeat(MAX_BODY_BYTES - prefix.length);
      assert.equal(Buffer.byteLength(body), MAX_BODY_BYTES);
      const response = await postJson(base, "/tasks", body);
      assert.equal(response.status, 201);
    });
  });

  test("413 for a body over 64 KiB with Content-Length; nothing created", async () => {
    await withServer(async (base) => {
      const body = JSON.stringify({ title: "x".repeat(MAX_BODY_BYTES) });
      await assertError(await postJson(base, "/tasks", body), 413);
      assert.deepEqual(await (await fetch(`${base}/tasks`)).json(), []);
    });
  });

  test("413 for a chunked body over 64 KiB (no Content-Length)", async () => {
    await withServer(async (base) => {
      const chunks = [Buffer.from('{"title":"'), Buffer.alloc(MAX_BODY_BYTES, "x"), Buffer.from('"}')];
      const result = await rawRequest(base, {
        method: "POST",
        path: "/tasks",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        chunks,
      });
      assert.equal(result.status, 413);
      assert.match(String(result.headers["content-type"]), /^application\/json\b/);
      const parsed = JSON.parse(result.body) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed), ["error"]);
      assert.equal(typeof parsed.error, "string");
      assert.deepEqual(await (await fetch(`${base}/tasks`)).json(), []);
    });
  });

  test("413 on PATCH status for a body over 64 KiB", async () => {
    await withServer(async (base) => {
      const task = await createTask(base, { title: "t" });
      const body = JSON.stringify({ status: "done", pad: "x".repeat(MAX_BODY_BYTES) });
      await assertError(await postJson(base, `/tasks/${task.id}/status`, body, "PATCH"), 413);
      assert.deepEqual(await (await fetch(`${base}/tasks`)).json(), [task]);
    });
  });

  test("500 is JSON when the store cannot write", async () => {
    // After the store opens, its parent directory path becomes a regular file,
    // so the first write fails.
    const blocker = await freshTasksFile();
    const { running, base } = await start(join(blocker, "tasks.json"));
    await writeFile(blocker, "not a directory");
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await assertError(await postJson(base, "/tasks", { title: "t" }), 500);
    } finally {
      console.error = originalError;
      await running.close();
    }
  });
});

describe("AC5 configuration and binding", () => {
  test("defaults: TASKS_FILE data/tasks.json, HOST 127.0.0.1, PORT 3000", () => {
    assert.deepEqual(loadConfig({}), { tasksFile: "data/tasks.json", host: "127.0.0.1", port: 3000 });
    assert.equal(DEFAULT_TASKS_FILE, "data/tasks.json");
    assert.equal(DEFAULT_HOST, "127.0.0.1");
    assert.equal(DEFAULT_PORT, 3000);
    assert.deepEqual(loadConfig({ TASKS_FILE: "", HOST: "", PORT: "" }), loadConfig({}));
  });

  test("reads TASKS_FILE, HOST and PORT from the environment", () => {
    assert.deepEqual(loadConfig({ TASKS_FILE: "/tmp/t.json", HOST: "0.0.0.0", PORT: "8080" }), {
      tasksFile: "/tmp/t.json",
      host: "0.0.0.0",
      port: 8080,
    });
    assert.equal(loadConfig({ PORT: "0" }).port, 0);
    assert.equal(loadConfig({ PORT: "65535" }).port, 65535);
  });

  for (const bad of ["abc", "-1", "65536", "3.5", " 80", "1e3"]) {
    test(`rejects PORT=${JSON.stringify(bad)}`, () => {
      assert.throws(() => loadConfig({ PORT: bad }), /PORT must be an integer/);
    });
  }

  test("binds exactly the configured host and port", async () => {
    const probe = await start();
    const freePort = probe.running.address.port;
    await probe.running.close();
    const running = await startServer({ tasksFile: await freshTasksFile(), host: "127.0.0.1", port: freePort });
    try {
      assert.equal(running.address.address, "127.0.0.1");
      assert.equal(running.address.family, "IPv4");
      assert.equal(running.address.port, freePort);
      assert.deepEqual(running.server.address(), running.address);
    } finally {
      await running.close();
    }
  });

  test("`node src/server.ts` starts from the environment and serves requests", async () => {
    const tasksFile = await freshTasksFile();
    const child = spawn(process.execPath, ["src/server.ts"], {
      env: { ...process.env, TASKS_FILE: tasksFile, HOST: "127.0.0.1", PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
          if (out.includes("\n")) {
            resolve(out);
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          err += chunk.toString("utf8");
        });
        child.once("exit", (code) => {
          reject(new Error(`server exited early with code ${String(code)}: ${err}`));
        });
      });
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
      assert.ok(match, `listening line: ${line}`);
      const base = `http://127.0.0.1:${match[1] ?? ""}`;
      const task = await createTask(base, { title: "from the CLI" });
      assert.deepEqual(await (await fetch(`${base}/tasks`)).json(), [task]);
      const stored = JSON.parse(await readFile(tasksFile, "utf8")) as { tasks: Task[] };
      assert.deepEqual(stored.tasks, [task]);
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      assert.equal(await exited, 0);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  test("`node src/server.ts` exits non-zero on an invalid PORT", async () => {
    const child = spawn(process.execPath, ["src/server.ts"], {
      env: { ...process.env, TASKS_FILE: await freshTasksFile(), HOST: "127.0.0.1", PORT: "nope" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 1);
    assert.match(err, /PORT must be an integer/);
  });
});

describe("AC6 persistence across server restart", () => {
  test("create, stop the server, start a new server on the same file, list", async () => {
    const tasksFile = await freshTasksFile();
    const first = await start(tasksFile);
    let created: Task[];
    try {
      const a = await createTask(first.base, { title: "persist me" });
      const b = await createTask(first.base, { title: "and me", status: "in_progress" });
      const response = await postJson(first.base, `/tasks/${a.id}/status`, { status: "done" }, "PATCH");
      assert.equal(response.status, 200);
      created = [(await response.json()) as Task, b];
    } finally {
      await first.running.close();
    }
    const second = await start(tasksFile);
    try {
      const response = await fetch(`${second.base}/tasks`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), created);
    } finally {
      await second.running.close();
    }
  });
});

// Test-engineer sensors: boundaries and adversarial inputs for AC2, AC4, AC5, AC6.
describe("test-engineer: boundary and adversarial sensors", () => {
  /** A valid create body padded with spaces to exactly `bytes` bytes. */
  function paddedCreateBody(bytes: number): string {
    const prefix = '{"title":"ok","status":"todo"}';
    return prefix + " ".repeat(bytes - prefix.length);
  }

  test("AC4 413 for a body of exactly 64 KiB + 1 byte with Content-Length; nothing created", async () => {
    await withServer(async (base) => {
      const body = paddedCreateBody(MAX_BODY_BYTES + 1);
      assert.equal(Buffer.byteLength(body), MAX_BODY_BYTES + 1);
      await assertError(await postJson(base, "/tasks", body), 413);
      assert.deepEqual(await (await fetch(`${base}/tasks`)).json(), []);
    });
  });

  test("AC4 chunked body of exactly 64 KiB is read (not 413)", async () => {
    await withServer(async (base) => {
      const body = Buffer.from(paddedCreateBody(MAX_BODY_BYTES));
      // Split so the size counter must sum across chunks.
      const chunks = [body.subarray(0, 1000), body.subarray(1000, 40000), body.subarray(40000)];
      const result = await rawRequest(base, {
        method: "POST",
        path: "/tasks",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        chunks,
      });
      assert.equal(result.status, 201);
      assert.equal((JSON.parse(result.body) as Task).title, "ok");
    });
  });

  test("AC4 chunked body of exactly 64 KiB + 1 byte returns 413; nothing created", async () => {
    await withServer(async (base) => {
      const body = Buffer.from(paddedCreateBody(MAX_BODY_BYTES + 1));
      const chunks = [body.subarray(0, MAX_BODY_BYTES), body.subarray(MAX_BODY_BYTES)];
      const result = await rawRequest(base, {
        method: "POST",
        path: "/tasks",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        chunks,
      });
      assert.equal(result.status, 413);
      assert.match(String(result.headers["content-type"]), /^application\/json\b/);
      assert.deepEqual(Object.keys(JSON.parse(result.body) as object), ["error"]);
      assert.deepEqual(await (await fetch(`${base}/tasks`)).json(), []);
    });
  });

  test("AC4 the 64 KiB limit counts bytes, not characters (multi-byte UTF-8)", async () => {
    await withServer(async (base) => {
      // 22,000 three-byte characters: well under 65,536 characters, over 65,536 bytes.
      const body = JSON.stringify({ title: "€".repeat(22_000) });
      assert.ok(body.length < MAX_BODY_BYTES);
      assert.ok(Buffer.byteLength(body) > MAX_BODY_BYTES);
      await assertError(await postJson(base, "/tasks", body), 413);
      const chunked = await rawRequest(base, {
        method: "POST",
        path: "/tasks",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        chunks: [Buffer.from(body)],
      });
      assert.equal(chunked.status, 413);
      assert.deepEqual(await (await fetch(`${base}/tasks`)).json(), []);
    });
  });

  for (const key of ["__proto__", "constructor", "prototype"]) {
    test(`AC4 400 for a ${key} field on POST and PATCH; nothing changes`, async () => {
      await withServer(async (base) => {
        await assertError(await postJson(base, "/tasks", `{"title":"ok","${key}":{"status":"done"}}`), 400);
        assert.deepEqual(await (await fetch(`${base}/tasks`)).json(), []);
        const task = await createTask(base, { title: "t" });
        await assertError(
          await postJson(base, `/tasks/${task.id}/status`, `{"status":"done","${key}":{"title":"x"}}`, "PATCH"),
          400,
        );
        assert.deepEqual(await (await fetch(`${base}/tasks`)).json(), [task]);
      });
    });
  }

  test("AC2/AC6 concurrent creates are all listed and all survive a restart", async () => {
    const tasksFile = await freshTasksFile();
    const first = await start(tasksFile);
    let listed: Task[];
    let created: Task[];
    try {
      const titles = Array.from({ length: 25 }, (_, i) => `task ${String(i)}`);
      created = await Promise.all(titles.map((title) => createTask(first.base, { title })));
      listed = (await (await fetch(`${first.base}/tasks`)).json()) as Task[];
      assert.equal(listed.length, titles.length);
      assert.deepEqual(
        listed.map((task) => task.id).sort(),
        created.map((task) => task.id).sort(),
      );
      // Creation order: createdAt never decreases along the list.
      for (let i = 1; i < listed.length; i += 1) {
        assert.ok((listed[i]?.createdAt ?? "") >= (listed[i - 1]?.createdAt ?? ""));
      }
    } finally {
      await first.running.close();
    }
    const second = await start(tasksFile);
    try {
      assert.deepEqual(await (await fetch(`${second.base}/tasks`)).json(), listed);
    } finally {
      await second.running.close();
    }
  });

  test("AC5 `node src/server.ts` with TASKS_FILE unset writes to data/tasks.json under the cwd", async () => {
    const cwd = join(root, `cwd-${String((counter += 1))}`);
    await mkdir(cwd, { recursive: true });
    const serverPath = fileURLToPath(new URL("../src/server.ts", import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env, HOST: "127.0.0.1", PORT: "0" };
    delete env.TASKS_FILE;
    const child = spawn(process.execPath, [serverPath], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
          if (out.includes("\n")) {
            resolve(out);
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          err += chunk.toString("utf8");
        });
        child.once("exit", (code) => {
          reject(new Error(`server exited early with code ${String(code)}: ${err}`));
        });
      });
      assert.match(line, /tasks file: data\/tasks\.json/);
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
      assert.ok(match, `listening line: ${line}`);
      const task = await createTask(`http://127.0.0.1:${match[1] ?? ""}`, { title: "default file" });
      const stored = JSON.parse(await readFile(join(cwd, "data", "tasks.json"), "utf8")) as { tasks: Task[] };
      assert.deepEqual(stored.tasks, [task]);
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      assert.equal(await exited, 0);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
});
