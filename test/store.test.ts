import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StoreCorruptError, TaskStore } from "../src/store.ts";
import { NotFoundError, ValidationError, isIsoUtcTimestamp, isUuid, type Task } from "../src/tasks.ts";

let root: string;
let counter = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "task-store-test-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fresh, empty directory per test. */
async function freshDir(): Promise<string> {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** A clock that advances one second on every call. */
function steppingClock(start = Date.UTC(2026, 0, 1, 12, 0, 0)): () => Date {
  let ms = start;
  return () => {
    const date = new Date(ms);
    ms += 1000;
    return date;
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("AC1 create a valid task", () => {
  test("returns a UUID id, status todo, equal ISO-8601 UTC timestamps, trimmed title", async () => {
    const store = await TaskStore.open(join(await freshDir(), "tasks.json"));
    const task = await store.create({ title: "  Buy milk  " });
    assert.ok(isUuid(task.id), `id is a UUID: ${task.id}`);
    assert.equal(task.status, "todo");
    assert.equal(task.title, "Buy milk");
    assert.ok(isIsoUtcTimestamp(task.createdAt), `createdAt is ISO UTC: ${task.createdAt}`);
    assert.ok(task.createdAt.endsWith("Z"));
    assert.equal(task.createdAt, task.updatedAt);
  });

  test("accepts a given valid status", async () => {
    const store = await TaskStore.open(join(await freshDir(), "tasks.json"));
    for (const status of ["todo", "in_progress", "done"] as const) {
      const task = await store.create({ title: `t-${status}`, status });
      assert.equal(task.status, status);
    }
  });

  test("ids are unique and the trimmed title is what is stored on disk", async () => {
    const path = join(await freshDir(), "tasks.json");
    const store = await TaskStore.open(path);
    const a = await store.create({ title: "\tA\n" });
    const b = await store.create({ title: "B" });
    assert.notEqual(a.id, b.id);
    const onDisk = JSON.parse(await readFile(path, "utf8")) as { tasks: Task[] };
    assert.deepEqual(
      onDisk.tasks.map((t) => t.title),
      ["A", "B"],
    );
  });

  test("a title of exactly 200 characters after trimming is accepted", async () => {
    const store = await TaskStore.open(join(await freshDir(), "tasks.json"));
    const task = await store.create({ title: `  ${"x".repeat(200)}  ` });
    assert.equal(task.title.length, 200);
  });

  test("characters are counted as code points: 200 emoji are accepted", async () => {
    const store = await TaskStore.open(join(await freshDir(), "tasks.json"));
    const title = "😀".repeat(200);
    assert.equal(title.length, 400, "UTF-16 length is twice the character count");
    const task = await store.create({ title });
    assert.equal(task.title, title);
  });

  test("only leading and trailing whitespace is trimmed", async () => {
    const store = await TaskStore.open(join(await freshDir(), "tasks.json"));
    const task = await store.create({ title: "  a  b\tc  " });
    assert.equal(task.title, "a  b\tc");
  });
});

describe("AC2 invalid create input is rejected and nothing is written", () => {
  const invalid: [string, Record<string, unknown>][] = [
    ["empty title", { title: "" }],
    ["whitespace-only title", { title: " \t\n " }],
    ["title over 200 characters after trimming", { title: ` ${"x".repeat(201)} ` }],
    ["title of 201 emoji (code points)", { title: "😀".repeat(201) }],
    ["non-string title (number)", { title: 42 }],
    ["non-string title (null)", { title: null }],
    ["non-string title (array)", { title: ["a"] }],
    ["non-string title (object)", { title: { toString: () => "a" } }],
    ["missing title", {}],
    ["unknown status", { title: "ok", status: "archived" }],
    ["status with different case", { title: "ok", status: "TODO" }],
    ["null status", { title: "ok", status: null }],
    ["non-string status", { title: "ok", status: 1 }],
  ];

  for (const [label, input] of invalid) {
    test(`${label} → ValidationError, file not created`, async () => {
      const dir = await freshDir();
      const path = join(dir, "tasks.json");
      const store = await TaskStore.open(path);
      await assert.rejects(store.create(input as { title: unknown; status?: unknown }), ValidationError);
      assert.equal(await fileExists(path), false);
      assert.deepEqual(await readdir(dir), []);
      assert.deepEqual(store.list(), []);
    });
  }

  test("rejection leaves an existing file byte-for-byte unchanged", async () => {
    const path = join(await freshDir(), "tasks.json");
    const store = await TaskStore.open(path);
    await store.create({ title: "keep" });
    const before = await readFile(path);
    const mtime = (await stat(path)).mtimeMs;
    await assert.rejects(store.create({ title: "   " }), ValidationError);
    await assert.rejects(store.create({ title: "ok", status: "nope" }), ValidationError);
    assert.deepEqual(await readFile(path), before);
    assert.equal((await stat(path)).mtimeMs, mtime);
    assert.equal(store.list().length, 1);
  });
});

describe("AC3 update status", () => {
  test("changes status and updatedAt only", async () => {
    const path = join(await freshDir(), "tasks.json");
    const store = await TaskStore.open(path, { now: steppingClock() });
    const created = await store.create({ title: "Write tests" });
    const updated = await store.updateStatus(created.id, "in_progress");
    assert.equal(updated.status, "in_progress");
    assert.notEqual(updated.updatedAt, created.updatedAt);
    assert.ok(isIsoUtcTimestamp(updated.updatedAt));
    assert.deepEqual(
      { ...updated, status: created.status, updatedAt: created.updatedAt },
      created,
    );
    const reopened = await TaskStore.open(path);
    assert.deepEqual(reopened.list(), [updated]);
  });

  test("unknown id → NotFoundError, file unchanged", async () => {
    const path = join(await freshDir(), "tasks.json");
    const store = await TaskStore.open(path);
    await store.create({ title: "only" });
    const before = await readFile(path);
    await assert.rejects(store.updateStatus("00000000-0000-4000-8000-000000000000", "done"), NotFoundError);
    assert.deepEqual(await readFile(path), before);
  });

  test("invalid status → ValidationError, file and task unchanged", async () => {
    const path = join(await freshDir(), "tasks.json");
    const store = await TaskStore.open(path);
    const task = await store.create({ title: "only" });
    const before = await readFile(path);
    await assert.rejects(store.updateStatus(task.id, "finished"), ValidationError);
    await assert.rejects(store.updateStatus(task.id, undefined), ValidationError);
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(store.list(), [task]);
  });

  test("updating one task leaves every other task unchanged, in memory and on disk", async () => {
    const path = join(await freshDir(), "tasks.json");
    const store = await TaskStore.open(path, { now: steppingClock() });
    const a = await store.create({ title: "a" });
    const b = await store.create({ title: "b" });
    const c = await store.create({ title: "c" });
    const updated = await store.updateStatus(b.id, "done");
    assert.deepEqual(store.list(), [a, updated, c]);
    const reopened = await TaskStore.open(path);
    assert.deepEqual(reopened.list(), [a, updated, c]);
  });

  test("unknown id on an empty store does not create the file", async () => {
    const dir = await freshDir();
    const store = await TaskStore.open(join(dir, "tasks.json"));
    await assert.rejects(store.updateStatus("missing", "done"), NotFoundError);
    assert.deepEqual(await readdir(dir), []);
  });
});

describe("AC4 list", () => {
  test("returns every task in creation order", async () => {
    const store = await TaskStore.open(join(await freshDir(), "tasks.json"));
    assert.deepEqual(store.list(), []);
    const titles = ["first", "second", "third", "fourth"];
    const created: Task[] = [];
    for (const title of titles) {
      created.push(await store.create({ title }));
    }
    await store.updateStatus(created[1]!.id, "done");
    assert.deepEqual(
      store.list().map((t) => t.title),
      titles,
    );
  });

  test("#77 list(status) filters by status in creation order and reflects updates", async () => {
    const store = await TaskStore.open(join(await freshDir(), "tasks.json"));
    const a = await store.create({ title: "a" });
    const b = await store.create({ title: "b", status: "done" });
    const c = await store.create({ title: "c" });
    assert.deepEqual(store.list("todo"), [a, c]);
    assert.deepEqual(store.list("done"), [b]);
    assert.deepEqual(store.list("in_progress"), []);
    assert.equal(store.list(undefined).length, 3);
    const moved = await store.updateStatus(a.id, "in_progress");
    assert.deepEqual(store.list("todo"), [c]);
    assert.deepEqual(store.list("in_progress"), [moved]);
    store.list("done")[0]!.title = "changed";
    assert.equal(store.list("done")[0]!.title, "b");
  });

  test("#77 list(status) rejects anything but the three statuses with ValidationError", async () => {
    const store = await TaskStore.open(join(await freshDir(), "tasks.json"));
    await store.create({ title: "a" });
    for (const bad of ["", "Done", "TODO", "blocked", null, 3, ["todo"]]) {
      assert.throws(() => store.list(bad), ValidationError, String(bad));
    }
  });

  test("concurrent creates are all kept, in call order", async () => {
    const path = join(await freshDir(), "tasks.json");
    const store = await TaskStore.open(path);
    const titles = Array.from({ length: 20 }, (_, i) => `task ${i}`);
    await Promise.all(titles.map((title) => store.create({ title })));
    assert.deepEqual(
      store.list().map((t) => t.title),
      titles,
    );
    const reopened = await TaskStore.open(path);
    assert.deepEqual(reopened.list(), store.list());
  });

  test("mutating a returned task does not change the store", async () => {
    const store = await TaskStore.open(join(await freshDir(), "tasks.json"));
    const task = await store.create({ title: "safe" });
    task.title = "changed";
    const listed = store.list();
    listed[0]!.status = "done";
    assert.equal(store.list()[0]!.title, "safe");
    assert.equal(store.list()[0]!.status, "todo");
  });
});

describe("AC5 persistence across restart", () => {
  test("a new store on the same file returns identical tasks", async () => {
    const path = join(await freshDir(), "tasks.json");
    const first = await TaskStore.open(path);
    const a = await first.create({ title: "one" });
    await first.create({ title: "two", status: "in_progress" });
    await first.updateStatus(a.id, "done");
    const second = await TaskStore.open(path);
    assert.deepEqual(second.list(), first.list());
    assert.equal(second.list().length, 2);
  });
});

describe("AC6 atomic writes", () => {
  test("no temp file remains after successful writes", async () => {
    const dir = await freshDir();
    const path = join(dir, "tasks.json");
    const store = await TaskStore.open(path);
    const task = await store.create({ title: "a" });
    await store.create({ title: "b" });
    await store.updateStatus(task.id, "done");
    assert.deepEqual(await readdir(dir), ["tasks.json"]);
  });

  test("each write replaces the file by rename (new inode), not in place", async () => {
    const path = join(await freshDir(), "tasks.json");
    const store = await TaskStore.open(path);
    await store.create({ title: "a" });
    const firstInode = (await stat(path)).ino;
    await store.create({ title: "b" });
    const secondInode = (await stat(path)).ino;
    assert.notEqual(secondInode, firstInode);
  });

  test(
    "a failed write leaves no temp file and does not change the store",
    { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false },
    async () => {
      const dir = await freshDir();
      const path = join(dir, "tasks.json");
      const store = await TaskStore.open(path);
      await store.create({ title: "kept" });
      const before = await readFile(path);
      await chmod(dir, 0o555);
      try {
        await assert.rejects(store.create({ title: "lost" }));
      } finally {
        await chmod(dir, 0o755);
      }
      assert.deepEqual(await readdir(dir), ["tasks.json"]);
      assert.deepEqual(await readFile(path), before);
      assert.deepEqual(
        store.list().map((t) => t.title),
        ["kept"],
      );
      // The store still works after a failed write.
      await store.create({ title: "after" });
      assert.deepEqual(
        store.list().map((t) => t.title),
        ["kept", "after"],
      );
    },
  );

  test("a write that fails at the rename step removes its temp file", async () => {
    const dir = await freshDir();
    const path = join(dir, "tasks.json");
    const store = await TaskStore.open(path);
    // Put a non-empty directory where the file should go, so rename() fails
    // after the temp file has been written and synced.
    await mkdir(path);
    await writeFile(join(path, "blocker"), "x", "utf8");
    await assert.rejects(store.create({ title: "lost" }));
    assert.deepEqual(await readdir(dir), ["tasks.json"]);
    assert.deepEqual(await readdir(path), ["blocker"]);
    assert.deepEqual(store.list(), []);
  });
});

describe("AC7 opening missing and corrupt files", () => {
  test("a missing file starts empty and is not created by opening", async () => {
    const dir = await freshDir();
    const path = join(dir, "tasks.json");
    const store = await TaskStore.open(path);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(await readdir(dir), []);
  });

  test("a missing parent directory starts empty and is created on first write", async () => {
    const dir = await freshDir();
    const path = join(dir, "data", "nested", "tasks.json");
    const store = await TaskStore.open(path);
    assert.deepEqual(store.list(), []);
    assert.equal(await fileExists(join(dir, "data")), false);
    const task = await store.create({ title: "first" });
    const reopened = await TaskStore.open(path);
    assert.deepEqual(reopened.list(), [task]);
  });

  const validTask: Task = {
    id: "3f2b8c1e-4a5d-4e6f-8a7b-9c0d1e2f3a4b",
    title: "valid",
    status: "todo",
    createdAt: "2026-01-01T12:00:00.000Z",
    updatedAt: "2026-01-01T12:00:00.000Z",
  };

  const corrupt: [string, string][] = [
    ["not JSON", "{ this is not json"],
    ["empty file", ""],
    ["truncated JSON", '{"tasks": [{"id": "abc"'],
    ["top-level array", JSON.stringify([validTask])],
    ["top-level null", "null"],
    ["tasks missing", JSON.stringify({ items: [] })],
    ["tasks not an array", JSON.stringify({ tasks: {} })],
    ["task is not an object", JSON.stringify({ tasks: ["x"] })],
    ["task id not a UUID", JSON.stringify({ tasks: [{ ...validTask, id: "1" }] })],
    ["task title blank", JSON.stringify({ tasks: [{ ...validTask, title: "  " }] })],
    ["task title untrimmed", JSON.stringify({ tasks: [{ ...validTask, title: " x " }] })],
    ["task title too long", JSON.stringify({ tasks: [{ ...validTask, title: "x".repeat(201) }] })],
    ["task status unknown", JSON.stringify({ tasks: [{ ...validTask, status: "archived" }] })],
    ["task createdAt not ISO", JSON.stringify({ tasks: [{ ...validTask, createdAt: "yesterday" }] })],
    ["task updatedAt not UTC", JSON.stringify({ tasks: [{ ...validTask, updatedAt: "2026-01-01T12:00:00+01:00" }] })],
    ["task missing a field", JSON.stringify({ tasks: [{ id: validTask.id, title: "x", status: "todo" }] })],
    ["task with an extra field", JSON.stringify({ tasks: [{ ...validTask, extra: 1 }] })],
    ["duplicate ids", JSON.stringify({ tasks: [validTask, { ...validTask, title: "other" }] })],
  ];

  for (const [label, content] of corrupt) {
    test(`${label} → open throws, file byte-for-byte unchanged`, async () => {
      const dir = await freshDir();
      const path = join(dir, "tasks.json");
      await writeFile(path, content, "utf8");
      const before = await readFile(path);
      await assert.rejects(TaskStore.open(path), StoreCorruptError);
      assert.deepEqual(await readFile(path), before);
      assert.deepEqual(await readdir(dir), ["tasks.json"]);
    });
  }

  test("a well-formed file opens with its tasks", async () => {
    const path = join(await freshDir(), "tasks.json");
    await writeFile(path, JSON.stringify({ tasks: [validTask] }), "utf8");
    const store = await TaskStore.open(path);
    assert.deepEqual(store.list(), [validTask]);
  });
});

describe("AC8 repository hygiene", () => {
  test(".gitignore ignores the data/ directory", async () => {
    const gitignore = await readFile(join(import.meta.dirname, "..", ".gitignore"), "utf8");
    const lines = gitignore.split(/\r?\n/).map((line) => line.trim());
    assert.ok(
      lines.includes("data/") || lines.includes("/data/"),
      ".gitignore has a data/ entry",
    );
  });
});
