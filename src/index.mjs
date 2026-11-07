#!/usr/bin/env node
// Entry point.
//   node src/index.mjs run [--no-upload] [--category=key] [--format=key] [--publish-at=ISO]
//   node src/index.mjs analytics
//   node src/index.mjs plan
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadConfig, loadDotEnv, MOCK } from "./config.mjs";
import { log, step } from "./log.mjs";
import { readHistory, readPerformance, appendHistory, newId } from "./state.mjs";
import { pickPlan } from "./topics.mjs";
import { writeScript, spokenLines } from "./script.mjs";
import { synthesize, alignLines, fitTimingsToScript } from "./tts.mjs";
import { buildAss } from "./captions.mjs";
import { planSegments, fetchVisuals } from "./visuals.mjs";
import { renderVideo, chooseMusic } from "./render.mjs";
import { uploadVideo, cleanTitle, buildDescription, hasYouTubeCreds } from "./youtube.mjs";
import { refreshAnalytics } from "./analytics.mjs";
import { fetchTrendingIndia, trendsAsSeeds } from "./trends.mjs";

function parseArgs(argv) {
  const out = { command: "run", upload: true, keep: false };
  for (const a of argv) {
    if (!a.startsWith("--")) out.command = a;
    else if (a === "--no-upload") out.upload = false;
    else if (a === "--keep") out.keep = true;
    else {
      const [k, v = "true"] = a.slice(2).split("=");
      out[k] = v;
    }
  }
  return out;
}

async function run(args) {
  let cfg = loadConfig();
  const mock = MOCK();
  const wantUpload = args.upload && !mock;
  if (wantUpload && !hasYouTubeCreds()) throw new Error("Upload requested but YouTube credentials are missing. Set YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN or pass --no-upload.");

  // Learn from the latest numbers before choosing what to make.
  if (wantUpload) await step("refresh analytics", () => refreshAnalytics(cfg).catch((e) => log(`analytics skipped: ${e.message}`)));

  const history = readHistory();
  const scores = readPerformance();
  const plan = pickPlan(cfg, scores, history);
  if (args.category) plan.category = cfg.categories.find((c) => c.key === args.category) || plan.category;
  if (args.format) plan.format = cfg.formats.find((f) => f.key === args.format) || plan.format;
  if (plan.category.dynamic === "google-trends" && !mock) {
    const trends = await step("fetch trends", () => fetchTrendingIndia());
    if (trends.length >= 3) {
      plan.trending = true;
      plan.freshSeeds = trendsAsSeeds(trends);
    } else {
      // Nothing usable today: fall back to a normal category.
      const fallback = pickPlan({ ...cfg, categories: cfg.categories.filter((c) => !c.dynamic) }, scores, history);
      plan.category = fallback.category;
      plan.freshSeeds = fallback.freshSeeds;
      log("trends empty, falling back to " + plan.category.key);
    }
  } else if (plan.category.dynamic) {
    plan.category = cfg.categories.find((c) => !c.dynamic) || plan.category;
  }
  log(`plan: ${plan.category.key} / ${plan.format.key}${plan.explored ? " (exploring)" : ""}`);

  // A category may override the language (e.g. Hindi rhymes on an English channel).
  const lang = plan.category.language || cfg.channel.language || "hi";
  if (lang !== cfg.channel.language) cfg = { ...cfg, channel: { ...cfg.channel, language: lang } };

  const id = newId();
  const work = path.join(ROOT, "out", id);
  fs.mkdirSync(work, { recursive: true });

  // Spoken words per second at the configured pace (Hindi facts ~2.6, slow rhymes ~2.0).
  const wps = cfg.video.wordsPerSecond || 2.6;
  let maxWords = Math.round(cfg.video.targetSeconds * wps * 1.15);
  let minWords = Math.round(cfg.video.targetSeconds * wps * 0.7);
  let rate = cfg.channel.voiceRate || "+0%";

  let script, voice, lines;
  for (let pass = 1; pass <= 3; pass++) {
    script = await step(`write script (max ${maxWords} words)`, () => writeScript({ cfg, plan, maxWords, minWords, lang }));
    log(`topic: ${script.topic}`);
    log(`hook: ${script.hook}`);
    lines = spokenLines(script);
    const text = lines.map((l) => l.text).join("\n");
    fs.writeFileSync(path.join(work, "script.json"), JSON.stringify(script, null, 2));
    voice = await step("voice", () => synthesize(text, work, { cfg, rate }));
    if (voice.repeated) voice = await step("voice (retry, first take repeated itself)", () => synthesize(text, work, { cfg, rate }));
    log(`voice: ${voice.duration.toFixed(1)}s, ${voice.words.length} words (${voice.provider}, timings: ${voice.timing})`);
    if (voice.duration <= cfg.video.maxSeconds) break;
    if (pass === 1) {
      rate = "+22%";
      log("too long, speaking faster");
      voice = await step("voice (faster)", () => synthesize(text, work, { cfg, rate }));
      if (voice.duration <= cfg.video.maxSeconds) break;
    }
    const ratio = cfg.video.targetSeconds / voice.duration;
    maxWords = Math.max(40, Math.round(script.wordCount * ratio));
    minWords = Math.round(maxWords * 0.7);
    log(`still ${voice.duration.toFixed(1)}s, rewriting shorter`);
  }
  if (voice.duration > cfg.video.maxSeconds) throw new Error(`voice is ${voice.duration.toFixed(1)}s, over the ${cfg.video.maxSeconds}s limit`);

  const aligned = alignLines(lines, voice.words, voice.duration);
  const words = fitTimingsToScript(voice.words, lines.map((l) => l.text).join(" "));
  const assPath = path.join(work, "captions.ass");
  const tail = 0.6;
  fs.writeFileSync(
    assPath,
    buildAss({ words, cfg, lang: cfg.channel.language, width: cfg.video.width, height: cfg.video.height, title: script.onscreenTitle, duration: voice.duration + tail })
  );

  const segments = planSegments(aligned, { minSeconds: cfg.video.minSegmentSeconds, tail });
  await step(cfg.visuals?.source === "ai-image" ? "draw scenes" : "footage", () =>
    fetchVisuals(segments, work, {
      keywords: script.keywords,
      mode: cfg.visuals?.source || "stock",
      stylePrefix: cfg.visuals?.stylePrefix || "",
      characters: script.characters || "",
      setting: script.setting || "",
    })
  );

  const outFile = path.join(ROOT, "out", `${id}.mp4`);
  const totalDuration = voice.duration + tail;
  await step("render", () =>
    renderVideo({ segments, audioPath: voice.audioPath, assPath, musicPath: chooseMusic(cfg, work, totalDuration), outFile, cfg, totalDuration })
  );
  log(`video: ${outFile} (${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB, ${totalDuration.toFixed(1)}s)`);

  const title = cleanTitle(script.title, cfg.publish?.titleSuffix || "");
  const description = buildDescription(script, cfg);
  const entry = {
    id,
    date: new Date().toISOString(),
    topic: script.topic,
    mode: cfg.mode,
    language: lang,
    category: plan.category.key,
    format: plan.format.key,
    title,
    hook: script.hook,
    lines: lines.map((l) => l.text),
    onscreenTitle: script.onscreenTitle,
    trending: !!plan.trending,
    words: script.wordCount,
    seconds: +totalDuration.toFixed(1),
    voice: voice.provider,
    footage: segments.map((s) => s.source),
    status: "rendered",
  };

  if (wantUpload) {
    const up = await step("upload to YouTube", () =>
      uploadVideo({ file: outFile, title, description, tags: script.tags, cfg, publishAt: args["publish-at"] })
    );
    Object.assign(entry, { status: "uploaded", videoId: up.videoId, url: up.url, privacy: up.privacy });
  } else {
    log(`upload skipped (${mock ? "mock mode" : "--no-upload"}). Title would be: ${title}`);
  }
  appendHistory(entry);
  if (!args.keep) fs.rmSync(work, { recursive: true, force: true });
  log(`done: ${entry.status} ${entry.url || outFile}`);
  return entry;
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "run") return run(args);
  if (args.command === "analytics") return refreshAnalytics(loadConfig());
  if (args.command === "plan") {
    const cfg = loadConfig();
    const plan = pickPlan(cfg, readPerformance(), readHistory());
    console.log(JSON.stringify({ category: plan.category.key, format: plan.format.key, explored: plan.explored, freshSeeds: plan.freshSeeds }, null, 2));
    return;
  }
  throw new Error(`unknown command "${args.command}" (use run, analytics or plan)`);
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`);
  process.exit(1);
});
