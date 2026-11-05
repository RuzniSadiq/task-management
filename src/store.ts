// Task store: holds tasks in memory and persists them to one JSON file.
//
// File format: { "tasks": [Task, ...] } in creation order.
// Every write goes to a temp file in the same directory and is then renamed
// over the target, so a reader never sees a half-written file.

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  NotFoundError,
  isTask,
  titleContains,
  validateStatus,
  validateTitle,
  validateTitleQuery,
  type Task,
} from "./tasks.ts";

/** The store file exists but is not valid JSON of the expected shape. */
export class StoreCorruptError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`task store file is corrupt (${reason}): ${path}`);
    this.name = "StoreCorruptError";
    this.path = path;
  }
}

export interface CreateTaskInput {
  title: unknown;
  status?: unknown;
}

export interface TaskStoreOptions {
  /** Clock used for createdAt/updatedAt. Defaults to the system clock. */
  now?: () => Date;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseTasks(path: string, raw: string): Task[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new StoreCorruptError(path, "not valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new StoreCorruptError(path, "top level is not an object");
  }
  const tasks = (data as Record<string, unknown>).tasks;
  if (!Array.isArray(tasks)) {
    throw new StoreCorruptError(path, '"tasks" is not an array');
  }
  const seen = new Set<string>();
  const result: Task[] = [];
  for (const [index, item] of (tasks as unknown[]).entries()) {
    if (!isTask(item)) {
      throw new StoreCorruptError(path, `tasks[${index}] is not a valid task`);
    }
    if (seen.has(item.id)) {
      throw new StoreCorruptError(path, `duplicate task id ${item.id}`);
    }
    seen.add(item.id);
    result.push({ ...item });
  }
  return result;
}

export class TaskStore {
  readonly path: string;
  #tasks: Task[];
  #now: () => Date;
  /** Serializes mutations so concurrent calls cannot lose each other's writes. */
  #queue: Promise<void> = Promise.resolve();

  private constructor(path: string, tasks: Task[], now: () => Date) {
    this.path = path;
    this.#tasks = tasks;
    this.#now = now;
  }

  /**
   * Opens the store at `path`. A missing file (or missing parent directory)
   * starts empty and is not created until the first write. A corrupt or
   * wrongly shaped file throws StoreCorruptError and is never modified.
   */
  static async open(path: string, options: TaskStoreOptions = {}): Promise<TaskStore> {
    let tasks: Task[] = [];
    let raw: string | undefined;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (!(isErrnoException(error) && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (raw !== undefined) {
      tasks = parseTasks(path, raw);
    }
    return new TaskStore(path, tasks, options.now ?? (() => new Date()));
  }

  /**
   * Every task, in creation order. Returned objects are copies. With `status`
   * given, only the tasks that have it; with `title` given, only the tasks
   * whose title contains the (trimmed) text, ignoring case. Both together
   * must match. An invalid `status` or a blank `title` throws ValidationError
   * and never falls back to the unfiltered list.
   */
  list(status?: unknown, title?: unknown): Task[] {
    const wanted = status === undefined ? undefined : validateStatus(status);
    const query = title === undefined ? undefined : validateTitleQuery(title);
    return this.#tasks
      .filter((task) => wanted === undefined || task.status === wanted)
      .filter((task) => query === undefined || titleContains(task.title, query))
      .map((task) => ({ ...task }));
  }

  /** Validates, persists, and returns a new task. */
  create(input: CreateTaskInput): Promise<Task> {
    return this.#mutate(() => {
      const title = validateTitle(input.title);
      const status = input.status === undefined ? "todo" : validateStatus(input.status);
      const timestamp = this.#now().toISOString();
      const task: Task = { id: randomUUID(), title, status, createdAt: timestamp, updatedAt: timestamp };
      return { tasks: [...this.#tasks, task], result: task };
    });
  }

  /** Changes `status` and `updatedAt` of an existing task, persists, and returns it. */
  updateStatus(id: string, status: unknown): Promise<Task> {
    return this.#mutate(() => {
      const index = this.#tasks.findIndex((task) => task.id === id);
      const current = this.#tasks[index];
      if (current === undefined) {
        throw new NotFoundError(id);
      }
      const nextStatus = validateStatus(status);
      const updated: Task = { ...current, status: nextStatus, updatedAt: this.#now().toISOString() };
      const tasks = [...this.#tasks];
      tasks[index] = updated;
      return { tasks, result: updated };
    });
  }

  /**
   * Runs `change` after any earlier mutation settles. If `change` throws,
   * nothing is written. In-memory state is replaced only after the file
   * write succeeds.
   */
  #mutate(change: () => { tasks: Task[]; result: Task }): Promise<Task> {
    const run = this.#queue.then(async () => {
      const { tasks, result } = change();
      await this.#write(tasks);
      this.#tasks = tasks;
      return { ...result };
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #write(tasks: Task[]): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true });
    const temp = join(directory, `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ tasks }, null, 2)}\n`, "utf8");
        // Flush to disk before the rename, so a crash cannot publish an empty file.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
