import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  planStories,
  STORY_RULE_VERSION,
  type StoryInput,
} from "../src/story-grouping";

const date = Date.UTC(2026, 10, 1);
function item(key: string, title: string, days = 0, body = ""): StoryInput {
  return {
    id: key,
    identity: "url:https://example.com/" + key,
    url: "https://example.com/" + key,
    title,
    text: body,
    publishedAt: date + days * 86400000,
    ingestedAt: date + days * 86400000,
  };
}
function partition(input: StoryInput[]) {
  return planStories(input)
    .groups.map((g) =>
      g.members
        .map((m) => m.itemId)
        .sort()
        .join(","),
    )
    .sort();
}
test("specific release coverage groups without losing member identities", () => {
  const a = item("a", "Acme releases Atlas 2 robotics model");
  const b = item("b", "Atlas 2 robotics model launched by Acme");
  const c = item("c", "Acme launches Orion 3 robotics model");
  const plan = planStories([b, c, a]);
  expect(plan.version).toBe(STORY_RULE_VERSION);
  expect(partition([a, b, c])).toEqual(["a,b", "c"]);
  expect(
    plan.groups.find((g) => g.members.length === 2)?.members[1]?.evidence
      .reason,
  ).toBe("specific_event");
});
test("same long syndicated text groups regardless of headline and publication order", () => {
  const content =
    "The research team published its benchmark methodology, hardware latency measurements, evaluation harness, reproducible weights and licensing details. ".repeat(
      2,
    );
  const a = item("a", "Acme releases Atlas 2", 0, content);
  const b = item("b", "Independent report on the new model", 8, content);
  expect(partition([a, b])).toEqual(["a,b"]);
  expect(planStories([a, b]).groups[0]?.members[1]?.evidence.reason).toBe(
    "syndicated_content",
  );
});
test("broad topic and distinct versions never merge as a specific event", () => {
  const a = item("a", "Acme releases Atlas 2 robotics model");
  const b = item("b", "Acme releases Orion 3 robotics model");
  const c = item("c", "Other startup releases Atlas 2 robotics model");
  expect(partition([a, b, c])).toEqual(["a", "b", "c"]);
});
test("a week-later recall is a new development with a historical relationship", () => {
  const release = item("release", "Acme releases Atlas 2 robotics model");
  const recall = item("recall", "Acme recalls Atlas 2 robotics model", 7);
  const plan = planStories([recall, release]);
  expect(partition([release, recall])).toEqual(["recall", "release"]);
  expect(plan.relations).toEqual([
    expect.objectContaining({
      reason: "later_related_development",
    }),
  ]);
});
test("replay and arrival order produce stable partitions and canonical group keys", () => {
  const a = item("a", "Acme releases Atlas 2 robotics model");
  const b = item("b", "Atlas 2 robotics model launched by Acme");
  const c = item("c", "Acme recalls Atlas 2 robotics model", 7);
  const one = planStories([a, b, c]);
  const other = planStories([c, a, b]);
  expect(one).toEqual(other);
  expect(planStories([c, a, b])).toEqual(other);
});

test("recorded evaluation fixture distinguishes developments and historical links", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/evaluation.json", import.meta.url),
      "utf8",
    ),
  ) as {
    story_evaluation: {
      cases: {
        id: string;
        title: string;
        day: number;
        development: string;
        follows?: string;
      }[];
    };
  };
  const cases = fixture.story_evaluation.cases;
  const input = cases.map((entry) => item(entry.id, entry.title, entry.day));
  const plan = planStories(input);
  const developmentById = new Map(
    cases.map((entry) => [entry.id, entry.development]),
  );
  for (const group of plan.groups) {
    const labels = group.members.map((member) =>
      developmentById.get(member.itemId),
    );
    expect(new Set(labels).size).toBe(1);
  }
  expect(plan.groups).toHaveLength(4);
  const release = plan.groups.find((group) =>
    group.members.some((member) => member.itemId === "atlas-release"),
  )!;
  const recall = plan.groups.find((group) =>
    group.members.some((member) => member.itemId === "atlas-recall"),
  )!;
  expect(plan.relations).toContainEqual(
    expect.objectContaining({
      olderGroupId: release.id,
      newerGroupId: recall.id,
    }),
  );
});
