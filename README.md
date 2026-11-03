# task-management

A small Task Management API, built by AI agents through
[The Gibson](https://github.com/The-AIE/the-gibson).
[FINOS](https://www.finos.org/) controls are planned (not yet in place).

## Requirements

- Node.js 22.18 or later

## Setup (once per clone)

    npm ci
    git config core.hooksPath .githooks   # enforces Signed-off-by on every commit

## Run the checks (the green gate)

    npm run typecheck
    npm run lint
    npm test
    npm run build