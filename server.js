// src/server.js
// LibreChat-compatible Code Interpreter API, backed by Pyodide.
// Endpoints and schemas mirror what LibreChat's client calls:
//   POST /exec, POST /upload, POST /upload/batch,
//   GET /files/:session_id, GET /download/:session_id/:file_id, GET /health

import express from "express";
import multer from "multer";
import crypto from "node:crypto";

import { exec as runInSession } from "./sessions.js";
import * as storage from "./storage.js";

const app = express();
app.use(express.json({ limit: "25mb" }));
const upload = multer({ storage: multer.memoryStorage() });

const MASTER_KEY = process.env.MASTER_KEY || "";
const PORT = parseInt(process.env.PORT || "8000", 10);

// --- Auth: x-api-key header, matching LibreChat's contract -----------------
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const key = req.get("x-api-key");
  if (!MASTER_KEY || key !== MASTER_KEY) {
    return res.status(401).json({ error: "API key required in x-api-key header." });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// --- POST /exec ------------------------------------------------------------
app.post("/exec", async (req, res) => {
  const { code, lang, session_id, files = [], timeout } = req.body || {};

  if (typeof code !== "string") {
    return res.status(422).json({ error: "Field 'code' (string) is required." });
  }
  // This backend is Python-only (Pyodide). Reject other languages clearly.
  if (lang && !["py", "python"].includes(String(lang).toLowerCase())) {
    return res.status(422).json({
      error: `This interpreter only supports Python (lang=py). Received lang='${lang}'.`,
    });
  }

  const sid = session_id || crypto.randomUUID();

  // Resolve referenced files from storage and hand them to the worker.
  const inputFiles = [];
  for (const f of files) {
    const stored = storage.read(f.session_id || f.storage_session_id || sid, f.id);
    if (stored) inputFiles.push({ name: stored.name, b64: stored.buffer.toString("base64") });
  }

  // Keepalive: stream whitespace until the result is ready, then the JSON body.
  // JSON parsers ignore leading whitespace, so LibreChat reads this fine.
  res.set("Content-Type", "application/json");
  const keepalive = setInterval(() => { try { res.write(" "); } catch (_) {} }, 3000);

  try {
    const result = await runInSession(sid, code, inputFiles, timeout);

    const fileRefs = [];
    for (const g of result.files || []) {
      const buf = Buffer.from(g.b64, "base64");
      fileRefs.push(storage.save(sid, g.name, buf));
    }

    clearInterval(keepalive);
    res.end(JSON.stringify({
      session_id: sid,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      files: fileRefs,
    }));
  } catch (e) {
    clearInterval(keepalive);
    res.end(JSON.stringify({
      session_id: sid,
      stdout: "",
      stderr: String(e.message || e),
      files: [],
    }));
  }
});

// --- POST /upload and /upload/batch ---------------------------------------
function handleUpload(req, res) {
  const session = req.body.session_id || req.query.session_id || crypto.randomUUID();
  const incoming = [
    ...(req.files || []),
    ...(req.file ? [req.file] : []),
  ];
  const saved = incoming.map((f) =>
    storage.save(session, f.originalname, f.buffer)
  );
  res.json({ session_id: session, files: saved });
}

app.post("/upload", upload.any(), handleUpload);
app.post("/upload/batch", upload.any(), handleUpload);

// --- GET /files/:session_id -----------------------------------------------
app.get("/files/:session_id", (req, res) => {
  res.json(storage.list(req.params.session_id));
});

// --- GET /download/:session_id/:file_id -----------------------------------
app.get("/download/:session_id/:file_id", (req, res) => {
  const file = storage.read(req.params.session_id, req.params.file_id);
  if (!file) return res.status(404).json({ error: "File not found" });
  const encoded = encodeURIComponent(file.name);
  res.set(
    "Content-Disposition",
    `attachment; filename="${file.name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encoded}`
  );
  res.set("Content-Type", "application/octet-stream");
  res.send(file.buffer);
});

app.listen(PORT, "::", () => {
  console.log(`lc-pyodide-interpreter listening on :: port ${PORT}`);
});
