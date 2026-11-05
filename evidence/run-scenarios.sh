#!/usr/bin/env bash
# Reproduces the assessment scenarios A-D. Every file written under evidence/scenarios/ is the output of a
# real execution (the app, GitHub's recorded check results, the real verify-release detector against the
# real v0.1.0 release, audit-query over retained evidence). Nothing here writes to GitHub: no issues,
# releases, labels or pushes. Needs: node >= 22.18, gh (authenticated, read access), jq, curl.
#
#   evidence/run-scenarios.sh            run all four scenarios
#   evidence/run-scenarios.sh a c        run only some
set -uo pipefail
cd "$(dirname "$0")/.."

REPO="${REPO:-RuzniSadiq/task-management}"
TAG="${TAG:-v0.1.0}"
SINCE="${SINCE:-2026-11-04T15:00:00Z}"
OUT=evidence/scenarios
NOW() { date -u +%Y-%m-%dT%H:%M:%SZ; }
HEAD_SHA="$(git rev-parse HEAD)"
WHICH=("$@"); [ ${#WHICH[@]} -eq 0 ] && WHICH=(a b c d)
want() { for w in "${WHICH[@]}"; do [ "$w" = "$1" ] && return 0; done; return 1; }
mkdir -p "$OUT"/{a,b,c,d}
RESULTS=()

# ---------------------------------------------------------------- Scenario A: the delivered app works
scenario_a() {
  local A="$OUT/a" TMP PORT=3917 LOG
  TMP="$(mktemp -d)"; LOG="$A/app-demo.txt"
  : > "$LOG"
  say() { printf '%s\n' "$*" | tee -a "$LOG" >/dev/null; }
  call() { say "\$ curl $*"; curl -s -w ' [HTTP %{http_code}]\n' "$@" | tee -a "$LOG" >/dev/null; }
  start() { TASKS_FILE="$TMP/tasks.json" PORT=$PORT node src/server.ts >"$TMP/server.log" 2>&1 & echo $! > "$TMP/pid"
            until curl -s "localhost:$PORT/tasks" >/dev/null 2>&1; do :; done; }
  stop() { kill "$(cat "$TMP/pid")" 2>/dev/null; wait "$(cat "$TMP/pid")" 2>/dev/null; }
  say "# Scenario A demo $(NOW) commit=$HEAD_SHA node=$(node -v)"
  start
  call -X POST "localhost:$PORT/tasks" -H 'content-type: application/json' -d '{"title":"Write the demo"}'
  call -X POST "localhost:$PORT/tasks" -H 'content-type: application/json' -d '{"title":"Review the plan"}'
  local ID; ID="$(curl -s "localhost:$PORT/tasks" | jq -r '.[0].id')"
  call "localhost:$PORT/tasks"
  call -X PATCH "localhost:$PORT/tasks/$ID/status" -H 'content-type: application/json' -d '{"status":"done"}'
  say "--- error cases"
  call -X POST "localhost:$PORT/tasks" -H 'content-type: application/json' -d '{"title":""}'
  call -X PATCH "localhost:$PORT/tasks/nope/status" -H 'content-type: application/json' -d '{"status":"done"}'
  call -X DELETE "localhost:$PORT/tasks"
  say "--- restart the server and list again (persistence)"
  stop; start
  local AFTER; AFTER="$(curl -s "localhost:$PORT/tasks")"
  call "localhost:$PORT/tasks"
  stop
  local PERSISTED=false
  [ "$(jq -r '.[0].status' <<<"$AFTER")" = done ] && [ "$(jq length <<<"$AFTER")" = 2 ] && PERSISTED=true
  say "--- automated tests"
  local T; T="$(npm test 2>&1 | grep -E '^# (tests|pass|fail|skipped)')"
  say "$T"
  local PASS FAIL; PASS="$(sed -n 's/^# pass //p' <<<"$T")"; FAIL="$(sed -n 's/^# fail //p' <<<"$T")"
  # who built it and how it was reviewed, from GitHub's records
  local PRS='[]' n
  for n in 30 34 33; do
    PRS="$(jq --argjson p "$(gh pr view "$n" --repo "$REPO" --json number,title,url,state,mergedAt,mergeCommit,author,reviews,commits |
      jq '{pr:.number,title,url,state,merged_at:.mergedAt,merge_commit:.mergeCommit.oid,author:.author.login,
           agent_vendors:([.commits[].messageBody|capture("Agent-Vendor: (?<v>.*)")?|.v]|unique),
           reviews:[.reviews[]|{reviewer:.author.login,state,commit:.commit.oid,second_opinion:(.body|capture("Second opinion — (?<v>[a-z]+)")?|.v)}]}')" '. + [$p]' <<<"$PRS")"
  done
  jq -n --arg at "$(NOW)" --arg commit "$HEAD_SHA" --arg repo "$REPO" --argjson prs "$PRS" --argjson persisted "$PERSISTED" \
        --arg pass "$PASS" --arg fail "$FAIL" --arg issue "https://github.com/$REPO/issues/26" \
    '{schema:"task-management.scenario-evidence/v1",scenario:"A",recorded_at:$at,repository:$repo,commit:$commit,
      requirement:"The application must support creating tasks, listing tasks and updating task status. It should persist its data locally and include automated tests.",
      plan:$issue,delivered_by:$prs,
      checks:{app_create_list_patch:"see app-demo.txt",persists_across_restart:$persisted,tests_passed:($pass|tonumber),tests_failed:($fail|tonumber)},
      result:(if $persisted and ($fail=="0") and (($pass|tonumber)>0) then "pass" else "fail" end)}' > "$A/scenario-a.json"
  rm -rf "$TMP"
  RESULTS+=("A $(jq -r .result "$A/scenario-a.json")")
}

# ---------------------------------------------------------------- Scenario B: preventative controls block
scenario_b() {
  local B="$OUT/b" C='[]' n exp
  # The rule under test: the checks branch protection requires, read live and compared to the declared policy.
  local REQ REQ_OK=false WANT
  WANT="$(jq -c '.requiredContexts|sort' .gibson-delivery.json)"
  if REQ="$(gh api "repos/$REPO/branches/main/protection/required_status_checks" --jq '.contexts' 2>/dev/null)" \
     && [ "$(jq -c 'sort' <<<"$REQ")" = "$WANT" ]; then REQ_OK=true; else REQ="${REQ:-[]}"; fi
  # PR number : exact set of required checks that must fail (a canary may trip more than its named rule)
  for pair in '6:[]' '7:["test-integrity"]' '8:["gate","test-integrity"]' '9:["gate"]' '10:["DCO"]'; do
    n="${pair%%:*}"; exp="${pair#*:}"
    C="$(jq --argjson p "$(gh pr view "$n" --repo "$REPO" --json number,title,url,state,headRefOid,statusCheckRollup |
      jq --argjson exp "$exp" '{pr:.number,url,title,head:.headRefOid,state,expected_failing_checks:($exp|sort),
        checks:[.statusCheckRollup[]|select(.name|IN("gate","test-integrity","DCO","security-fast"))|{name,conclusion}]}
        | . + {failed_checks:([.checks[]|select(.conclusion=="FAILURE")|.name]|sort)}
        | . + {result:(if .failed_checks==.expected_failing_checks and .state!="MERGED" then "pass" else "fail" end)}')" '. + [$p]' <<<"$C")"
  done
  jq -n --arg at "$(NOW)" --arg repo "$REPO" --argjson req "$REQ" --argjson reqok "$REQ_OK" --argjson want "$WANT" --argjson c "$C" \
    '{schema:"task-management.scenario-evidence/v1",scenario:"B",recorded_at:$at,repository:$repo,
      rule:"Branch protection on main requires these checks; a PR with a failing required check cannot merge",
      required_checks:{live:$req,declared:$want,match:$reqok},controlled_failures:$c,
      related:["evidence/P2-agent-least-privilege.json (direct push refused, restricted token refused, repo-boundary guard)"],
      result:(if $reqok and ($c|length)==5 and ($c|all(.result=="pass")) then "pass" else "fail" end)}' > "$B/scenario-b.json"
  RESULTS+=("B $(jq -r .result "$B/scenario-b.json")")
}

# ---------------------------------------------------------------- Scenario C: detective control finds tampering
scenario_c() {
  local C="$OUT/c" TMP REAL ID; TMP="$(mktemp -d)"; REAL="$(command -v gh)"
  ID="$(gh api "repos/$REPO/releases/tags/$TAG" --jq '.assets[]|select(.name|endswith(".tgz"))|.id')"
  # The released tarball is served with one byte appended, as if replaced after release. The real verify-release
  # detector then runs against the real release records and the real attestation. --dry-run: no GitHub writes.
  cat > "$TMP/gh" <<SHIM
#!/usr/bin/env bash
if [ "\$1" = api ] && [ "\$2" = -H ] && [[ "\$4" == */releases/assets/$ID ]]; then "$REAL" "\$@" && printf 'X'; exit \$?; fi
exec "$REAL" "\$@"
SHIM
  chmod +x "$TMP/gh"
  { echo "# $(NOW) commit=$HEAD_SHA: verify-release against $TAG with the tarball altered in transit (simulated violation)"
    PATH="$TMP:$PATH" node scripts/verify-release.ts --repo "$REPO" --dry-run --out "$C/verify-release-evidence.tampered.json"; echo "exit=$?"
    echo "# control run: same detector, untouched release"
    node scripts/verify-release.ts --repo "$REPO" --dry-run --out "$C/verify-release-evidence.clean.json"; echo "exit=$?"
  } > "$C/detector-output.txt" 2>&1
  rm -rf "$TMP"
  jq -n --arg at "$(NOW)" --arg repo "$REPO" --arg tag "$TAG" \
        --slurpfile t "$C/verify-release-evidence.tampered.json" --slurpfile k "$C/verify-release-evidence.clean.json" \
    '{schema:"task-management.scenario-evidence/v1",scenario:"C",recorded_at:$at,repository:$repo,release:$tag,
      violation:"released tarball replaced (one byte appended) after release",
      detector:"scripts/verify-release.ts (SDLC-PREV-003, SDLC-PREV-002)",
      tampered_run:{result:$t[0].result,reasons:$t[0].releases[0].artefacts[0].reasons,attestation:$t[0].releases[0].artefacts[0].attestation,observed_sha256:$t[0].releases[0].artefacts[0].observed_sha256},
      clean_run:{result:$k[0].result,observed_sha256:$k[0].releases[0].artefacts[0].observed_sha256},
      result:(if $t[0].result=="fail" and $k[0].result=="pass" then "pass" else "fail" end)}' > "$C/scenario-c.json"
  RESULTS+=("C $(jq -r .result "$C/scenario-c.json")")
}

# ---------------------------------------------------------------- Scenario D: audit evidence answers the five questions
scenario_d() {
  local D="$OUT/d" IN="$OUT/d/evidence-input" PRN="${PR:-62}" SHA
  mkdir -p "$IN"
  gh release download "$TAG" --repo "$REPO" --pattern release-evidence.json --dir "$IN" --clobber
  node scripts/verify-release.ts --repo "$REPO" --dry-run --out "$IN/verify-release-evidence.json" >/dev/null 2>&1
  node scripts/control-audit.ts --repo "$REPO" --since "$SINCE" --dry-run --out "$IN/control-evidence.jsonl" >/dev/null 2>&1
  SHA="$(jq -r --argjson n "$PRN" 'select(.subject.pr==$n)|.subject.sha' "$IN/control-evidence.jsonl" | head -1)"
  node scripts/audit-query.ts "$SHA" --evidence "$IN" --json > "$D/audit-query-commit.json" 2>"$D/audit-query-commit.err"; local rc1=$?
  node scripts/audit-query.ts "$TAG" --evidence "$IN" --json > "$D/audit-query-release.json" 2>"$D/audit-query-release.err"; local rc2=$?
  jq -n --arg at "$(NOW)" --arg sha "$SHA" --arg tag "$TAG" --argjson pr "$PRN" --argjson rc1 "$rc1" --argjson rc2 "$rc2" \
        --slurpfile c "$D/audit-query-commit.json" --slurpfile r "$D/audit-query-release.json" \
    '{schema:"task-management.scenario-evidence/v1",scenario:"D",recorded_at:$at,
      questions:["which agent/vendor acted and who approved","which software or artefact","which FINOS control was evaluated","pass, fail or blocked","what evidence supports it"],
      commit_query:{sha:$sha,pr:$pr,exit:$rc1,output:"audit-query-commit.json"},
      release_query:{tag:$tag,exit:$rc2,output:"audit-query-release.json"},
      result:(if $rc1==0 and $rc2==0 then "pass" else "fail" end)}' > "$D/scenario-d.json"
  RESULTS+=("D $(jq -r .result "$D/scenario-d.json")")
}

want a && scenario_a
want b && scenario_b
want c && scenario_c
want d && scenario_d
printf '%s\n' "${RESULTS[@]}"
for r in "${RESULTS[@]}"; do [ "${r#* }" = pass ] || exit 1; done
