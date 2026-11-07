// Turns the script into one voice track plus word timings for captions.
// Voice providers are tried in order (TTS_ORDER, default "edge,gemini,elevenlabs"):
//   edge        Microsoft Edge neural voices. Free, no key, gives word timings,
//               but Microsoft blocks some cloud IP ranges (GitHub Actions included).
//   gemini      Gemini 2.5 Flash TTS. Free tier, excellent Hindi. No timings.
//   elevenlabs  Paid, with timestamps. Needs ELEVENLABS_API_KEY + a voice id.
// When the provider gives no word timings, Groq Whisper transcribes the audio
// with word timestamps; if that also fails, timings are estimated from text.
// Mock: a beep track with fake timings, no network.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env, MOCK } from "./config.mjs";
import { log } from "./log.mjs";
import { geminiCandidates, groqWhisperCandidates, modelHintFromError } from "./models.mjs";

const run = promisify(execFile);

export async function probeDuration(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file]);
  const d = Number(JSON.parse(stdout)?.format?.duration);
  if (!(d > 0)) throw new Error(`ffprobe: no duration for ${file}`);
  return d;
}

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Splits text into words the way we expect the TTS to report them. */
export function tokenize(text) {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[\s"'“”‘’(\[]+|[\s"'“”‘’)\],.!?;:।॥]+$/g, ""))
    .filter(Boolean);
}

async function edgeTTS(text, outDir, { voice, rate }) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
  const format = OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3 || OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(voice, format, { wordBoundaryEnabled: true });
      const result = await Promise.race([
        tts.toFile(outDir, xmlEscape(text), { rate }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("Edge TTS timed out")), 90_000)),
      ]);
      tts.close();
      const meta = result.metadataFilePath ? JSON.parse(fs.readFileSync(result.metadataFilePath, "utf8")) : { Metadata: [] };
      const words = (meta.Metadata || [])
        .filter((m) => m.Type === "WordBoundary" && m.Data?.text?.Text)
        .map((m) => ({
          text: String(m.Data.text.Text),
          start: m.Data.Offset / 1e7,
          end: (m.Data.Offset + (m.Data.Duration || 0)) / 1e7,
        }));
      if (!words.length) throw new Error("Edge TTS returned no word timings");
      return { audioPath: result.audioFilePath, words, provider: "edge" };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      log(`Edge TTS attempt ${attempt} failed: ${lastErr.message.slice(0, 160)}`);
      try {
        tts.close();
      } catch {}
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

async function geminiTTS(text, outDir, { voice, style }) {
  const key = env("GEMINI_API_KEY");
  if (!key) return null;
  const prompt = `${style}\n\n${text}`;
  let lastErr = "";
  const models = await geminiCandidates("tts");
  for (let i = 0; i < models.length && i < 8; i++) {
    const model = models[i];
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || "Puck" } } },
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      lastErr = body?.error?.message || `Gemini TTS ${res.status}`;
      log(`Gemini TTS ${model}: ${lastErr.slice(0, 160)}`);
      const hint = modelHintFromError(lastErr);
      if (hint && !models.includes(hint)) models.splice(i + 1, 0, hint);
      continue;
    }
    const part = body?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) {
      lastErr = "Gemini TTS returned no audio";
      continue;
    }
    const mime = part.inlineData.mimeType || "audio/L16;codec=pcm;rate=24000";
    const rate = Number(/rate=(\d+)/.exec(mime)?.[1] || 24000);
    const raw = path.join(outDir, "voice-gemini.pcm");
    fs.writeFileSync(raw, Buffer.from(part.inlineData.data, "base64"));
    const audioPath = path.join(outDir, "voice-gemini.mp3");
    const inputArgs = /l16|pcm/i.test(mime) ? ["-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", raw] : ["-i", raw];
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...inputArgs, "-c:a", "libmp3lame", "-q:a", "2", audioPath]);
    return { audioPath, words: null, provider: `gemini:${model}` };
  }
  throw new Error(lastErr || "Gemini TTS failed");
}

/** Word timestamps from Groq Whisper. Returns null when no key. */
export async function transcribeWords(audioPath, language = "hi") {
  const key = env("GROQ_API_KEY");
  if (!key) return null;
  const audio = fs.readFileSync(audioPath);
  let body = null;
  let lastErr = "";
  for (const model of await groqWhisperCandidates()) {
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/mpeg" }), path.basename(audioPath));
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("temperature", "0");
    if (language) form.append("language", language);
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    body = await res.json().catch(() => null);
    if (res.ok) break;
    lastErr = body?.error?.message || `Groq Whisper ${res.status}`;
    log(`Whisper ${model}: ${lastErr.slice(0, 120)}`);
    body = null;
  }
  if (!body) throw new Error(lastErr || "Groq Whisper failed");
  const words = (body?.words || [])
    .map((w) => ({ text: String(w.word || "").trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end));
  if (!words.length) throw new Error("Groq Whisper returned no word timestamps");
  return words;
}

/**
 * Captions must show the script's own words. Whisper's words give timing but
 * can hallucinate or repeat; map the script tokens onto the whisper timeline
 * by position when the counts differ.
 */
export function fitTimingsToScript(words, scriptText) {
  const tokens = scriptText.split(/\s+/).filter(Boolean);
  if (!words.length || !tokens.length) return words;
  if (tokens.length === words.length) return words.map((w, i) => ({ ...w, text: tokens[i] }));
  const W = words.length;
  const N = tokens.length;
  return tokens.map((text, i) => {
    const j = Math.min(W - 1, Math.round((i * (W - 1)) / Math.max(1, N - 1)));
    const jNext = Math.min(W - 1, Math.round(((i + 1) * (W - 1)) / Math.max(1, N - 1)));
    const start = words[j].start;
    const end = jNext > j ? words[jNext].start : words[j].end;
    return { text, start, end: Math.max(end, start + 0.12) };
  });
}

/** True when the same 4-word run appears twice in a row: the voice repeated itself. */
export function hasRepeatedRun(words, n = 4) {
  const t = words.map((w) => w.text.toLowerCase());
  for (let i = 0; i + 2 * n <= t.length; i++) {
    let same = true;
    for (let k = 0; k < n; k++) if (t[i + k] !== t[i + n + k]) { same = false; break; }
    if (same) return true;
  }
  return false;
}

/** Last resort: spread the script's words evenly over the audio by character share. */
export function estimateWords(text, duration, lead = 0.25, tail = 0.35) {
  const tokens = tokenize(text);
  const usable = Math.max(0.5, duration - lead - tail);
  const totalChars = tokens.reduce((a, t) => a + t.length + 1, 0);
  let t = lead;
  return tokens.map((tok) => {
    const d = ((tok.length + 1) / totalChars) * usable;
    const w = { text: tok, start: t, end: t + d * 0.9 };
    t += d;
    return w;
  });
}

async function elevenLabsTTS(text, outDir, { voiceId }) {
  const key = env("ELEVENLABS_API_KEY");
  if (!key || !voiceId) return null;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": key },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${JSON.stringify(body?.detail || body).slice(0, 200)}`);
  const audioPath = path.join(outDir, "voice-eleven.mp3");
  fs.writeFileSync(audioPath, Buffer.from(body.audio_base64, "base64"));
  const al = body.alignment || body.normalized_alignment;
  const chars = al?.characters || [];
  const starts = al?.character_start_times_seconds || [];
  const ends = al?.character_end_times_seconds || [];
  const words = [];
  let cur = null;
  chars.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = null;
      return;
    }
    if (!cur) cur = { text: "", start: starts[i], end: ends[i] };
    cur.text += ch;
    cur.end = ends[i];
  });
  if (cur) words.push(cur);
  if (!words.length) throw new Error("ElevenLabs returned no alignment");
  return { audioPath, words, provider: "elevenlabs" };
}

async function mockTTS(text, outDir) {
  // One soft beep per word so the timing is audible when checking the render.
  const tokens = tokenize(text);
  const per = 0.34;
  const words = tokens.map((t, i) => ({ text: t, start: 0.3 + i * per, end: 0.3 + i * per + per * 0.8 }));
  const total = 0.3 + tokens.length * per + 0.3;
  const audioPath = path.join(outDir, "voice-mock.mp3");
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=520:duration=${total.toFixed(2)}`,
    "-af", `volume=0.25,tremolo=f=${(1 / per).toFixed(3)}:d=0.9`,
    "-c:a", "libmp3lame", "-q:a", "4", audioPath,
  ]);
  return { audioPath, words, provider: "mock" };
}

/**
 * Synthesises the whole script in one go (one request = natural pacing).
 * Returns { audioPath, words:[{text,start,end}], duration, provider, timing }.
 */
export async function synthesize(text, outDir, { cfg, rate }) {
  fs.mkdirSync(outDir, { recursive: true });
  let out = null;
  if (MOCK()) out = await mockTTS(text, outDir);
  else {
    const order = (env("TTS_ORDER") || cfg.channel.ttsOrder || "edge,gemini,elevenlabs").split(",").map((s) => s.trim()).filter(Boolean);
    const style =
      cfg.channel.voiceStyle ||
      "Narrate in energetic Hindi, quick and confident, like a YouTube Shorts voiceover:";
    const errors = [];
    for (const name of order) {
      try {
        if (name === "edge") out = await edgeTTS(text, outDir, { voice: cfg.channel.voice, rate });
        else if (name === "gemini") out = await geminiTTS(text, outDir, { voice: cfg.channel.geminiVoice, style });
        else if (name === "elevenlabs") out = await elevenLabsTTS(text, outDir, { voiceId: cfg.channel.elevenLabsVoiceId });
        else log(`unknown TTS provider "${name}" skipped`);
        if (out) break;
        errors.push(`${name}: not configured`);
      } catch (e) {
        errors.push(`${name}: ${e.message.slice(0, 120)}`);
        log(`voice provider ${name} failed: ${e.message.slice(0, 160)}`);
      }
    }
    if (!out) throw new Error(`No voice provider worked. ${errors.join(" | ")}`);
  }
  const duration = await probeDuration(out.audioPath);
  let timing = "provider";
  if (!out.words || !out.words.length) {
    try {
      out.words = await transcribeWords(out.audioPath, cfg.channel.language || "hi");
      timing = out.words ? "whisper" : "estimated";
    } catch (e) {
      log(`word timestamps unavailable (${e.message.slice(0, 120)}), estimating from text`);
    }
    if (!out.words) out.words = estimateWords(text, duration);
    if (timing !== "whisper") timing = "estimated";
  }
  // A transcript that repeats a phrase, or is far longer than the script, means
  // the voice stuttered or repeated a line. Caller may re-synthesise.
  const scriptTokens = tokenize(text).length;
  out.repeated = timing === "whisper" && (hasRepeatedRun(out.words) || out.words.length > scriptTokens * 1.35);
  if (out.repeated) log(`voice looks repeated (${out.words.length} words heard vs ${scriptTokens} written)`);
  // Some providers report the last word ending after the file ends; clamp.
  out.words = out.words
    .filter((w) => w.text && Number.isFinite(w.start))
    .map((w) => ({ ...w, end: Math.min(Math.max(w.end || w.start + 0.25, w.start + 0.08), duration) }));
  return { ...out, duration, timing };
}

/**
 * Gives each spoken line a start/end from the word timings. Mapping is by
 * share of characters, so it tolerates the TTS splitting words differently.
 */
export function alignLines(lines, words, duration) {
  const totalChars = lines.reduce((a, l) => a + Math.max(1, l.text.length), 0);
  const wordChars = words.reduce((a, w) => a + Math.max(1, w.text.length), 0);
  const out = [];
  let lineCharsBefore = 0;
  let wi = 0;
  let wordCharsBefore = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const endFrac = (lineCharsBefore + Math.max(1, l.text.length)) / totalChars;
    const startWord = wi;
    while (wi < words.length) {
      const mid = (wordCharsBefore + Math.max(1, words[wi].text.length) / 2) / Math.max(1, wordChars);
      if (mid > endFrac && wi > startWord) break;
      wordCharsBefore += Math.max(1, words[wi].text.length);
      wi++;
    }
    const first = words[startWord];
    const last = words[Math.max(startWord, wi - 1)];
    out.push({
      ...l,
      start: i === 0 ? 0 : first?.start ?? out[i - 1].end,
      end: last?.end ?? duration,
      words: words.slice(startWord, wi),
    });
    lineCharsBefore += Math.max(1, l.text.length);
  }
  // Make the ranges contiguous: each line ends where the next starts.
  for (let i = 0; i < out.length; i++) out[i].end = i < out.length - 1 ? out[i + 1].start : duration;
  return out;
}
