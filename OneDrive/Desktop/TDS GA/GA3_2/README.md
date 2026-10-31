# Mailroom agent

Zero-dependency Node service (`node src/server.js`). POST `/` handles `propose` and `commit`.

Render: New Web Service from this repo (uses `render.yaml`). Set env vars:
- `LLM_API_KEY` (required), `LLM_BASE_URL` (any OpenAI-compatible API), `LLM_MODEL`
- `DATA_DIR` – point at a Render persistent disk (e.g. `/var/data`) so decisions/receipts survive restarts.

`npm test` runs an offline smoke test (validation, replay, 409, receipt checks) with no model call.

Render free plan (no persistent disk): create a free Upstash Redis database and set
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; state is written through to it.
Free instances sleep after 15 min idle, so wake with GET /health before each Check.
