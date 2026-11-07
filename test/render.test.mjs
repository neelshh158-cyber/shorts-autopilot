import test from "node:test";
import assert from "node:assert/strict";
import { buildFfmpegArgs } from "../src/render.mjs";
import { cleanTitle } from "../src/youtube.mjs";

const cfg = { video: { width: 1080, height: 1920, fps: 30, musicVolume: 0.1 } };

test("buildFfmpegArgs maps every segment kind and the audio", () => {
  const segments = [
    { kind: "video", path: "/tmp/a.mp4", duration: 3 },
    { kind: "image", path: "/tmp/b.jpg", duration: 2.5 },
    { kind: "gradient", colors: ["0x000000", "0x111111", "0x222222"], duration: 4 },
  ];
  const args = buildFfmpegArgs({ segments, audioPath: "/tmp/v.mp3", assPath: "/tmp/c.ass", musicPath: null, outFile: "/tmp/o.mp4", cfg, totalDuration: 9.5 });
  const fc = args[args.indexOf("-filter_complex") + 1];
  assert.ok(fc.includes("concat=n=3"));
  assert.ok(fc.includes("zoompan"));
  assert.ok(fc.includes("ass='/tmp/c.ass'"));
  assert.ok(!fc.includes("amix"));
  assert.equal(args[args.length - 1], "/tmp/o.mp4");
  assert.ok(args.includes("-stream_loop"));
});

test("music adds an amix stage", () => {
  const segments = [{ kind: "gradient", colors: ["0x0", "0x1", "0x2"], duration: 4 }];
  const args = buildFfmpegArgs({ segments, audioPath: "/tmp/v.mp3", assPath: "/tmp/c.ass", musicPath: "/tmp/m.mp3", outFile: "/tmp/o.mp4", cfg, totalDuration: 4 });
  assert.ok(args[args.indexOf("-filter_complex") + 1].includes("amix=inputs=2"));
});

test("cleanTitle keeps within 100 chars including the suffix", () => {
  const t = cleanTitle("x".repeat(150), " #shorts");
  assert.ok(t.length <= 100);
  assert.ok(t.endsWith(" #shorts"));
  assert.equal(cleanTitle("a <b> c"), "a b c");
});
