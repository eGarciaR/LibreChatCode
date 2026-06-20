# lc-pyodide-interpreter

A LibreChat-compatible Code Interpreter API that executes **Python via Pyodide
(WebAssembly)**. Because the sandbox is the WASM runtime (user space), it needs
**no privileged container and no kernel capabilities**, so it runs on Railway
where nsjail-based interpreters cannot.

It implements the endpoints LibreChat calls: `POST /exec`, `POST /upload`,
`POST /upload/batch`, `GET /files/:session_id`, `GET /download/:session_id/:file_id`,
and `GET /health`, with `x-api-key` auth.

## What it supports

- Python only. Preloaded: `numpy`, `pandas`, `matplotlib` (add more in
  `src/worker.js` via `loadPackage`, limited to Pyodide's package set).
- Stateful sessions: variables persist across executions in the same `session_id`
  (one warm Pyodide REPL per session, in a worker thread).
- File upload/download and detection of files created in the working dir
  (e.g. `df.to_csv("out.csv")`, `plt.savefig("plot.png")`).
- Timeout enforcement by terminating the session worker.

## Known limits (be honest with your reviewers)

- No `subprocess`, no native binaries beyond Pyodide wheels, no arbitrary `pip`.
- Each active session holds a Pyodide instance (memory). Cap with `MAX_SESSIONS`.
- On timeout the session is killed and its state is lost (by design).
- For untrusted code this gives WASM-level isolation, not VM-level. That is the
  right trade-off on a PaaS; OS/VM isolation belongs on a host you control
  (your Docker Compose / Kubernetes phases).

## Offline / no external CDN

The npm `pyodide` package only ships the core runtime; numpy/pandas/matplotlib
would otherwise be fetched from a public CDN at runtime. To avoid any external
call, the Dockerfile downloads the **full Pyodide distribution at build time**
and serves it locally via `PYODIDE_INDEX_URL`. At runtime there are zero CDN
calls. This makes the image larger (the full dist is a few hundred MB); trim it
later by bundling only the wheels you actually use.

> Tested: core Pyodide load + Python execution were verified offline from the
> local install. The full scientific-stack bundle is a standard build-time
> download (`github.com/pyodide/pyodide/releases`) that runs during the Railway
> build; it could not be exercised inside the locked-down authoring sandbox.

## Deploy on Railway (same project as LibreChat)

1. Push this folder to a repo (or a subdirectory) and create a new **service**
   in your existing Railway project from it. Railway builds the Dockerfile.
2. Add a **Volume** to the service mounted at `/data` so files persist.
3. Set service variables:
   - `MASTER_KEY` = a strong random value (`openssl rand -hex 32`)
   - `DATA_DIR=/data/files`
4. Deploy. The service gets a private hostname like
   `lc-pyodide-interpreter.railway.internal`.

## Wire LibreChat to it

In the LibreChat service variables:

```
LIBRECHAT_CODE_API_KEY=<the same MASTER_KEY>
LIBRECHAT_CODE_BASEURL=http://lc-pyodide-interpreter.railway.internal:8000
```

Then enable the capability for your agents in `librechat.yaml`:

```yaml
endpoints:
  agents:
    capabilities:
      - "execute_code"
      - "file_search"
      - "actions"
      - "tools"
```

## Smoke test

```bash
curl -s http://localhost:8000/exec \
  -H "x-api-key: $MASTER_KEY" -H "content-type: application/json" \
  -d '{"lang":"py","code":"import pandas as pd; print(pd.DataFrame({\"a\":[1,2]}).sum().to_dict())"}'
```
