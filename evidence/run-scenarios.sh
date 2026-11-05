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
  rm -f "$A"/*; : > "$LOG"
  local ASSERT=() LAST_CODE="" LAST_BODY=""
  say() { printf '%s\n' "$*" | tee -a "$LOG" >/dev/null; }
  call() { say "\$ curl $*"; LAST_CODE="$(curl -s -o "$TMP/body" -w '%{http_code}' "$@")"; LAST_BODY="$(cat "$TMP/body")"; say "$LAST_BODY [HTTP $LAST_CODE]"; }
  # expect <name> <status> <jq expression that must be true of the response body>
  expect() { local ok=false; [ "$LAST_CODE" = "$2" ] && jq -e "$3" >/dev/null 2>&1 <<<"$LAST_BODY" && ok=true; ASSERT+=("$1|$ok"); }
  # Ready when the server answers; gives up after ~10s or as soon as the process has died, with its log.
  start() { TASKS_FILE="$TMP/tasks.json" PORT=$PORT node src/server.ts >"$TMP/server.log" 2>&1 & echo $! > "$TMP/pid"
            local i; for i in $(seq 1 100); do
              # our own process must be alive and have announced the port, so another listener cannot pass for it
              kill -0 "$(cat "$TMP/pid")" 2>/dev/null || break
              grep -q "listening on" "$TMP/server.log" 2>/dev/null && curl -s -o /dev/null "localhost:$PORT/tasks" 2>/dev/null && return 0
              sleep 0.1
            done
            say "server did not start on port $PORT; its log:"; cat "$TMP/server.log" >> "$LOG"; return 1; }
  stop() { kill "$(cat "$TMP/pid")" 2>/dev/null; wait "$(cat "$TMP/pid")" 2>/dev/null; }
  say "# Scenario A demo $(NOW) commit=$HEAD_SHA node=$(node -v)"
  if ! start; then
    jq -n --arg at "$(NOW)" '{schema:"task-management.scenario-evidence/v1",scenario:"A",recorded_at:$at,error:"server did not start; see app-demo.txt",result:"fail"}' > "$A/scenario-a.json"
    stop; rm -rf "$TMP"; RESULTS+=("A fail"); return
  fi
  call -X POST "localhost:$PORT/tasks" -H 'content-type: application/json' -d '{"title":"Write the demo"}'
  expect "create task returns 201 with id, title and status todo" 201 '(.id|type=="string") and .title=="Write the demo" and .status=="todo"'
  local ID; ID="$(jq -r .id <<<"$LAST_BODY")"
  call -X POST "localhost:$PORT/tasks" -H 'content-type: application/json' -d '{"title":"Review the plan"}'
  expect "second create returns 201" 201 '.title=="Review the plan"'
  call "localhost:$PORT/tasks"
  expect "list returns 200 with both tasks in creation order" 200 'length==2 and .[0].title=="Write the demo" and .[1].title=="Review the plan"'
  call -X PATCH "localhost:$PORT/tasks/$ID/status" -H 'content-type: application/json' -d '{"status":"done"}'
  expect "update status returns 200 with status done" 200 '.id=="'"$ID"'" and .status=="done"'
  say "--- error cases"
  call -X POST "localhost:$PORT/tasks" -H 'content-type: application/json' -d '{"title":""}'
  expect "blank title is 400 with an error message" 400 '(.error|type=="string")'
  call -X PATCH "localhost:$PORT/tasks/nope/status" -H 'content-type: application/json' -d '{"status":"done"}'
  expect "unknown id is 404 with an error message" 404 '(.error|type=="string")'
  call -X DELETE "localhost:$PORT/tasks"
  expect "wrong method is 405 with an error message" 405 '(.error|type=="string")'
  say "--- restart the server and list again (persistence)"
  stop
  if ! start; then ASSERT+=("server restarts|false"); fi
  call "localhost:$PORT/tasks"
  expect "after restart the list still has both tasks and the updated status" 200 'length==2 and .[0].status=="done"'
  stop
  say "--- automated tests"
  local T; T="$(npm test 2>&1 | grep -E '^# (tests|pass|fail|skipped)')"
  say "$T"
  local PASS FAIL; PASS="$(sed -n 's/^# pass //p' <<<"$T")"; FAIL="$(sed -n 's/^# fail //p' <<<"$T")"
  : "${PASS:=0}" "${FAIL:=1}"
  # who built it and how it was reviewed, from GitHub's records
  local PRS='[]' n
  for n in 30 34 33; do
    PRS="$(jq --argjson p "$(gh pr view "$n" --repo "$REPO" --json number,title,url,state,mergedAt,mergeCommit,author,reviews,commits |
      jq '{pr:.number,title,url,state,merged_at:.mergedAt,merge_commit:.mergeCommit.oid,author:.author.login,
           agent_vendors:([.commits[].messageBody|capture("Agent-Vendor: (?<v>.*)")?|.v]|unique),
           reviews:[.reviews[]|{reviewer:.author.login,state,commit:.commit.oid,second_opinion:(.body|capture("Second opinion — (?<v>[a-z]+)")?|.v)}]}')" '. + [$p]' <<<"$PRS")" || PRS='[]'
  done
  local ASSERTIONS; ASSERTIONS="$(printf '%s\n' "${ASSERT[@]}" | jq -R 'split("|")|{name:.[0],pass:(.[1]=="true")}' | jq -s .)"
  jq -n --arg at "$(NOW)" --arg commit "$HEAD_SHA" --arg repo "$REPO" --argjson prs "$PRS" --argjson assertions "$ASSERTIONS" \
        --arg pass "$PASS" --arg fail "$FAIL" --arg issue "https://github.com/$REPO/issues/26" \
    '{schema:"task-management.scenario-evidence/v1",scenario:"A",recorded_at:$at,repository:$repo,commit:$commit,
      requirement:"The application must support creating tasks, listing tasks and updating task status. It should persist its data locally and include automated tests.",
      plan:$issue,delivered_by:$prs,api_assertions:$assertions,
      checks:{tests_passed:($pass|tonumber),tests_failed:($fail|tonumber)},
      result:(if ($assertions|length)==8 and ($assertions|all(.pass)) and $fail=="0" and (($pass|tonumber)>0) and ($prs|length)==3 then "pass" else "fail" end)}' > "$A/scenario-a.json"
  rm -rf "$TMP"
  RESULTS+=("A $(jq -r .result "$A/scenario-a.json" 2>/dev/null || echo fail)")
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
      jq --argjson exp "$exp" --argjson want "$WANT" '{pr:.number,url,title,head:.headRefOid,state,expected_failing_checks:($exp|sort),
        checks:[.statusCheckRollup[]|select(.name|IN($want[]))|{name,status,conclusion}]}
        # every required check must be present with a completed, non-empty conclusion before failures are compared
        | . + {incomplete_or_missing:($want - [.checks[]|select(.status=="COMPLETED" and ((.conclusion//"")|length)>0)|.name])}
        | . + {failed_checks:([.checks[]|select(.conclusion=="FAILURE")|.name]|sort)}
        | . + {result:(if .incomplete_or_missing==[] and .failed_checks==.expected_failing_checks and .state!="MERGED" then "pass" else "fail" end)}')" '. + [$p]' <<<"$C")"
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
  rm -f "$C"/*
  ID="$(gh api "repos/$REPO/releases/tags/$TAG" --jq '.assets[]|select(.name|endswith(".tgz"))|.id')"
  # The released tarball is served with one byte appended, as if replaced after release. The real verify-release
  # detector then runs against the real release records and the real attestation. --dry-run: no GitHub writes.
  cat > "$TMP/gh" <<SHIM
#!/usr/bin/env bash
if [ "\$1" = api ] && [ "\$2" = -H ] && [[ "\$4" == */releases/assets/$ID ]]; then "$REAL" "\$@" && printf 'X'; exit \$?; fi
exec "$REAL" "\$@"
SHIM
  chmod +x "$TMP/gh"
  local rc_t rc_c
  { echo "# $(NOW) commit=$HEAD_SHA: verify-release against $TAG with the tarball altered in transit (simulated violation)"
    PATH="$TMP:$PATH" node scripts/verify-release.ts --repo "$REPO" --dry-run --out "$C/verify-release-evidence.tampered.json"; rc_t=$?; echo "exit=$rc_t"
    echo "# control run: same detector, untouched release"
    node scripts/verify-release.ts --repo "$REPO" --dry-run --out "$C/verify-release-evidence.clean.json"; rc_c=$?; echo "exit=$rc_c"
  } > "$C/detector-output.txt" 2>&1
  rm -rf "$TMP"
  [ -s "$C/verify-release-evidence.tampered.json" ] && [ -s "$C/verify-release-evidence.clean.json" ] \
    || { echo "scenario C: detector wrote no evidence" >&2; RESULTS+=("C fail"); return; }
  jq -n --arg at "$(NOW)" --arg repo "$REPO" --arg tag "$TAG" --argjson rct "$rc_t" --argjson rcc "$rc_c" \
        --slurpfile t "$C/verify-release-evidence.tampered.json" --slurpfile k "$C/verify-release-evidence.clean.json" \
    '{schema:"task-management.scenario-evidence/v1",scenario:"C",recorded_at:$at,repository:$repo,release:$tag,
      violation:"released tarball replaced (one byte appended) after release",
      detector:"scripts/verify-release.ts (SDLC-PREV-003, SDLC-PREV-002)",
      detector_exit:{tampered:$rct,clean:$rcc},
      tampered_run:{result:$t[0].result,reasons:$t[0].releases[0].artefacts[0].reasons,attestation:$t[0].releases[0].artefacts[0].attestation,observed_sha256:$t[0].releases[0].artefacts[0].observed_sha256},
      clean_run:{result:$k[0].result,observed_sha256:$k[0].releases[0].artefacts[0].observed_sha256},
      result:(if $t[0].result=="fail" and $k[0].result=="pass" and $rct==1 and $rcc==0 then "pass" else "fail" end)}' > "$C/scenario-c.json"
  RESULTS+=("C $(jq -r .result "$C/scenario-c.json")")
}

# ---------------------------------------------------------------- Scenario D: audit evidence answers the five questions
scenario_d() {
  local D="$OUT/d" IN="$OUT/d/evidence-input" PRN="${PR:-62}" SHA ok=true
  rm -rf "$D"; mkdir -p "$IN"          # nothing from an earlier run can feed this one
  step() { "$@" || { echo "scenario D: failed: $*" >&2; ok=false; }; }
  step gh release download "$TAG" --repo "$REPO" --pattern release-evidence.json --dir "$IN" --clobber
  # verify-release and control-audit exit 1 when they find violations; here they must pass and write evidence
  step node scripts/verify-release.ts --repo "$REPO" --dry-run --out "$IN/verify-release-evidence.json" >/dev/null
  step node scripts/control-audit.ts --repo "$REPO" --since "$SINCE" --dry-run --out "$IN/control-evidence.jsonl" >/dev/null
  for f in release-evidence.json verify-release-evidence.json control-evidence.jsonl; do
    [ -s "$IN/$f" ] || { echo "scenario D: missing input $f" >&2; ok=false; }
  done
  SHA="$(jq -r --argjson n "$PRN" 'select(.subject.pr==$n)|.subject.sha' "$IN/control-evidence.jsonl" 2>/dev/null | head -1)"
  [ -n "$SHA" ] || { echo "scenario D: no control-audit record for PR $PRN" >&2; ok=false; }
  local rc1=1 rc2=1
  if $ok; then
    node scripts/audit-query.ts "$SHA" --evidence "$IN" --json > "$D/audit-query-commit.json" 2>"$D/audit-query-commit.err"; rc1=$?
    node scripts/audit-query.ts "$TAG" --evidence "$IN" --json > "$D/audit-query-release.json" 2>"$D/audit-query-release.err"; rc2=$?
  fi
  jq -n --arg at "$(NOW)" --arg sha "${SHA:-}" --arg tag "$TAG" --argjson pr "$PRN" --argjson rc1 "$rc1" --argjson rc2 "$rc2" --argjson inputs_ok "$ok" \
    '{schema:"task-management.scenario-evidence/v1",scenario:"D",recorded_at:$at,
      questions:["which agent/vendor acted and who approved","which software or artefact","which FINOS control was evaluated","pass, fail or blocked","what evidence supports it"],
      inputs_ok:$inputs_ok,
      commit_query:{sha:$sha,pr:$pr,exit:$rc1,output:"audit-query-commit.json"},
      release_query:{tag:$tag,exit:$rc2,output:"audit-query-release.json"},
      result:(if $inputs_ok and $rc1==0 and $rc2==0 then "pass" else "fail" end)}' > "$D/scenario-d.json"
  RESULTS+=("D $(jq -r .result "$D/scenario-d.json")")
}

want a && scenario_a
want b && scenario_b
want c && scenario_c
want d && scenario_d
printf '%s\n' "${RESULTS[@]}"
for r in "${RESULTS[@]}"; do [ "${r#* }" = pass ] || exit 1; done
