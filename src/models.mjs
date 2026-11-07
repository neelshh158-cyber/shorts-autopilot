// Model names change under us (a run in Oct 2026 found llama-3.3-70b gone and
// Gemini 2.x retired). Instead of hard-coding, ask each provider what it has
// and pick the best match, with hints from error messages as a fast path.
import { env } from "./config.mjs";
import { log } from "./log.mjs";

const cache = {};

const versionOf = (name) => {
  const m = /(\d+(?:\.\d+)?)/.exec(name.replace(/^.*?gemini-/, ""));
  return m ? parseFloat(m[1]) : 0;
};

/** "Please update your code to use models/gemini-3.8-flash" -> "gemini-3.8-flash" */
export function modelHintFromError(message) {
  const m = /use (?:models\/)?([a-z0-9][a-z0-9.\-_/]+)/i.exec(String(message || ""));
  return m ? m[1].replace(/[.,;:]+$/, "") : null;
}

export async function listGeminiModels() {
  if (cache.gemini) return cache.gemini;
  const key = env("GEMINI_API_KEY");
  if (!key) return (cache.gemini = []);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`, { signal: AbortSignal.timeout(20_000) });
    const body = await res.json().catch(() => null);
    const models = (body?.models || []).map((m) => ({
      name: String(m.name || "").replace(/^models\//, ""),
      methods: m.supportedGenerationMethods || [],
    }));
    cache.gemini = models;
  } catch (e) {
    log(`gemini model list unavailable: ${e.message}`);
    cache.gemini = [];
  }
  return cache.gemini;
}

/** Pure: ranks Gemini model names for a job. kind "text" or "tts". */
export function rankGeminiModels(models, kind) {
  const names = models.map((m) => (typeof m === "string" ? { name: m, methods: ["generateContent"] } : m));
  const usable = names.filter((m) => !m.methods.length || m.methods.includes("generateContent"));
  const isTts = (n) => /tts/i.test(n);
  const isImage = (n) => /flash-image|image-preview|-image\b|image-generation/i.test(n) && !/imagen/i.test(n);
  const junk = (n) => /embedding|imagen|veo|live|audio-dialog|native-audio|computer-use|robotics|aqa|learnlm|gemma/i.test(n);
  let list = usable.map((m) => m.name).filter((n) => !junk(n));
  if (kind === "tts") list = list.filter(isTts);
  else if (kind === "image") list = list.filter(isImage);
  else list = list.filter((n) => !isTts(n) && !isImage(n) && !/thinking|exp|deep-research|lite-preview/i.test(n));
  const score = (n) => versionOf(n) * 100 + (/flash/i.test(n) ? 20 : 0) + (/-lite/i.test(n) ? -8 : 0) + (/latest/i.test(n) ? 5 : 0) + (/preview|exp/i.test(n) ? -3 : 0) + (/pro/i.test(n) ? 10 : 0);
  return [...new Set(list)].sort((a, b) => score(b) - score(a));
}

const GEMINI_TEXT_DEFAULTS = ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-flash-latest"];
const GEMINI_TTS_DEFAULTS = ["gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"];
const GEMINI_IMAGE_DEFAULTS = ["gemini-2.5-flash-image", "gemini-2.5-flash-image-preview"];

/** Candidate list: env override, discovered models (best first), then defaults. */
export async function geminiCandidates(kind) {
  const override = env(kind === "tts" ? "GEMINI_TTS_MODEL" : kind === "image" ? "GEMINI_IMAGE_MODEL" : "GEMINI_MODEL");
  const discovered = rankGeminiModels(await listGeminiModels(), kind).slice(0, 4);
  const defaults = kind === "tts" ? GEMINI_TTS_DEFAULTS : kind === "image" ? GEMINI_IMAGE_DEFAULTS : GEMINI_TEXT_DEFAULTS;
  return [...new Set([override, ...discovered, ...defaults].filter(Boolean))];
}

export async function listGroqModels() {
  if (cache.groq) return cache.groq;
  const key = env("GROQ_API_KEY");
  if (!key) return (cache.groq = []);
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    const body = await res.json().catch(() => null);
    cache.groq = (body?.data || []).filter((m) => m.active !== false).map((m) => String(m.id));
  } catch (e) {
    log(`groq model list unavailable: ${e.message}`);
    cache.groq = [];
  }
  return cache.groq;
}

/** Pure: ranks Groq chat models. Big general models first, never audio/guard/tts. */
export function rankGroqChatModels(ids) {
  const bad = /whisper|tts|guard|embed|vision|safeguard|prompt-guard|orpheus|playai/i;
  const score = (id) => {
    let s = 0;
    if (/gpt-oss-120b/i.test(id)) s += 100;
    else if (/gpt-oss/i.test(id)) s += 80;
    if (/llama-4|maverick/i.test(id)) s += 70;
    if (/llama-3\.3-70b/i.test(id)) s += 65;
    if (/qwen3|qwen-3/i.test(id)) s += 60;
    if (/deepseek|kimi|moonshot/i.test(id)) s += 50;
    if (/versatile/i.test(id)) s += 5;
    if (/\b70b|120b|235b|405b\b/i.test(id)) s += 10;
    if (/8b|1b|3b|instant|mini|scout/i.test(id)) s -= 10;
    if (/compound|agent|allam|preview/i.test(id)) s -= 5;
    return s;
  };
  return [...new Set(ids.filter((id) => !bad.test(id)))].sort((a, b) => score(b) - score(a));
}

const GROQ_DEFAULTS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile"];

export async function groqCandidates() {
  const override = env("GROQ_MODEL");
  const discovered = rankGroqChatModels(await listGroqModels()).slice(0, 4);
  return [...new Set([override, ...discovered, ...GROQ_DEFAULTS].filter(Boolean))];
}

export async function groqWhisperCandidates() {
  const ids = await listGroqModels();
  const found = ids.filter((id) => /whisper/i.test(id)).sort((a, b) => (/turbo/i.test(a) ? 1 : 0) - (/turbo/i.test(b) ? 1 : 0));
  return [...new Set([env("GROQ_WHISPER_MODEL"), ...found, "whisper-large-v3", "whisper-large-v3-turbo"].filter(Boolean))];
}
