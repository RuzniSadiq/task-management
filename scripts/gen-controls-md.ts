// gen-controls-md.ts — renders CONTROLS.md (the control implementation matrix) from controls.json.
//
// Usage:
//   node scripts/gen-controls-md.ts           write CONTROLS.md
//   node scripts/gen-controls-md.ts --check   exit 1 if the committed CONTROLS.md is stale
// controls.json is the single source of truth; test/controls.test.ts fails if CONTROLS.md drifts.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface FinosRef { framework: "sdlc" | "aigf"; id: string; title: string; version: string; kind: "mitigation" | "risk" }
export interface Control {
  id: string;
  name: string;
  type: "preventative" | "detective";
  finos: FinosRef[];
  risk: string;
  operates: string;
  mechanism: string[];
  verify: string[];
  evidence: string[];
}
export interface LabelNote { label: string; used_in: string; note: string }
export interface Registry {
  schema: string;
  frameworks: Record<"sdlc" | "aigf", { name: string; version?: string; source: string; note?: string }>;
  controls: Control[];
  label_notes: LabelNote[];
}

export const REGISTRY_SCHEMA = "task-management.controls/v1";

export function parseRegistry(text: string): Registry {
  const r = JSON.parse(text) as Registry;
  if (r.schema !== REGISTRY_SCHEMA) throw new Error(`controls.json schema must be ${REGISTRY_SCHEMA}`);
  return r;
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (s: string): string => `\`${s.replace(/`/g, "")}\``;
const ref = (r: FinosRef, fw: Registry["frameworks"]): string =>
  `${r.id} ${r.title} (${r.kind}, ${r.framework === "aigf" ? `AIGF ${fw.aigf.version ?? r.version}` : `SDLC v${r.version}`})`;

export function render(reg: Registry): string {
  const out: string[] = [
    "<!-- Generated from controls.json by scripts/gen-controls-md.ts. Do not edit by hand. -->",
    "",
    "# Control implementation matrix",
    "",
    "Each control below is implemented in executable code or pipeline configuration, not in an agent's prompt.",
    "FINOS references were checked against the frameworks' source repositories:",
    "",
    `- ${reg.frameworks.sdlc.name}: ${reg.frameworks.sdlc.source} (${reg.frameworks.sdlc.note ?? ""})`,
    `- ${reg.frameworks.aigf.name} ${reg.frameworks.aigf.version ?? ""}: ${reg.frameworks.aigf.source}`,
    "",
    "| Id | Control | Type | FINOS reference | Mechanism | Evidence |",
    "|---|---|---|---|---|---|",
    ...reg.controls.map((c) =>
      `| ${c.id} | ${cell(c.name)} | ${c.type} | ${cell(c.finos.map((f) => ref(f, reg.frameworks)).join("; "))} | ${cell(c.mechanism.map(code).join(", "))} | ${cell(c.evidence.join("; "))} |`),
    "",
  ];
  for (const c of reg.controls) {
    out.push(
      `## ${c.id} ${c.name} (${c.type})`,
      "",
      `**FINOS:** ${c.finos.map((f) => ref(f, reg.frameworks)).join("; ")}`,
      "",
      `**Risk addressed:** ${c.risk}`,
      "",
      `**How it operates:** ${c.operates}`,
      "",
      `**Mechanism:** ${c.mechanism.map(code).join(", ")}`,
      "",
      "**Independent verification:**",
      "",
      ...c.verify.map((v) => `- ${code(v)}`),
      "",
      "**Evidence:**",
      "",
      ...c.evidence.map((e) => `- ${e}`),
      "",
    );
  }
  out.push(
    "## Labels in the code that do not match the FINOS catalogue",
    "",
    "These ids or labels appear in workflows and scripts but do not describe the FINOS control of that id. They are listed so the discrepancy is visible; the registry above uses the verified references.",
    "",
    "| Label | Used in | Note |",
    "|---|---|---|",
    ...reg.label_notes.map((n) => `| ${n.label} | ${cell(n.used_in)} | ${cell(n.note)} |`),
    "",
  );
  return out.join("\n");
}

function main(argv: string[]): number {
  const reg = parseRegistry(readFileSync("controls.json", "utf8"));
  const text = render(reg);
  if (argv.includes("--check")) {
    const current = readFileSync("CONTROLS.md", "utf8");
    if (current !== text) { console.log("CONTROLS.md is stale: run node scripts/gen-controls-md.ts"); return 1; }
    console.log("CONTROLS.md is up to date");
    return 0;
  }
  writeFileSync("CONTROLS.md", text);
  console.log("wrote CONTROLS.md");
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
