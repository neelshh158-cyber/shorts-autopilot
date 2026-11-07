import test from "node:test";
import assert from "node:assert/strict";
import { rankGeminiModels, rankGroqChatModels, modelHintFromError } from "../src/models.mjs";

test("modelHintFromError pulls the suggested model out of Google's message", () => {
  assert.equal(modelHintFromError("This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features."), "gemini-3.8-flash");
  assert.equal(modelHintFromError("quota exceeded"), null);
});

test("rankGeminiModels prefers the newest flash text model and keeps tts separate", () => {
  const models = ["gemini-2.5-flash", "gemini-3.8-flash", "gemini-3.8-pro", "gemini-3.8-flash-lite", "gemini-2.5-flash-preview-tts", "gemini-3.8-flash-tts", "gemini-embedding-001", "imagen-4"];
  const text = rankGeminiModels(models, "text");
  assert.equal(text[0], "gemini-3.8-pro".startsWith("gemini-3.8") ? text[0] : null);
  assert.ok(text[0].startsWith("gemini-3.8") && !/tts|lite/.test(text[0]));
  assert.ok(!text.some((n) => /tts|embedding|imagen/.test(n)));
  const tts = rankGeminiModels(models, "tts");
  assert.equal(tts[0], "gemini-3.8-flash-tts");
  assert.ok(tts.every((n) => /tts/.test(n)));
});

test("rankGeminiModels finds image models separately", () => {
  const models = ["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-3.8-flash-image-preview", "imagen-4.0-generate-001", "gemini-2.5-flash-preview-tts"];
  const img = rankGeminiModels(models, "image");
  assert.deepEqual(img, ["gemini-3.8-flash-image-preview", "gemini-2.5-flash-image"]);
  assert.ok(!rankGeminiModels(models, "text").some((n) => /image/.test(n)));
});

test("rankGroqChatModels skips audio and guard models and ranks big models first", () => {
  const ids = ["whisper-large-v3", "llama-guard-4-12b", "openai/gpt-oss-20b", "openai/gpt-oss-120b", "meta-llama/llama-4-maverick-17b-128e-instruct", "playai-tts", "llama-3.1-8b-instant"];
  const ranked = rankGroqChatModels(ids);
  assert.equal(ranked[0], "openai/gpt-oss-120b");
  assert.ok(!ranked.includes("whisper-large-v3") && !ranked.includes("playai-tts") && !ranked.includes("llama-guard-4-12b"));
  assert.equal(ranked[ranked.length - 1], "llama-3.1-8b-instant");
});
