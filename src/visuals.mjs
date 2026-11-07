// Footage for each segment of the video, best source first:
//   1. Pexels or Pixabay stock video (free, licensed for commercial use)
//   2. Cloudflare Workers AI generated image, slow zoom (Ken Burns)
//   3. Animated gradient (always works, no network)
// Each segment falls back on its own, so one missing clip never kills a run.
import fs from "node:fs";
import path from "node:path";
import { env, MOCK } from "./config.mjs";
import { log } from "./log.mjs";
import { geminiCandidates, modelHintFromError } from "./models.mjs";

const GRADIENTS = [
  ["0x1b1b3a", "0x3a1c5c", "0x0f2c4e"],
  ["0x0b2545", "0x13315c", "0x1c6e8c"],
  ["0x2d0a31", "0x6a0572", "0xab2567"],
  ["0x0a2e36", "0x14746f", "0x2a9d8f"],
  ["0x3b1f0f", "0x7a3b12", "0xc2571a"],
  ["0x101820", "0x1f3a5f", "0x3d5a80"],
];

// Bright pastels for the kids' profile.
const BRIGHT = [
  ["0xffd166", "0xff9f1c", "0xffe8a3"],
  ["0x8ecae6", "0x219ebc", "0xbde0fe"],
  ["0xb5e48c", "0x76c893", "0xd9ed92"],
  ["0xffafcc", "0xffc8dd", "0xcdb4db"],
  ["0xa0c4ff", "0xbdb2ff", "0xcaffbf"],
];

export function gradientSpec(index, bright = false) {
  const list = bright ? BRIGHT : GRADIENTS;
  return list[index % list.length];
}

/**
 * Groups aligned lines into visual segments at least `minSeconds` long, so
 * clips don't flash by. Each segment keeps the search query of its first line.
 */
export function planSegments(lines, { minSeconds = 2.4, tail = 0.6 } = {}) {
  const segs = [];
  let cur = null;
  for (const l of lines) {
    if (!cur) cur = { start: l.start, end: l.end, query: l.visual, text: l.text };
    else {
      cur.end = l.end;
      cur.text += " " + l.text;
    }
    if (cur.end - cur.start >= minSeconds) {
      segs.push(cur);
      cur = null;
    }
  }
  if (cur) {
    if (segs.length) segs[segs.length - 1].end = cur.end;
    else segs.push(cur);
  }
  if (segs.length) segs[segs.length - 1].end += tail;
  return segs.map((s) => ({ ...s, duration: +(s.end - s.start).toFixed(3) }));
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function pexelsClip(query, used, outFile) {
  const key = env("PEXELS_API_KEY");
  if (!key || !query) return null;
  const tries = [
    { q: query, orientation: "portrait" },
    { q: query, orientation: "" },
    { q: query.split(" ").slice(0, 2).join(" "), orientation: "portrait" },
  ];
  for (const t of tries) {
    const url = new URL("https://api.pexels.com/videos/search");
    url.searchParams.set("query", t.q);
    url.searchParams.set("per_page", "10");
    url.searchParams.set("size", "medium");
    if (t.orientation) url.searchParams.set("orientation", t.orientation);
    const res = await fetch(url, { headers: { Authorization: key }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      log(`Pexels ${res.status} for "${t.q}"`);
      if (res.status === 401 || res.status === 429) return null;
      continue;
    }
    const body = await res.json();
    const videos = (body.videos || []).filter((v) => !used.has(v.id) && v.duration >= 3);
    for (const v of videos) {
      const files = (v.video_files || []).filter((f) => /mp4/i.test(f.file_type || "") && f.link);
      // Prefer an HD portrait file; otherwise the largest that isn't 4K.
      const ranked = files
        .map((f) => ({ f, portrait: f.height > f.width, score: (f.height > f.width ? 1000 : 0) + (f.height >= 1280 && f.height <= 2160 ? 500 : 0) - Math.abs((f.height || 0) - 1920) / 10 }))
        .sort((a, b) => b.score - a.score);
      const pick = ranked[0]?.f;
      if (!pick) continue;
      try {
        const dl = await fetch(pick.link, { signal: AbortSignal.timeout(90_000) });
        if (!dl.ok) continue;
        fs.writeFileSync(outFile, Buffer.from(await dl.arrayBuffer()));
        used.add(v.id);
        return { kind: "video", path: outFile, source: `pexels:${v.id}`, portrait: pick.height > pick.width };
      } catch (e) {
        log(`Pexels download failed: ${e.message}`);
      }
    }
  }
  return null;
}

async function pixabayClip(query, used, outFile) {
  const key = env("PIXABAY_API_KEY");
  if (!key || !query) return null;
  const tries = [query, query.split(" ").slice(0, 2).join(" ")].filter((q, i, a) => q && a.indexOf(q) === i);
  for (const q of tries) {
    const url = new URL("https://pixabay.com/api/videos/");
    url.searchParams.set("key", key);
    url.searchParams.set("q", q.slice(0, 100));
    url.searchParams.set("per_page", "20");
    url.searchParams.set("safesearch", "true");
    url.searchParams.set("video_type", "film");
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      log(`Pixabay ${res.status} for "${q}"`);
      if (res.status === 400 || res.status === 429) return null;
      continue;
    }
    const body = await res.json();
    const hits = (body.hits || []).filter((h) => !used.has(h.id) && h.duration >= 3);
    // Portrait clips first, then the rest; Pixabay has no orientation filter.
    const ranked = hits
      .map((h) => {
        const f = h.videos?.large?.url ? h.videos.large : h.videos?.medium;
        if (!f?.url) return null;
        return { h, f, score: (f.height > f.width ? 1000 : 0) + (f.height >= 1080 ? 300 : 0) };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    for (const { h, f } of ranked) {
      try {
        const dl = await fetch(f.url, { signal: AbortSignal.timeout(90_000) });
        if (!dl.ok) continue;
        fs.writeFileSync(outFile, Buffer.from(await dl.arrayBuffer()));
        used.add(h.id);
        return { kind: "video", path: outFile, source: `pixabay:${h.id}`, portrait: f.height > f.width };
      } catch (e) {
        log(`Pixabay download failed: ${e.message}`);
      }
    }
  }
  return null;
}

async function stockClip(query, used, outFile) {
  const a = await pexelsClip(query, used, outFile).catch((e) => (log(`Pexels error: ${e.message}`), null));
  if (a) return a;
  return pixabayClip(query, used, outFile).catch((e) => (log(`Pixabay error: ${e.message}`), null));
}

const CF_MODELS = [env("CLOUDFLARE_IMAGE_MODEL"), "@cf/black-forest-labs/flux-1-schnell", "@cf/stabilityai/stable-diffusion-xl-base-1.0"].filter(Boolean);

async function cloudflareImage(prompt, outFile) {
  const account = env("CLOUDFLARE_ACCOUNT_ID");
  const token = env("CLOUDFLARE_AI_TOKEN");
  if (!account || !token || !prompt) return null;
  const full = `${prompt}, vertical composition, cinematic lighting, photorealistic, high detail, no text, no watermark, no people's faces close up`;
  for (const model of CF_MODELS) {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: full }),
        signal: AbortSignal.timeout(60_000),
      });
      const ct = res.headers.get("content-type") || "";
      if (res.ok && ct.startsWith("image/")) {
        fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
        return { kind: "image", path: outFile, source: `cloudflare:${model}` };
      }
      const body = await res.json().catch(() => null);
      const b64 = body?.result?.image;
      if (res.ok && typeof b64 === "string" && b64) {
        fs.writeFileSync(outFile, Buffer.from(b64, "base64"));
        return { kind: "image", path: outFile, source: `cloudflare:${model}` };
      }
      log(`Cloudflare ${model}: ${body?.errors?.[0]?.message || res.status}`);
    } catch (e) {
      log(`Cloudflare ${model}: ${e.message}`);
    }
  }
  return null;
}

async function pollinationsImage(prompt, outFile, { width = 768, height = 1344 } = {}) {
  const seed = Math.floor(Math.random() * 1e9);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 900))}?width=${width}&height=${height}&nologo=true&seed=${seed}&model=flux`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { "User-Agent": "Mozilla/5.0" } });
  const ct = res.headers.get("content-type") || "";
  if (!res.ok || !ct.startsWith("image/")) throw new Error(`Pollinations ${res.status} ${ct}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 5000) throw new Error("Pollinations returned an empty image");
  fs.writeFileSync(outFile, buf);
  return { kind: "image", path: outFile, source: "pollinations" };
}

let geminiImageDead = false;
async function geminiImage(prompt, outFile) {
  const key = env("GEMINI_API_KEY");
  if (!key || geminiImageDead) return null;
  const models = await geminiCandidates("image");
  let lastErr = "";
  for (let i = 0; i < models.length && i < 6; i++) {
    const model = models[i];
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Generate a single vertical 9:16 image. ${prompt}` }] }],
        generationConfig: { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: "9:16" } },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json().catch(() => null);
    if (res.ok) {
      const part = body?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (part) {
        fs.writeFileSync(outFile, Buffer.from(part.inlineData.data, "base64"));
        return { kind: "image", path: outFile, source: `gemini:${model}` };
      }
      lastErr = "Gemini image: no image in response";
      continue;
    }
    lastErr = body?.error?.message || `Gemini image ${res.status}`;
    log(`Gemini image ${model}: ${lastErr.slice(0, 140)}`);
    if (res.status === 429) {
      geminiImageDead = true; // quota for the day: stop asking
      break;
    }
    const hint = modelHintFromError(lastErr);
    if (hint && !models.includes(hint)) models.splice(i + 1, 0, hint);
  }
  return null;
}

let pollinationsDead = false;

/**
 * AI picture for a scene. Order: Cloudflare Workers AI (free tier, needs the
 * account keys), Gemini image model (free tier), Pollinations (was free, now
 * answers 402 for anonymous use; kept in case that changes).
 */
export async function aiImage(prompt, outFile) {
  const cf = await cloudflareImage(prompt, outFile).catch((e) => (log(`Cloudflare image: ${e.message}`), null));
  if (cf) return cf;
  const gm = await geminiImage(prompt, outFile).catch((e) => (log(`Gemini image: ${e.message}`), null));
  if (gm) return gm;
  if (pollinationsDead) return null;
  try {
    return await pollinationsImage(prompt, outFile);
  } catch (e) {
    log(`Pollinations: ${e.message}`);
    if (/402|401|403/.test(e.message)) pollinationsDead = true;
    return null;
  }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const MOTIONS = ["zoom_in", "pan_right", "zoom_out", "pan_left", "drift_up"];

/**
 * Fills each segment with a visual. Mutates and returns the segments.
 * opts.mode "ai-image": every scene is a generated cartoon picture (rhymes).
 * default: stock video first, AI image second, gradient last (facts).
 */
export async function fetchVisuals(segments, workDir, { keywords = [], mode = "stock", stylePrefix = "", characters = "", setting = "" } = {}) {
  const used = new Set();
  const fallbackQuery = slug(keywords.join(" "));
  const start = Math.floor(Math.random() * MOTIONS.length);
  segments.forEach((seg, i) => (seg.motion = MOTIONS[(start + i) % MOTIONS.length]));

  if (mode === "ai-image") {
    await pool(segments, 2, async (seg, i) => {
      const prompt = [stylePrefix, characters && `Characters: ${characters}`, setting && `Setting: ${setting}`, `Scene: ${seg.query || seg.text}`].filter(Boolean).join(". ");
      let visual = null;
      if (!MOCK()) {
        visual = await aiImage(prompt, path.join(workDir, `seg${i}.jpg`));
        if (!visual) visual = await aiImage(prompt, path.join(workDir, `seg${i}.jpg`)); // one retry, new seed
      }
      if (!visual) visual = { kind: "gradient", colors: gradientSpec(i, true), source: "gradient" };
      Object.assign(seg, visual);
      log(`scene ${i + 1}/${segments.length} ${seg.duration.toFixed(1)}s -> ${seg.source} (${seg.motion})`);
    });
    return segments;
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const q = slug(seg.query || "") || fallbackQuery;
    let visual = null;
    if (!MOCK()) {
      visual = await stockClip(q, used, path.join(workDir, `seg${i}.mp4`));
      if (!visual && fallbackQuery && q !== fallbackQuery) visual = await stockClip(fallbackQuery, used, path.join(workDir, `seg${i}.mp4`));
      if (!visual) visual = await cloudflareImage(seg.query || fallbackQuery, path.join(workDir, `seg${i}.jpg`)).catch(() => null);
    }
    if (!visual) visual = { kind: "gradient", colors: gradientSpec(i), source: "gradient" };
    Object.assign(seg, visual);
    log(`segment ${i + 1}/${segments.length} ${seg.duration.toFixed(1)}s "${q}" -> ${seg.source}`);
  }
  return segments;
}
