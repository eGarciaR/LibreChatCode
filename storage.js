// src/storage.js
// Minimal local-disk storage for files, keyed by session_id/file_id.
// Good enough for a PoC. For the pilot, back this with a Railway volume
// (set DATA_DIR to the mounted volume path) or swap for S3-compatible storage.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.DATA_DIR || "/data/files";
fs.mkdirSync(DATA_DIR, { recursive: true });

const meta = new Map(); // `${session}/${id}` -> { name, size }

function sessionDir(session) {
  const dir = path.join(DATA_DIR, session);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function save(session, name, buffer) {
  const id = crypto.randomUUID();
  const dir = sessionDir(session);
  fs.writeFileSync(path.join(dir, id), buffer);
  meta.set(`${session}/${id}`, { name, size: buffer.length });
  return { id, name, session_id: session };
}

export function list(session) {
  const out = [];
  for (const [key, info] of meta) {
    const [s, id] = key.split("/");
    if (s === session) out.push({ id, name: info.name, session_id: session });
  }
  return out;
}

export function read(session, id) {
  const info = meta.get(`${session}/${id}`);
  if (!info) return null;
  const file = path.join(DATA_DIR, session, id);
  if (!fs.existsSync(file)) return null;
  return { name: info.name, buffer: fs.readFileSync(file) };
}
