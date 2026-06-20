// src/sessions.js
// Maps a session_id to a long-lived worker (a warm, stateful Pyodide REPL).
// Enforces timeouts by terminating the worker (state is lost on timeout only).

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "worker.js");

const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "8", 10);
const IDLE_TTL_MS = parseInt(process.env.SESSION_IDLE_TTL_MS || "1800000", 10); // 30 min
const DEFAULT_TIMEOUT_MS = parseInt(process.env.DEFAULT_TIMEOUT_MS || "30000", 10);

const sessions = new Map(); // id -> { worker, ready, busy, lastUsed, pending }

function spawn(id) {
  const worker = new Worker(WORKER_PATH);
  const entry = { worker, ready: false, busy: false, lastUsed: Date.now(), pending: null };

  entry.readyPromise = new Promise((resolve, reject) => {
    worker.once("message", (m) => {
      if (m.type === "ready") { entry.ready = true; resolve(); }
      else if (m.type === "init_error") reject(new Error(m.error));
    });
    worker.once("error", reject);
  });

  worker.on("message", (m) => {
    if (m.type === "result" && entry.pending) {
      const { resolve, timer } = entry.pending;
      clearTimeout(timer);
      entry.pending = null;
      entry.busy = false;
      resolve(m);
    }
  });

  sessions.set(id, entry);
  return entry;
}

async function getOrCreate(id) {
  let entry = sessions.get(id);
  if (!entry) {
    if (sessions.size >= MAX_SESSIONS) evictOldest();
    entry = spawn(id);
    await entry.readyPromise;
  } else if (!entry.ready) {
    await entry.readyPromise;
  }
  return entry;
}

export async function exec(id, code, files, timeoutMs) {
  const entry = await getOrCreate(id);
  if (entry.busy) throw new Error("Session is busy with another execution");

  const reqId = Math.random().toString(36).slice(2);
  entry.busy = true;
  entry.lastUsed = Date.now();

  const limit = Math.min(Math.max(timeoutMs || DEFAULT_TIMEOUT_MS, 1000), 300000);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Hard kill on timeout: only way to stop a runaway sync loop in WASM.
      destroy(id);
      reject(new Error(`Execution timed out after ${limit} ms`));
    }, limit);

    entry.pending = { resolve, timer };
    entry.worker.postMessage({ type: "exec", reqId, code, files });
  });
}

function destroy(id) {
  const entry = sessions.get(id);
  if (!entry) return;
  try { entry.worker.terminate(); } catch (_) {}
  sessions.delete(id);
}

function evictOldest() {
  let oldestId = null;
  let oldest = Infinity;
  for (const [id, e] of sessions) {
    if (!e.busy && e.lastUsed < oldest) { oldest = e.lastUsed; oldestId = id; }
  }
  if (oldestId) destroy(oldestId);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, e] of sessions) {
    if (!e.busy && now - e.lastUsed > IDLE_TTL_MS) destroy(id);
  }
}, 60000).unref();
