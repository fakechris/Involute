# User Testing

**What belongs here:** Testing surface, tools, setup, concurrency limits.

---

## Validation Surface

### 1. GraphQL API (port 4200)
- **Tool:** curl
- **Setup:** Start API server (`cd packages/server && PORT=4200 node dist/index.js`)
- **Auth:** Include `Authorization: Bearer involute-dev-token-001` header
- **Endpoint:** `POST http://localhost:4200/graphql` with `Content-Type: application/json`

### 2. Web UI (port 4201)
- **Tool:** agent-browser
- **Setup:** Start API server first, then web dev server (`cd packages/web && PORT=4201 npx vite --port 4201`)
- **Entry point:** `http://localhost:4201`
- **Prerequisite:** API server must be running and healthy

### 3. CLI
- **Tool:** terminal commands (Execute tool)
- **Setup:** Build CLI package, then run commands directly
- **Config:** Must set server-url and token before running data commands
- **Binary:** `node packages/cli/dist/index.js` or via pnpm script

## Validation Concurrency

- **Machine:** 32 GB RAM, 10 CPU cores
- **Baseline usage:** ~20 GB used, ~12 GB reclaimable
- **Headroom (70%):** ~8.4 GB

### Per-surface limits:
- **curl (API):** 5 concurrent validators (minimal resource usage)
- **agent-browser (Web):** 4 concurrent validators (~500 MB each: 300 MB Chromium + 200 MB shared dev server)
- **CLI:** 5 concurrent validators (minimal resource usage)

## Test Data Strategy

- Seed data provides baseline (1 team, 6 states, 10+ labels, 1 user)
- Tests should create their own issues/comments for isolation
- Import tests need fixture data (mock Linear export files) or actual Linear API access
