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

test("the cooperative planner produces the same plan as the synchronous one", async () => {
  const items = library(1500);
  expect(await planStoriesAsync(items)).toEqual(planStories(items));
});

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
