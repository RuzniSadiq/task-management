import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRegistry, render } from "../scripts/gen-controls-md.ts";
import type { Registry } from "../scripts/gen-controls-md.ts";
import { CONTROLS as AUDIT_CONTROLS } from "../scripts/control-audit.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string): string => readFileSync(join(root, p), "utf8");
const reg: Registry = parseRegistry(read("controls.json"));

test("every control has id, FINOS references with versions, type, risk, mechanism, verification and evidence", () => {
  const ids = new Set<string>();
  for (const c of reg.controls) {
    assert.ok(!ids.has(c.id), `duplicate control id ${c.id}`);
    ids.add(c.id);
    assert.ok(c.type === "preventative" || c.type === "detective", `${c.id} type`);
    for (const f of ["name", "risk", "operates"] as const) assert.ok(c[f].trim() !== "", `${c.id} ${f}`);
    for (const f of ["finos", "mechanism", "verify", "evidence"] as const) assert.ok(c[f].length > 0, `${c.id} ${f}`);
    for (const r of c.finos) {
      assert.ok(r.id !== "" && r.title !== "" && r.version !== "", `${c.id} reference ${r.id} is incomplete`);
      assert.ok(r.framework === "sdlc" || r.framework === "aigf", `${c.id} ${r.id} framework`);
    }
  }
});

test("at least two preventative and two detective controls", () => {
  assert.ok(reg.controls.filter((c) => c.type === "preventative").length >= 2);
  assert.ok(reg.controls.filter((c) => c.type === "detective").length >= 2);
});

test("every mechanism path exists", () => {
  for (const c of reg.controls) for (const m of c.mechanism) assert.ok(existsSync(join(root, m)), `${c.id}: ${m} does not exist`);
});

/** Every FINOS-style id mentioned in workflows and scripts, normalised (a bare RC-005 is SDLC-RC-005). */
function referencedIds(): Map<string, string[]> {
  const files = [
    ...readdirSync(join(root, ".github/workflows")).map((f) => `.github/workflows/${f}`),
    ...readdirSync(join(root, "scripts")).filter((f) => /\.(ts|mjs)$/.test(f)).map((f) => `scripts/${f}`),
  ];
  const found = new Map<string, string[]>();
  for (const f of files) {
    for (const m of read(f).matchAll(/\b(SDLC-[A-Z]+-\d{3}|(?:RC|SEC|PREV)-\d{3}|MI-\d+|RI-\d+|OP-\d{3})\b/g)) {
      const raw = m[1] ?? "";
      const id = /^(RC|SEC|PREV)-/.test(raw) ? `SDLC-${raw}` : raw;
      found.set(id, [...(found.get(id) ?? []), f]);
    }
  }
  return found;
}

test("every control id referenced in workflows and scripts is in the registry", () => {
  const known = new Set(reg.controls.flatMap((c) => c.finos.map((r) => r.id)));
  const found = referencedIds();
  assert.ok(found.size > 0, "the scan found no ids, so it is broken");
  for (const [id, files] of found) assert.ok(known.has(id), `${id} (in ${[...new Set(files)].join(", ")}) is not in controls.json`);
});

test("every FINOS id the registry cites is a well-formed SDLC or AIGF id", () => {
  for (const c of reg.controls) for (const r of c.finos) {
    assert.match(r.id, r.framework === "sdlc" ? /^SDLC-(PREV|SEC|RC)-\d{3}$/ : /^(MI|RI)-\d+$/, `${c.id} ${r.id}`);
  }
});

test("CONTROLS.md is generated from controls.json and is not stale", () => {
  assert.equal(read("CONTROLS.md"), render(reg), "run: node scripts/gen-controls-md.ts");
});

test("gen-controls-md --check exits 0 when current", () => {
  const r = spawnSync(process.execPath, [join(root, "scripts/gen-controls-md.ts"), "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("every control id and version control-audit writes into evidence matches a verified registry entry", () => {
  const refs = new Map(reg.controls.flatMap((c) => c.finos.map((r) => [`${r.id}@${r.version}`, r] as const)));
  for (const c of Object.values(AUDIT_CONTROLS)) assert.ok(refs.has(`${c.id}@${c.version}`), `${c.check}: ${c.id} v${c.version} is not in controls.json`);
});

test("no workflow or script cites a label that is not a FINOS id (OP-007 and similar)", () => {
  assert.ok(!referencedIds().has("OP-007"));
});
