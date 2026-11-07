import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
export const ASSETS_DIR = path.join(ROOT, "assets");
export const FONTS_DIR = path.join(ASSETS_DIR, "fonts");
export const MUSIC_DIR = path.join(ASSETS_DIR, "music");

/** Loads a KEY=value .env file into process.env without overriding existing values. */
export function loadDotEnv(file = path.join(ROOT, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

/** config.json by default; SHORTS_CONFIG=config.facts.json switches profile. */
export function loadConfig() {
  const file = path.resolve(ROOT, (process.env.SHORTS_CONFIG || "config.json").trim());
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.mode = cfg.mode || "facts";
  if (!Array.isArray(cfg.categories) || !cfg.categories.length) throw new Error("config.json: categories is empty");
  if (!Array.isArray(cfg.formats) || !cfg.formats.length) throw new Error("config.json: formats is empty");
  return cfg;
}

export const env = (k, fallback = "") => (process.env[k] || fallback).trim();
export const MOCK = () => env("SHORTS_MOCK") === "1";
