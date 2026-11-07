import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateRhyme, MOCK_RHYME, spokenLines } from "../src/script.mjs";
import { generateMusic } from "../src/music.mjs";

test("validateRhyme accepts the mock rhyme and rejects Hindi on an English channel", () => {
  const ok = validateRhyme(MOCK_RHYME, { minWords: 40, maxWords: 110, lang: "en" });
  assert.ok(!ok.error, ok.error);
  assert.equal(ok.script.kind, "rhyme");
  assert.equal(spokenLines(ok.script).length, MOCK_RHYME.lines.length);
  const hi = validateRhyme({ ...MOCK_RHYME, lines: MOCK_RHYME.lines.map((l) => ({ ...l, text: "मछली जल की रानी है" })) }, { minWords: 20, maxWords: 110, lang: "en" });
  assert.match(hi.error, /English/);
});

test("validateRhyme needs enough lines and a characters sentence", () => {
  const few = validateRhyme({ ...MOCK_RHYME, lines: MOCK_RHYME.lines.slice(0, 3) }, { minWords: 10, maxWords: 110, lang: "en" });
  assert.match(few.error, /lines/);
  const noChars = validateRhyme({ ...MOCK_RHYME, characters: "" }, { minWords: 40, maxWords: 110, lang: "en" });
  assert.match(noChars.error, /characters/);
});

test("generateMusic writes a valid WAV of the requested length", () => {
  const f = path.join(os.tmpdir(), `music-${process.pid}.wav`);
  generateMusic(f, { seconds: 5, seed: 1 });
  const b = fs.readFileSync(f);
  assert.equal(b.toString("ascii", 0, 4), "RIFF");
  assert.equal(b.toString("ascii", 8, 12), "WAVE");
  const rate = b.readUInt32LE(24);
  const dataLen = b.readUInt32LE(40);
  assert.ok(Math.abs(dataLen / 2 / rate - 6) < 0.01);
  fs.unlinkSync(f);
});
