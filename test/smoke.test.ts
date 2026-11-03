import { test } from "node:test";
import assert from "node:assert/strict";
import * as app from "../src/index.ts";

test("module loads and exports a version string", () => {
  assert.equal(typeof app.version, "number"); // canary: deliberately wrong
  assert.ok(app.version.length > 0);
});