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
import fixture from "./fixtures/source-recommendation-corpus-v2.json";
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
    expect(run.algorithmVersion).toBe("source-suggestions-v2");
    expect(run.suggestions.map((s) => s.id)).toEqual([
      "domain:signal-press.example",
      "domain:field-notes.example",
      "domain:mixed-review.example",
    ]);
    expect(run.suggestions.map((s) => s.score)).toEqual([73, 56, 33]);
    const signal = run.suggestions[0]!;
    expect(signal.url).toBe("https://signal-press.example/feeds/index.rss");
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
    expect(outcome.url).toBe("https://signal-press.example/feeds/index.rss");
    const source = store.source(outcome.sourceId);
    expect(source).toBeDefined();
    expect(source!.kind).toBe("rss");
    expect(source!.url).toBe("https://signal-press.example/feeds/index.rss");
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

test("same-millisecond feedback judgments resolve by insertion order, matching scoring readers", () => {
  const store = fixtureStore();
  try {
    // sp-agents already has useful feedback; append a later-rowid not-useful
    // correction at the same millisecond timestamp.
    store.sqlite
      .query(
        "INSERT INTO item_feedback(id,item_id,useful,source,created_at) VALUES('fb-correction','sp-agents',0,'mcp',?)",
      )
      .run(corpus.items.find((i) => i.id === "sp-agents")!.feedbackAt!);
    const run = generateSourceSuggestions(store, { now: corpus.asOf });
    // The not-useful correction is the latest judgment: signal-press now has
    // 2 useful + 1 not-useful items instead of 3 useful.
    const signal = run.suggestions.find(
      (s) => s.id === "domain:signal-press.example",
    )!;
    expect(signal.stats.usefulItems).toBe(2);
    expect(signal.stats.notUsefulItems).toBe(1);
  } finally {
    store.close();
  }
});

test("unavailability follows the current extraction generation, so recovered publishers are not suppressed", () => {
  const store = fixtureStore();
  try {
    // dark-press items become unavailable, then a new extraction generation
    // succeeds for one of them.
    store.sqlite
      .query(
        "INSERT INTO processing_jobs(id,item_id,stage,generation,status,outcome,attempts,available_at,queued_at,created_at,result) VALUES('job-dark-1-retry','dark-1','extract',2,'done','extracted',0,?,?,?,?)",
      )
      .run(corpus.asOf, corpus.asOf, corpus.asOf, corpus.asOf);
    const run = generateSourceSuggestions(store, { now: corpus.asOf });
    // Two items are still unavailable, so the recovered dark-1 stopped
    // counting against the domain: the domain has 1 meaningful item left.
    expect(run.scanned.unavailableItems).toBe(2);
    expect(
      run.skipped.find((s) => s.domain === "dark-press.example")?.reason,
    ).toContain("1 meaningful");
  } finally {
    store.close();
  }
});

test("a stale unavailable generation is ignored when a later generation extracted", () => {
  const store = fixtureStore();
  try {
    // Give dark-1 a successful extraction at generation 2, and enough
    // feedback for domain qualification to verify unavailability accounting.
    store.sqlite
      .query(
        "INSERT INTO processing_jobs(id,item_id,stage,generation,status,outcome,attempts,available_at,queued_at,created_at) VALUES('job-dark-1-g2','dark-1','extract',2,'done','extracted',0,?,?,?)",
      )
      .run(corpus.asOf, corpus.asOf, corpus.asOf);
    // Only the two remaining unavailable items count as unavailable.
    const run = generateSourceSuggestions(store, { now: corpus.asOf });
    expect(run.scanned.unavailableItems).toBe(2);
    const dark = run.skipped.find((s) => s.domain === "dark-press.example");
    expect(dark?.reason).toContain("only 1 meaningful distinct items");
  } finally {
    store.close();
  }
});

test("duplicate metrics count distinct mirror items and never exceed a duplicate rate of 1", () => {
  const store = fixtureStore();
  try {
    // Repeated discoveries of one mirror item are collapsed to one duplicate.
    for (let i = 0; i < 4; i++) {
      store.sqlite
        .query(
          "INSERT INTO discovery_results(page_id,item_id,url,title,snippet,published_at,observed_at,origin) VALUES('page-fixture','mirror-1',?,?,?,?,?,'discovered')",
        )
        .run(
          "https://mirror-daily.example/agents-eval",
          "Agent evaluation harness shares task suites",
          "",
          corpus.items.find((i) => i.id === "mirror-1")!.publishedAt,
          corpus.asOf,
        );
    }
    const run = generateSourceSuggestions(store, { now: corpus.asOf });
    const skippedMirror = run.skipped.find(
      (s) => s.domain === "mirror-daily.example",
    );
    expect(skippedMirror).toBeDefined();
    // Rate never >1 because mirrors are counted once per distinct item.
    const mirrored = run.suggestions.every((s) => s.stats.duplicateRate <= 1);
    expect(mirrored).toBe(true);
  } finally {
    store.close();
  }
});

test("feed candidates come from extraction-recorded link elements; patterns only as fallback", () => {
  const store = fixtureStore();
  try {
    const run = generateSourceSuggestions(store, { now: corpus.asOf });
    const signal = run.suggestions.find(
      (s) => s.id === "domain:signal-press.example",
    )!;
    // Nonstandard feed URL recorded by the extraction fetch.
    expect(signal.url).toBe("https://signal-press.example/feeds/index.rss");
    expect(signal.feedCandidates).toEqual([
      {
        url: "https://signal-press.example/feeds/index.rss",
        provenance: "link-element",
      },
    ]);
    expect(
      signal.feedCandidates.every((c) => c.provenance === "link-element"),
    ).toBe(true);
    // field-notes has no recorded declarations; conservative patterns apply.
    const field = run.suggestions.find(
      (s) => s.id === "domain:field-notes.example",
    )!;
    expect(
      field.feedCandidates.every((c) => c.provenance === "url-pattern"),
    ).toBe(true);
  } finally {
    store.close();
  }
});

test("operator-suppressed suggestions do not consume the actionable suggestion limit", () => {
  const store = fixtureStore();
  try {
    refreshSourceSuggestions(store, { now: corpus.asOf });
    dismissSourceSuggestion(
      store,
      "domain:signal-press.example",
      corpus.asOf + 1,
    );
    const run = refreshSourceSuggestions(store, {
      now: corpus.asOf + 2,
      limit: 2,
    });
    // The dismissed candidate is not actionable and does not consume a slot:
    // both remaining qualifying domains fit the limit of 2.
    expect(run.suggestions.map((s) => s.id)).toEqual([
      "domain:field-notes.example",
      "domain:mixed-review.example",
    ]);
    expect(run.suppressed.map((s) => s.suggestion.id)).toEqual([
      "domain:signal-press.example",
    ]);
    expect(run.suppressed[0]!.state).toBe("dismissed");
    // All qualifying candidates are persisted; suppressed rows keep decisions.
    const acceptedStates = new Map(
      new SourceSuggestionStore(store.sqlite)
        .list()
        .map((row) => [row.id, row.state]),
    );
    expect(acceptedStates.get("domain:signal-press.example")).toBe("dismissed");
    expect(acceptedStates.get("domain:field-notes.example")).toBe("proposed");
    expect(acceptedStates.get("domain:mixed-review.example")).toBe("proposed");
    expect(run.pendingBeyondLimit).toEqual([]);
  } finally {
    store.close();
  }
});

test("pendingBeyondLimit persists qualifying candidates beyond the display limit", () => {
  const store = fixtureStore();
  try {
    const run = refreshSourceSuggestions(store, {
      now: corpus.asOf,
      limit: 2,
    });
    expect(run.suggestions.length).toBe(2);
    expect(run.pendingBeyondLimit).toEqual(["domain:mixed-review.example"]);
    // Persisted for review regardless of the display slice.
    expect(
      new SourceSuggestionStore(store.sqlite).get(
        "domain:mixed-review.example",
      ),
    ).toBeDefined();
  } finally {
    store.close();
  }
});

test("reconciliation expires ineligible proposals and renews them when they qualify again", () => {
  const store = fixtureStore();
  try {
    refreshSourceSuggestions(store, { now: corpus.asOf });
    const suggestions = new SourceSuggestionStore(store.sqlite);
    // Remove the useful feedback that made signal-press qualify.
    store.sqlite
      .query(
        "DELETE FROM item_feedback WHERE item_id IN ('sp-agents','sp-lint','sp-quantum')",
      )
      .run();
    const declined = refreshSourceSuggestions(store, { now: corpus.asOf + 1 });
    expect(declined.expired).toContain("domain:signal-press.example");
    expect(suggestions.get("domain:signal-press.example")!.state).toBe(
      "expired",
    );
    // An expired suggestion cannot be accepted without revalidation.
    expect(() =>
      acceptSourceSuggestion(store, "domain:signal-press.example", {
        now: corpus.asOf + 2,
      }),
    ).toThrow(/Expired/);
    // Restore the feedback; the next refresh renews the proposal with the
    // full audit trail preserved.
    store.sqlite
      .query(
        "INSERT INTO item_feedback(id,item_id,useful,source,created_at) VALUES('fb-again','sp-agents',1,'mcp',?)",
      )
      .run(corpus.asOf);
    const renewed = refreshSourceSuggestions(store, { now: corpus.asOf + 3 });
    expect(renewed.suggestions.map((s) => s.id)).toContain(
      "domain:signal-press.example",
    );
    const events = store.sqlite
      .query<{ from_state: string; to_state: string }, []>(
        "SELECT from_state,to_state FROM source_suggestion_events WHERE suggestion_id='domain:signal-press.example' ORDER BY id",
      )
      .all();
    expect(events).toEqual([
      { from_state: "proposed", to_state: "expired" },
      { from_state: "expired", to_state: "proposed" },
    ]);
    expect(suggestions.get("domain:signal-press.example")!.state).toBe(
      "proposed",
    );
  } finally {
    store.close();
  }
});

test("concurrent decisions serialize: the write lock re-reads state before a transition commits", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suggestion-race-"));
  const dbPath = path.join(dir, "db.sqlite");
  try {
    const first = createSourceSuggestionDatabase(corpus, dbPath);
    refreshSourceSuggestions(first, { now: corpus.asOf });
    first.close();

    // Two independent connections observe the same persisted proposal.
    const a = new Store(dbPath);
    const b = new Store(dbPath);
    const bDismissed = dismissSourceSuggestion(
      b,
      "domain:signal-press.example",
      corpus.asOf + 5,
    );
    expect(bDismissed.changed).toBe(true);
    // A stale command on the other connection re-reads inside its immediate
    // transaction instead of copying the stale acceptance over the newer
    // decision, and a second dismissal is a no-op replay.
    const aReplay = dismissSourceSuggestion(
      a,
      "domain:signal-press.example",
      corpus.asOf + 6,
    );
    expect(aReplay).toEqual({
      state: "dismissed",
      changed: false,
      acceptedSourceId: null,
    });
    expect(
      count(
        b,
        "SELECT count(*) AS n FROM source_suggestion_events WHERE suggestion_id='domain:signal-press.example'",
      ),
    ).toBe(1);
    // A muted suggestion is protected against a concurrent acceptance on
    // another connection: the accept re-reads the committed state inside its
    // immediate transaction and fails closed instead of following a muted
    // suggestion.
    muteSourceSuggestion(a, "domain:field-notes.example", corpus.asOf + 7);
    expect(() =>
      acceptSourceSuggestion(b, "domain:field-notes.example", {
        now: corpus.asOf + 8,
      }),
    ).toThrow(/Muted/);
    a.close();
    b.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("acceptance is all-or-nothing: a crash after the source write rolls back to the previous state", () => {
  const store = fixtureStore();
  try {
    refreshSourceSuggestions(store, { now: corpus.asOf });
    const sourcesBefore = count(store, "SELECT count(*) AS n FROM sources");
    // Wrap addSource so it records the subscription row and then throws,
    // simulating a crash between the source write and the decision/audit
    // writes before the state machine runs.
    const realAddSource = store.addSource.bind(store);
    (store as unknown as { addSource: typeof realAddSource }).addSource = (
      url: string,
      title: string,
      pollSeconds?: number,
    ) => {
      void realAddSource(url, title, pollSeconds);
      throw new Error("simulated crash after source write");
    };
    expect(() =>
      acceptSourceSuggestion(store, "domain:signal-press.example", {
        now: corpus.asOf + 1,
      }),
    ).toThrow(/simulated crash/);
    // The immediate transaction rolled back: no subscription, no accepted
    // state, no audit event.
    expect(count(store, "SELECT count(*) AS n FROM sources")).toBe(
      sourcesBefore,
    );
    const record = new SourceSuggestionStore(store.sqlite).get(
      "domain:signal-press.example",
    )!;
    expect(record.state).toBe("proposed");
    expect(record.acceptedSourceId).toBeNull();
    expect(
      count(
        store,
        "SELECT count(*) AS n FROM source_suggestion_events WHERE to_state='accepted'",
      ),
    ).toBe(0);
    // The retried accept commits completely: subscription, state and audit.
    (store as unknown as { addSource: typeof realAddSource }).addSource =
      realAddSource;
    const outcome = acceptSourceSuggestion(
      store,
      "domain:signal-press.example",
      {
        now: corpus.asOf + 2,
      },
    );
    expect(outcome.changed).toBe(true);
    expect(
      new SourceSuggestionStore(store.sqlite).get(
        "domain:signal-press.example",
      )!.state,
    ).toBe("accepted");
    expect(
      count(
        store,
        "SELECT count(*) AS n FROM source_suggestion_events WHERE to_state='accepted' AND suggestion_id='domain:signal-press.example'",
      ),
    ).toBe(1);
  } finally {
    store.close();
  }
});
