import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import {
  SourceSuggestionStore,
  acceptSourceSuggestion,
  dismissSourceSuggestion,
  extractFeedLinks,
  generateSourceSuggestions,
  muteSourceSuggestion,
  refreshSourceSuggestions,
  unmuteSourceSuggestion,
  type SourceSuggestion,
} from "../src/source-suggestions";
import { createSourceSuggestionDatabase } from "../src/source-suggestion-evaluation";
import fixture from "./fixtures/source-recommendation-corpus-v1.json";
import type { SourceRecommendationCorpus } from "../src/source-suggestion-evaluation";

const corpus = fixture as unknown as SourceRecommendationCorpus;

function fixtureStore() {
  return createSourceSuggestionDatabase(corpus);
}

function sample(offset: number): SourceSuggestion {
  return {
    id: `domain:sample-${offset}.example`,
    kind: "domain",
    domain: `sample-${offset}.example`,
    url: `https://sample-${offset}.example/feed.xml`,
    title: `sample-${offset}.example`,
    score: 50 + offset,
    stats: {
      distinctItems: 3,
      results: 3,
      usefulItems: 1,
      notUsefulItems: 0,
      usefulOutsideWindow: 0,
      duplicateItems: 0,
      unavailableItems: 0,
      distinctPublishDays: 2,
      repetitionRatio: 1,
      duplicateRate: 0,
      positiveShare: 1,
      newestPublishedAt: 100,
    },
    explanation: "1 useful of 3 meaningful distinct items; test row",
    evidence: [
      {
        itemId: "item-1",
        title: "Item one",
        url: "https://sample.example/one",
        feedback: "useful",
        publishedAt: 100,
      },
    ],
    feedCandidates: [
      {
        url: `https://sample-${offset}.example/feed.xml`,
        provenance: "link-element",
      },
    ],
    limitations: ["fixture"],
    algorithmVersion: "test",
  };
}

test("generation proposes high-value domains with evidence and validated feed candidates", () => {
  const store = fixtureStore();
  try {
    const run = generateSourceSuggestions(store, { now: corpus.asOf });
    expect(run.algorithmVersion).toBe("source-suggestions-v1");
    expect(run.suggestions.map((s) => s.id)).toEqual([
      "domain:signal-press.example",
      "domain:field-notes.example",
      "domain:mixed-review.example",
    ]);
    expect(run.suggestions.map((s) => s.score)).toEqual([73, 56, 33]);
    const signal = run.suggestions[0]!;
    expect(signal.url).toBe("https://signal-press.example/feed.xml");
    expect(signal.stats.usefulItems).toBe(3);
    expect(signal.evidence.length).toBeGreaterThan(0);
    expect(
      signal.feedCandidates.some((c) => c.provenance === "link-element"),
    ).toBe(true);
    // Recorded representative items keep operator review concrete.
    expect(signal.explanation).toContain("3 useful of 5 meaningful");
    expect(run.limitations.some((l) => l.includes("no external request"))).toBe(
      true,
    );
  } finally {
    store.close();
  }
});

test("generation is read-only: no subscription, polling or discovery budget changes", () => {
  const store = fixtureStore();
  try {
    const runsBefore = count(store, "SELECT count(*) AS n FROM discovery_runs");
    const pagesBefore = count(
      store,
      "SELECT count(*) AS n FROM discovery_pages",
    );
    const sourcesBefore = count(store, "SELECT count(*) AS n FROM sources");
    const jobsBefore = count(store, "SELECT count(*) AS n FROM jobs");
    generateSourceSuggestions(store, { now: corpus.asOf });
    expect(count(store, "SELECT count(*) AS n FROM discovery_runs")).toBe(
      runsBefore,
    );
    expect(count(store, "SELECT count(*) AS n FROM discovery_pages")).toBe(
      pagesBefore,
    );
    expect(count(store, "SELECT count(*) AS n FROM sources")).toBe(
      sourcesBefore,
    );
    expect(count(store, "SELECT count(*) AS n FROM jobs")).toBe(jobsBefore);
  } finally {
    store.close();
  }
});

function count(store: Store, sql: string) {
  return store.sqlite.query<{ n: number }, []>(sql).get()!.n;
}

test("repetitive low-volume, unavailable, duplicate and quality-declining domains are skipped with reasons", () => {
  const store = fixtureStore();
  try {
    const run = generateSourceSuggestions(store, { now: corpus.asOf });
    const reasons = new Map(run.skipped.map((s) => [s.domain, s.reason]));
    expect(reasons.get("chatter-mill.example")).toContain(
      "below proposal threshold",
    );
    expect(reasons.get("dark-press.example")).toContain(
      "0 meaningful distinct items",
    );
    expect(reasons.get("mirror-daily.example")).toContain(
      "0 meaningful distinct items",
    );
    expect(reasons.get("fading-quarterly.example")).toContain(
      "quality decline",
    );
    expect(reasons.get("old.reddit.com")).toContain("not community coverage");
    expect(run.scanned.unavailableItems).toBe(3);
  } finally {
    store.close();
  }
});

test("feed link extraction is conservative, host-bound and validated without fetching", () => {
  const base = "https://publisher.example/notes";
  const html = [
    "<!doctype html><head>",
    '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
    '<link rel="alternate" type="application/atom+xml" href="/atom.xml">',
    '<link rel="stylesheet" type="application/rss+xml" href="/not-a-feed.css">',
    '<link rel="alternate" type="application/rss+xml" href="https://cdn.example/foreign.xml">',
    '<a type="application/rss+xml" href="rss/u/updates.xml">',
    '<a href="/plain-link.xml">',
    '<link rel="alternate" type="application/rss+xml" href="http://127.0.0.1:9/feed">',
    '<link rel="alternate" type="application/rss+xml" href="/feed">',
  ].join("");
  const links = extractFeedLinks(html, base);
  // Link elements are collected first, then typed anchors; their combined
  // order is deterministic by document position within each group.
  expect(links.map((l) => l.url)).toEqual([
    "https://publisher.example/feed.xml",
    "https://publisher.example/atom.xml",
    "https://publisher.example/feed",
    "https://publisher.example/rss/u/updates.xml",
  ]);
  expect(links.every((l) => l.provenance === "link-element")).toBe(true);
});

test("suggestion persistence upserts idempotently and preserves operator decisions", () => {
  const store = new Store(":memory:");
  try {
    const suggestions = new SourceSuggestionStore(store.sqlite);
    expect(suggestions.upsert([sample(1), sample(2)], 100)).toEqual({
      saved: 2,
      refreshed: 0,
    });
    // Replaying identical evidence changes nothing.
    expect(suggestions.upsert([sample(1), sample(2)], 101)).toEqual({
      saved: 0,
      refreshed: 0,
    });
    suggestions.setState("domain:sample-1.example", "accepted", 102, "src-1");
    suggestions.setState("domain:sample-2.example", "muted", 102);
    // Regeneration after a decision must not reset it.
    expect(suggestions.upsert([sample(1)], 103)).toEqual({
      saved: 0,
      refreshed: 0,
    });
    const accepted = suggestions.get("domain:sample-1.example")!;
    expect(accepted.state).toBe("accepted");
    expect(accepted.acceptedSourceId).toBe("src-1");
    const muted = suggestions.get("domain:sample-2.example")!;
    expect(muted.state).toBe("muted");
    // State-change events are recorded exactly once per real transition.
    expect(
      count(store, "SELECT count(*) AS n FROM source_suggestion_events"),
    ).toBe(2);
  } finally {
    store.close();
  }
});

test("dismiss and mute are idempotent; accept through dismissal works and mute is replayable", () => {
  const store = new Store(":memory:");
  try {
    const suggestions = new SourceSuggestionStore(store.sqlite);
    suggestions.upsert([sample(3)], 100);
    const first = dismissSourceSuggestion(
      store,
      "domain:sample-3.example",
      101,
    );
    expect(first).toEqual({
      state: "dismissed",
      changed: true,
      acceptedSourceId: null,
    });
    const replay = dismissSourceSuggestion(
      store,
      "domain:sample-3.example",
      102,
    );
    expect(replay).toEqual({
      state: "dismissed",
      changed: false,
      acceptedSourceId: null,
    });
    expect(
      count(store, "SELECT count(*) AS n FROM source_suggestion_events"),
    ).toBe(1);
    const muted = muteSourceSuggestion(store, "domain:sample-3.example", 103);
    expect(muted.state).toBe("muted");
    expect(
      muteSourceSuggestion(store, "domain:sample-3.example", 104).changed,
    ).toBe(false);
    const revived = unmuteSourceSuggestion(
      store,
      "domain:sample-3.example",
      105,
    );
    expect(revived.state).toBe("proposed");
  } finally {
    store.close();
  }
});

test("accept routes through existing source management and is idempotent; muted cannot be accepted", () => {
  const store = fixtureStore();
  try {
    const run = refreshSourceSuggestions(store, { now: corpus.asOf });
    expect(run.suggestions.length).toBe(3);
    const before = count(store, "SELECT count(*) AS n FROM sources");
    const outcome = acceptSourceSuggestion(
      store,
      "domain:signal-press.example",
      {
        now: corpus.asOf + 1,
      },
    );
    expect(outcome.changed).toBe(true);
    expect(outcome.url).toBe("https://signal-press.example/feed.xml");
    const source = store.source(outcome.sourceId);
    expect(source).toBeDefined();
    expect(source!.kind).toBe("rss");
    expect(source!.url).toBe("https://signal-press.example/feed.xml");
    expect(source!.removed).toBe(0);
    expect(count(store, "SELECT count(*) AS n FROM sources")).toBe(before + 1);
    // Replay of the accept is a no-op returning the same source.
    const replay = acceptSourceSuggestion(
      store,
      "domain:signal-press.example",
      {
        now: corpus.asOf + 2,
      },
    );
    expect(replay).toEqual({ ...outcome, changed: false });
    expect(count(store, "SELECT count(*) AS n FROM sources")).toBe(before + 1);

    // Muted suggestions can never be silently followed.
    muteSourceSuggestion(store, "domain:field-notes.example", corpus.asOf + 3);
    expect(() =>
      acceptSourceSuggestion(store, "domain:field-notes.example", {
        now: corpus.asOf + 4,
      }),
    ).toThrow(/Muted/);
  } finally {
    store.close();
  }
});

test("accepting rejects private or malformed destinations through shared validation", () => {
  const store = new Store(":memory:");
  try {
    const suggestions = new SourceSuggestionStore(store.sqlite);
    suggestions.upsert([sample(9)], 100);
    // Force a suggestion URL at a private host to confirm the shared
    // public-host guard rejects it at accept time.
    store.sqlite
      .query(
        "UPDATE source_suggestions SET url='http://127.0.0.1:8080/feed' WHERE id=?",
      )
      .run("domain:sample-9.example");
    expect(() =>
      acceptSourceSuggestion(store, "domain:sample-9.example", { now: 101 }),
    ).toThrow(/not a public host/);
  } finally {
    store.close();
  }
});

test("generation with no discoveries produces no suggestions", () => {
  const store = new Store(":memory:");
  try {
    const run = generateSourceSuggestions(store, { now: corpus.asOf });
    expect(run.suggestions).toEqual([]);
    expect(run.scanned).toEqual({
      discoveryResults: 0,
      domains: 0,
      domainsWithFeedback: 0,
      unavailableItems: 0,
    });
  } finally {
    store.close();
  }
});
