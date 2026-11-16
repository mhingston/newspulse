import { expect, test } from "bun:test";
import {
  planStories,
  planStoriesAsync,
  type StoryInput,
} from "../src/story-grouping";

const day = 86400000;
const start = Date.UTC(2026, 0, 1);
const body =
  "Detailed report on the rollout, its measurements and the effect on operators. ".repeat(
    8,
  );

/** Large enough that the planner must pause many times before finishing. */
function library(count: number): StoryInput[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    identity: `identity-${String(index).padStart(6, "0")}`,
    url: `https://example.com/articles/${index}`,
    title: `Deployment report ${index} for service ${index % 37}`,
    text: `${body} Article ${index}.`,
    publishedAt: start + index * day,
    ingestedAt: start + index * day,
  }));
}

/**
 * Every title shares a version and named subjects, so the relation pass sees
 * one large bucket of candidate pairs, the case that once ran unyielded.
 */
function sharedSubjectLibrary(count: number): StoryInput[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    identity: `identity-${String(index).padStart(6, "0")}`,
    url: `https://example.com/articles/${index}`,
    title: `Acme Relay ${index} update for Orbit Labs ${index % 7}`,
    text: `${body} Article ${index}.`,
    publishedAt: start + index * day,
    ingestedAt: start + index * day,
  }));
}

test("the cooperative planner produces the same plan as the synchronous one", async () => {
  const items = library(1500);
  expect(await planStoriesAsync(items)).toEqual(planStories(items));
});

test("no synchronous planning span exceeds the yield bound on a large library", async () => {
  const items = sharedSubjectLibrary(40000);
  let last = performance.now();
  let longest = 0;
  let planned = false;
  const plan = planStoriesAsync(items).then((result) => {
    planned = true;
    return result;
  });
  while (!planned) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }
  await plan;
  // The planner targets ~250ms slices; 500ms leaves room for CI scheduling noise.
  expect(longest).toBeLessThan(500);
}, 60000);

test("a macrotask runs while a large plan is still in progress", async () => {
  const items = library(3000);
  let planned = false;
  let ranBeforeCompletion = false;
  const plan = planStoriesAsync(items).then((result) => {
    planned = true;
    return result;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  ranBeforeCompletion = !planned;
  await plan;
  expect(ranBeforeCompletion).toBe(true);
});
