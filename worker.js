// src/worker.js
// One worker thread == one stateful session.
// Loads Pyodide once, keeps interpreter globals across executions,
// mounts uploaded files into /work, runs user code, and reports back
// stdout/stderr plus any files created or modified in /work.

import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { loadPyodide } = require("pyodide");

// Serve ALL Pyodide assets (runtime + package wheels) from a local directory,
// never a remote CDN. PYODIDE_INDEX_URL should point at an extracted full
// Pyodide distribution (see Dockerfile). Falls back to the npm package dir,
// which only carries the core runtime (packages would need the CDN).
const PYODIDE_DIR =
  process.env.PYODIDE_INDEX_URL || path.dirname(require.resolve("pyodide"));

const WORK_DIR = "/work";
let pyodide = null;
let stdoutBuf = "";
let stderrBuf = "";

async function init() {
  pyodide = await loadPyodide({ indexURL: PYODIDE_DIR });

  // Preload the scientific stack that covers the data-analysis use case.
  // Extend this list if your agents need more (e.g. "scikit-learn", "scipy").
  await pyodide.loadPackage(["numpy", "pandas", "matplotlib"]);

  pyodide.setStdout({ batched: (s) => { stdoutBuf += s + "\n"; } });
  pyodide.setStderr({ batched: (s) => { stderrBuf += s + "\n"; } });

  // Working directory + non-interactive matplotlib backend.
  pyodide.FS.mkdirTree(WORK_DIR);
  await pyodide.runPythonAsync(`
import os, matplotlib
matplotlib.use("Agg")
os.chdir("${WORK_DIR}")
`);

  parentPort.postMessage({ type: "ready" });
}

// Snapshot files in /work with their mtime so we can detect what changed.
function snapshot() {
  const seen = {};
  const walk = (dir) => {
    for (const name of pyodide.FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const full = dir + "/" + name;
      const st = pyodide.FS.stat(full);
      if (pyodide.FS.isDir(st.mode)) walk(full);
      else seen[full] = st.mtime;
    }
  };
  walk(WORK_DIR);
  return seen;
}

function readGenerated(before) {
  const after = snapshot();
  const out = [];
  for (const [full, mtime] of Object.entries(after)) {
    if (!(full in before) || before[full] !== mtime) {
      const bytes = pyodide.FS.readFile(full); // Uint8Array
      out.push({
        name: path.basename(full),
        b64: Buffer.from(bytes).toString("base64"),
      });
    }
  }
  return out;
}

async function handleExec(msg) {
  stdoutBuf = "";
  stderrBuf = "";

  // Mount uploaded files into /work before running.
  for (const f of msg.files || []) {
    const data = Buffer.from(f.b64, "base64");
    pyodide.FS.writeFile(WORK_DIR + "/" + f.name, new Uint8Array(data));
  }

  const before = snapshot();
  let error = null;
  try {
    await pyodide.runPythonAsync(msg.code);
  } catch (e) {
    error = String(e.message || e);
  }

  let generated = [];
  try {
    generated = readGenerated(before);
  } catch (e) {
    stderrBuf += `\n[file-detection error] ${e}`;
  }

  parentPort.postMessage({
    type: "result",
    reqId: msg.reqId,
    stdout: stdoutBuf,
    stderr: stderrBuf + (error ? `\n${error}` : ""),
    files: generated,
  });
}

parentPort.on("message", (msg) => {
  if (msg.type === "exec") handleExec(msg);
});

init().catch((e) => {
  parentPort.postMessage({ type: "init_error", error: String(e) });
});
