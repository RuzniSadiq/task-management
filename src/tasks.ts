// Task rules: the task shape, validation, and the errors callers can match on.
// No I/O lives here; persistence is in store.ts.

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export const TITLE_MAX_LENGTH = 200;

/** Input was rejected by a task rule. Nothing was written. */
export class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

/** No task has the given id. Nothing was written. */
export class NotFoundError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`task not found: ${id}`);
    this.name = "NotFoundError";
    this.id = id;
  }
}

/** Length in Unicode code points, so an emoji counts as one character. */
function characterCount(value: string): number {
  return [...value].length;
}

/** Returns the trimmed title, or throws ValidationError. */
export function validateTitle(input: unknown): string {
  if (typeof input !== "string") {
    throw new ValidationError("title", "title must be a string");
  }
  const title = input.trim();
  if (title.length === 0) {
    throw new ValidationError("title", "title must not be blank");
  }
  if (characterCount(title) > TITLE_MAX_LENGTH) {
    throw new ValidationError("title", `title must be at most ${TITLE_MAX_LENGTH} characters`);
  }
  return title;
}

/** Returns the trimmed search text for a title filter, or throws ValidationError if blank. */
export function validateTitleQuery(input: unknown): string {
  if (typeof input !== "string") {
    throw new ValidationError("title", "title must be a string");
  }
  const query = input.trim();
  if (query.length === 0) {
    throw new ValidationError("title", "title must not be blank");
  }
  return query;
}

/** True when `title` contains `query`, as plain text, ignoring case. `query` is already trimmed. */
export function titleContains(title: string, query: string): boolean {
  return title.toLowerCase().includes(query.toLowerCase());
}

export function isTaskStatus(input: unknown): input is TaskStatus {
  return typeof input === "string" && (TASK_STATUSES as readonly string[]).includes(input);
}

/** Returns the status unchanged, or throws ValidationError. */
export function validateStatus(input: unknown): TaskStatus {
  if (!isTaskStatus(input)) {
    throw new ValidationError("status", `status must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return input;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** True for the exact form Date#toISOString() produces, for a real instant. */
export function isIsoUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/** True when a value read from storage is a well-formed task. */
export function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "createdAt,id,status,title,updatedAt") {
    return false;
  }
  const { id, title, status, createdAt, updatedAt } = record;
  return (
    isUuid(id) &&
    typeof title === "string" &&
    title === title.trim() &&
    title.length > 0 &&
    characterCount(title) <= TITLE_MAX_LENGTH &&
    isTaskStatus(status) &&
    isIsoUtcTimestamp(createdAt) &&
    isIsoUtcTimestamp(updatedAt)
  );
}
