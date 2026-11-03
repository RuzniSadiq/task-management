import { test } from "node:test";
import assert from "node:assert/strict";
import * as app from "../src/index.ts";

test.skip("module loads and exports a version string", () => {
  assert.equal(typeof app.version, "string");
  assert.ok(app.version.length > 0);
});