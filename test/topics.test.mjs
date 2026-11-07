import test from "node:test";
import assert from "node:assert/strict";
import { pickPlan, computeScores } from "../src/topics.mjs";

const cfg = {
  picker: { exploreRate: 0 },
  categories: [
    { key: "a", label: "A", seeds: ["s1", "s2"] },
    { key: "b", label: "B", seeds: ["s3"] },
  ],
  formats: [{ key: "f1" }, { key: "f2" }],
};

test("pickPlan avoids repeating the last category and used seeds", () => {
  const history = [{ category: "a", topic: "s1" }];
  const plan = pickPlan(cfg, {}, history, () => 0.5);
  assert.equal(plan.category.key, "b");
  assert.deepEqual(plan.usedTopics, ["s1"]);
  assert.deepEqual(plan.freshSeeds, ["s3"]);
});

test("pickPlan leans towards the better-scoring category", () => {
  const scores = { categories: { a: { score: 3 }, b: { score: 0.3 } }, formats: {} };
  let a = 0;
  for (let i = 0; i < 200; i++) {
    const r = (i + 0.5) / 200;
    if (pickPlan(cfg, scores, [], () => r).category.key === "a") a++;
  }
  assert.ok(a > 150, `expected a to win most picks, got ${a}/200`);
});

test("computeScores needs at least 3 videos and normalises around 1", () => {
  const mk = (category, views) => ({ status: "uploaded", category, format: "f1", stats: { views } });
  assert.deepEqual(computeScores([mk("a", 10)]).categories, {});
  const s = computeScores([mk("a", 1000), mk("a", 1000), mk("b", 100), mk("b", 100)]);
  assert.ok(s.categories.a.score > 1);
  assert.ok(s.categories.b.score < 1);
  assert.equal(s.videosCounted, 4);
});
