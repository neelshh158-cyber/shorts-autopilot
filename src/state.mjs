// history.json: one entry per attempted video. performance.json: learned
// scores per category and format, rebuilt from history by analytics.mjs.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.mjs";

const HISTORY = path.join(DATA_DIR, "history.json");
const PERF = path.join(DATA_DIR, "performance.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function readHistory() {
  const h = readJson(HISTORY, []);
  return Array.isArray(h) ? h : [];
}

export function writeHistory(entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY, JSON.stringify(entries, null, 2) + "\n");
}

export function appendHistory(entry) {
  const all = readHistory();
  all.push(entry);
  writeHistory(all);
  return entry;
}

export function updateHistory(id, patch) {
  const all = readHistory();
  const i = all.findIndex((e) => e.id === id);
  if (i < 0) return null;
  all[i] = { ...all[i], ...patch };
  writeHistory(all);
  return all[i];
}

export function readPerformance() {
  const p = readJson(PERF, {});
  return p && typeof p === "object" ? p : {};
}

export function writePerformance(perf) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PERF, JSON.stringify(perf, null, 2) + "\n");
}

export function newId() {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
