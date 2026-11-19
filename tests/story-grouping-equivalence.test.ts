import { expect, test } from "bun:test";
import * as reference from "./fixtures/story-grouping-reference";
import { planStories, type StoryInput } from "../src/story-grouping";

const day = 86400000;
const base = Date.UTC(2026, 0, 1);
const actions = [
  "launches",
  "released",
  "acquires",
  "recall",
  "raises",
  "outage",
  "sues",
  "approved",
];
const subjects = ["Zephyr", "Quantis", "Borealis", "Nimbus", "Vortex", "Helix"];
const syndicatedBody = (topic: number) =>
  (
    `syndicated body for topic ${topic} ` +
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima "
  ).repeat(3);

/**
 * Seeded generator producing clusters (shared subjects, versions, actions,
 * syndicated bodies), later follow-ups, and unrelated singletons, so every
 * evidence path and relation path is exercised.
 */
function corpus(seed: number, count: number): StoryInput[] {
  let state = seed;
  const next = () =>
    (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(values: T[]) => values[Math.floor(next() * values.length)]!;
  const topics = Math.max(1, Math.floor(count / 3));
  const items: StoryInput[] = [];
  for (let i = 0; i < count; i++) {
    const topic = Math.floor(next() * topics);
    const subject = subjects[topic % subjects.length]!;
    const partner = subjects[(topic * 3 + 1) % subjects.length]!;
    const version = `${1 + (topic % 5)}.${topic % 4}`;
    const action =
      next() < 0.85 ? actions[topic % actions.length]! : pick(actions);
    const extra =
      next() < 0.3 ? "" : " " + pick(["in", "region", "today", "update"]);
    const title = `${subject} ${partner} ${version} ${action}${extra}${next() < 0.3 ? " t" + topic : ""}`;
    const shared = next() < 0.2;
    items.push({
      id: `item-${i}`,
      identity: `url:https://example.test/${topic}/${i}`,
      url: `https://example.test/${topic}/${i}`,
      title,
      text: shared
        ? syndicatedBody(topic)
        : `unique ${i} ` + "filler ".repeat(30),
      publishedAt: base + Math.floor(next() * (next() < 0.5 ? 5 : 120) * day),
      ingestedAt: base + Math.floor(next() * 30 * day),
    });
  }
  return items;
}

test("indexed planning matches the reference planner on varied corpora", () => {
  let relations = 0;
  let multiMemberGroups = 0;
  let syndicatedGroups = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const items = corpus(seed, 3 + ((seed * 7) % 60));
    const indexed = planStories(items);
    // v2 intentionally allows additional named context in one headline when
    // at least two named subjects and the existing event checks still agree.
    // The frozen v1 reference remains useful for verifying the other planner
    // paths and deterministic plan structure.
    const referencePlan = reference.planStories(items);
    const { version: _referenceVersion, ...referenceWithoutVersion } =
      referencePlan;
    const { version: _indexedVersion, ...indexedWithoutVersion } = indexed;
    expect(indexed.version).toBe("specific-development-v2");
    expect(JSON.stringify(indexedWithoutVersion)).toBe(
      JSON.stringify(referenceWithoutVersion),
    );
    relations += indexed.relations.length;
    multiMemberGroups += indexed.groups.filter(
      (g) => g.members.length > 1,
    ).length;
    syndicatedGroups += indexed.groups.filter((g) =>
      g.members.some((m) => m.evidence.reason === "syndicated_content"),
    ).length;
  }
  // Guard against the corpus silently stopping exercising the matching paths.
  expect(relations).toBeGreaterThan(0);
  expect(multiMemberGroups).toBeGreaterThan(0);
  expect(syndicatedGroups).toBeGreaterThan(0);
});

test("indexed planning matches the reference for ingestion-order variants", () => {
  const items = corpus(42, 80);
  const reversed = [...items].reverse();
  const indexed = planStories(reversed);
  const referencePlan = reference.planStories(reversed);
  const { version: _indexedVersion, ...indexedWithoutVersion } = indexed;
  const { version: _referenceVersion, ...referenceWithoutVersion } =
    referencePlan;
  expect(indexed.version).toBe("specific-development-v2");
  expect(JSON.stringify(indexedWithoutVersion)).toBe(
    JSON.stringify(referenceWithoutVersion),
  );
});
