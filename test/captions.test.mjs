import test from "node:test";
import assert from "node:assert/strict";
import { chunkWords, buildAss, restorePunctuation } from "../src/captions.mjs";
import { alignLines, tokenize } from "../src/tts.mjs";
import { planSegments } from "../src/visuals.mjs";

const words = "यह एक छोटा सा test है। दूसरा sentence यहाँ".split(" ").map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.3 }));

test("chunkWords respects word and char limits and sentence ends", () => {
  const chunks = chunkWords(words, { maxWords: 3, maxChars: 20 });
  assert.ok(chunks.every((c) => c.length <= 3));
  const sentenceEnd = chunks.find((c) => c[c.length - 1].text === "है।");
  assert.ok(sentenceEnd, "a chunk should end at the danda");
});

test("buildAss emits one event per word and escapes braces", () => {
  const cfg = { captions: { fontSize: 70 } };
  const ass = buildAss({ words: [...words, { text: "{x}", start: 10, end: 10.5 }], cfg });
  const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(events.length, words.length + 1);
  assert.ok(ass.includes("Noto Sans Devanagari"));
  assert.ok(!/Dialogue:.*\{x\}/.test(ass));
  assert.ok(ass.includes("(x)"));
});

test("caption events never overlap in time", () => {
  // Word groups whose ends run past the next group's start.
  const tight = Array.from({ length: 9 }, (_, i) => ({ text: "w" + i, start: i * 0.3, end: i * 0.3 + 0.35 }));
  const ass = buildAss({ words: tight, cfg: { captions: { maxWordsPerLine: 3 } } });
  const toSec = (t) => { const [h, m, s] = t.split(":"); return +h * 3600 + +m * 60 + +s; };
  const ev = ass.split("\n").filter((l) => l.startsWith("Dialogue:")).map((l) => { const p = l.split(","); return [toSec(p[1]), toSec(p[2])]; });
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i][0] >= ev[i - 1][1] - 0.011, `event ${i} starts before ${i - 1} ends`);
});

test("restorePunctuation only applies when token counts match", () => {
  const stripped = [{ text: "hello", start: 0, end: 1 }, { text: "world", start: 1, end: 2 }];
  assert.equal(restorePunctuation(stripped, "hello, world!")[1].text, "world!");
  assert.equal(restorePunctuation(stripped, "hello big world!")[1].text, "world");
});

test("alignLines gives contiguous ranges covering the whole audio", () => {
  const lines = [{ text: "यह एक छोटा सा test है।" }, { text: "दूसरा sentence यहाँ" }];
  const aligned = alignLines(lines, words, 4);
  assert.equal(aligned[0].start, 0);
  assert.equal(aligned[0].end, aligned[1].start);
  assert.equal(aligned[1].end, 4);
  assert.ok(aligned[0].words.length >= 4 && aligned[0].words.length <= 7);
});

test("planSegments merges short lines and adds the tail to the last", () => {
  const lines = [
    { text: "a", visual: "q1", start: 0, end: 1 },
    { text: "b", visual: "q2", start: 1, end: 2 },
    { text: "c", visual: "q3", start: 2, end: 3 },
    { text: "d", visual: "q4", start: 3, end: 6 },
  ];
  const segs = planSegments(lines, { minSeconds: 2.4, tail: 0.6 });
  assert.equal(segs.length, 2);
  assert.equal(segs[0].query, "q1");
  assert.equal(segs[1].end, 6.6);
  assert.ok(Math.abs(segs.reduce((a, s) => a + s.duration, 0) - 6.6) < 1e-6);
});

test("tokenize strips surrounding punctuation", () => {
  assert.deepEqual(tokenize('"Hello," world! ठीक।'), ["Hello", "world", "ठीक"]);
});

test("estimateWords spreads words across the audio in order", async () => {
  const { estimateWords } = await import("../src/tts.mjs");
  const words = estimateWords("एक दो तीन चार पाँच", 5);
  assert.equal(words.length, 5);
  assert.ok(words[0].start >= 0.2);
  assert.ok(words[4].end <= 5);
  for (let i = 1; i < words.length; i++) assert.ok(words[i].start >= words[i - 1].end);
});

test("fitTimingsToScript always shows the script's words", async () => {
  const { fitTimingsToScript, hasRepeatedRun } = await import("../src/tts.mjs");
  const heard = Array.from({ length: 10 }, (_, i) => ({ text: "x" + i, start: i, end: i + 0.8 }));
  const fitted = fitTimingsToScript(heard, "एक दो तीन चार पाँच छह");
  assert.deepEqual(fitted.map((w) => w.text), ["एक", "दो", "तीन", "चार", "पाँच", "छह"]);
  assert.equal(fitted[0].start, 0);
  for (let i = 1; i < fitted.length; i++) assert.ok(fitted[i].start >= fitted[i - 1].start);
  assert.ok(hasRepeatedRun("a b c d a b c d e".split(" ").map((text) => ({ text }))));
  assert.ok(!hasRepeatedRun("a b c d e f g h".split(" ").map((text) => ({ text }))));
});

test("dedupeLines drops lines that repeat the hook or each other", async () => {
  const { dedupeLines } = await import("../src/script.mjs");
  const out = dedupeLines("UPI से पैसे देना गरीब बना रहा है।", [
    { text: "UPI से पैसे देना गरीब बना रहा है" },
    { text: "दूसरी बात" },
    { text: "दूसरी बात।" },
    { text: "तीसरी बात" },
  ]);
  assert.deepEqual(out.map((l) => l.text), ["दूसरी बात", "तीसरी बात"]);
});

test("stripWeakOpener removes filler openers but keeps the claim", async () => {
  const { stripWeakOpener } = await import("../src/script.mjs");
  assert.equal(stripWeakOpener("क्या आप जानते हैं कि Lepakshi का पिलर नहीं गिरता?"), "Lepakshi का पिलर नहीं गिरता?");
  assert.equal(stripWeakOpener("क्या आप विश्वास करेंगे, एक फिल्म बनी सिर्फ 4 दिन में?"), "एक फिल्म बनी सिर्फ 4 दिन में?");
  assert.equal(stripWeakOpener("Kya aap jaante hain ki Sholay ek take mein bana?"), "Sholay ek take mein bana?");
  assert.equal(stripWeakOpener("UPI आपको गरीब बना रहा है।"), "UPI आपको गरीब बना रहा है।");
});
