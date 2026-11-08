import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  planStories,
  STORY_RULE_VERSION,
  type StoryInput,
  type StoryPlan,
} from "../story-grouping";

interface RawItem {
  id: string;
  identity: string;
  url: string | null;
  title: string;
  body: string;
  extracted: string | null;
  published_at: number | null;
  ingested_at: number;
}
interface CurrentMembership {
  item_id: string;
  group_id: string;
  evidence: string;
  rule_version: string;
}
interface CurrentRelation {
  id: number;
  older_group_id: string;
  newer_group_id: string;
  reason: string;
  evidence: string;
  rule_version: string;
}
export interface GroupingResult {
  changed: boolean;
  stale?: boolean;
  groups: number;
  members: number;
}

function extractedText(raw: RawItem): string {
  if (!raw.extracted) return raw.body;
  try {
    const result: unknown = JSON.parse(raw.extracted);
    if (
      result &&
      typeof result === "object" &&
      "text" in result &&
      typeof result.text === "string" &&
      result.text.trim()
    )
      return result.text;
  } catch {
    // A historic extraction result may not be structured JSON.
  }
  return raw.body;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * SQLite adapter for the pure story planner. All writes are idempotent and
 * transactionally reconciled; superseded memberships/relations are retained.
 */
export class StoryStore {
  constructor(private readonly sqlite: Database) {}

  private inputs(): StoryInput[] {
    const rows = this.sqlite
      .query<RawItem, []>(
        "SELECT i.id,i.identity,i.url,i.title,i.published_at,i.ingested_at," +
          "coalesce(c.text,'') AS body," +
          "(SELECT p.result FROM processing_jobs p WHERE p.item_id=i.id " +
          "AND p.stage='extract' AND p.status='done' AND p.outcome='extracted' " +
          "ORDER BY p.generation DESC LIMIT 1) AS extracted " +
          "FROM items i LEFT JOIN content c ON c.item_id=i.id ORDER BY i.identity,i.id",
      )
      .all();
    return rows.map((row) => ({
      id: row.id,
      identity: row.identity,
      url: row.url,
      title: row.title,
      text: extractedText(row),
      publishedAt: row.published_at,
      ingestedAt: row.ingested_at,
    }));
  }

  /**
   * Planning is outside the write transaction. The snapshot is revalidated
   * under BEGIN IMMEDIATE so a concurrent writer cannot commit a stale plan.
   */
  reconcile(now = Date.now()): GroupingResult {
    const prior = this.sqlite
      .query<{ fingerprint: string }, []>(
        "SELECT fingerprint FROM story_grouping_state WHERE id=1",
      )
      .get();
    // All evidence mutations mark the snapshot dirty transactionally.
    // Subsequent queued jobs may therefore skip the full library scan.
    if (prior?.fingerprint.startsWith(STORY_RULE_VERSION + ":"))
      return { changed: false, groups: 0, members: 0 };
    const inputs = this.inputs();
    const snapshotHash = hash([STORY_RULE_VERSION, inputs]);
    const fingerprint = STORY_RULE_VERSION + ":" + snapshotHash;
    const plan = planStories(inputs);
    return this.sqlite
      .transaction(() => {
        if (hash([STORY_RULE_VERSION, this.inputs()]) !== snapshotHash)
          return {
            changed: false,
            stale: true,
            groups: 0,
            members: 0,
          };
        const current = this.sqlite
          .query<CurrentMembership, []>(
            "SELECT item_id,group_id,evidence,rule_version FROM story_memberships WHERE ended_at IS NULL",
          )
          .all();
        const target = new Map<
          string,
          { groupId: string; evidence: string; version: string }
        >();
        for (const group of plan.groups) {
          this.sqlite
            .query(
              "INSERT INTO story_groups(id,first_seen) VALUES(?,?) " +
                "ON CONFLICT(id) DO UPDATE SET retired_at=NULL",
            )
            .run(group.id, now);
          for (const member of group.members)
            target.set(member.itemId, {
              groupId: group.id,
              evidence: JSON.stringify(member.evidence),
              version: plan.version,
            });
        }

        // Close old rows first to honour the single-current-membership index.
        for (const row of current) {
          const next = target.get(row.item_id);
          if (
            !next ||
            next.groupId !== row.group_id ||
            next.evidence !== row.evidence ||
            next.version !== row.rule_version
          )
            this.sqlite
              .query(
                "UPDATE story_memberships SET ended_at=? WHERE item_id=? AND ended_at IS NULL",
              )
              .run(now, row.item_id);
        }
        const unchanged = new Set(
          current
            .filter((row) => {
              const next = target.get(row.item_id);
              return (
                next?.groupId === row.group_id &&
                next.evidence === row.evidence &&
                next.version === row.rule_version
              );
            })
            .map((row) => row.item_id),
        );
        for (const [itemId, next] of target) {
          if (unchanged.has(itemId)) continue;
          this.sqlite
            .query(
              "INSERT INTO story_memberships(group_id,item_id,evidence,rule_version,started_at) VALUES(?,?,?,?,?)",
            )
            .run(next.groupId, itemId, next.evidence, next.version, now);
        }
        const groupIds = new Set(plan.groups.map((group) => group.id));
        const existingGroups = this.sqlite
          .query<{ id: string }, []>(
            "SELECT id FROM story_groups WHERE retired_at IS NULL",
          )
          .all();
        for (const group of existingGroups)
          if (!groupIds.has(group.id))
            this.sqlite
              .query("UPDATE story_groups SET retired_at=? WHERE id=?")
              .run(now, group.id);

        this.reconcileRelations(plan, now);
        this.sqlite
          .query(
            "INSERT INTO story_grouping_state(id,fingerprint,updated_at) VALUES(1,?,?) " +
              "ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,updated_at=excluded.updated_at",
          )
          .run(fingerprint, now);
        return {
          changed: true,
          groups: plan.groups.length,
          members: target.size,
        };
      })
      .immediate();
  }

  private reconcileRelations(plan: StoryPlan, now: number): void {
    const current = this.sqlite
      .query<CurrentRelation, []>(
        "SELECT id,older_group_id,newer_group_id,reason,evidence,rule_version " +
          "FROM story_relations WHERE ended_at IS NULL",
      )
      .all();
    const key = (older: string, newer: string) => older + "\n" + newer;
    const next = new Map<
      string,
      StoryPlan["relations"][number] & { evidence: string }
    >(
      plan.relations.map((relation) => [
        key(relation.olderGroupId, relation.newerGroupId),
        {
          ...relation,
          evidence: JSON.stringify({ sharedTerms: relation.sharedTerms }),
        },
      ]),
    );
    for (const row of current) {
      const target = next.get(key(row.older_group_id, row.newer_group_id));
      if (
        target?.reason === row.reason &&
        target.evidence === row.evidence &&
        row.rule_version === plan.version
      ) {
        next.delete(key(row.older_group_id, row.newer_group_id));
        continue;
      }
      this.sqlite
        .query("UPDATE story_relations SET ended_at=? WHERE id=?")
        .run(now, row.id);
    }
    for (const relation of next.values())
      this.sqlite
        .query(
          "INSERT INTO story_relations(older_group_id,newer_group_id,reason,evidence,rule_version,started_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          relation.olderGroupId,
          relation.newerGroupId,
          relation.reason,
          relation.evidence,
          plan.version,
          now,
        );
  }

  forItem(itemId: string) {
    const rows = this.sqlite
      .query<
        {
          group_id: string;
          evidence: string;
          rule_version: string;
          original_item_id: string | null;
          started_at: number;
          ended_at: number | null;
        },
        [string]
      >(
        "SELECT group_id,evidence,rule_version,original_item_id,started_at,ended_at " +
          "FROM story_memberships WHERE item_id=? ORDER BY id DESC",
      )
      .all(itemId);
    return {
      current: (() => {
        const active = rows.find((row) => row.ended_at === null);
        return active
          ? { ...active, evidence: JSON.parse(active.evidence) as unknown }
          : null;
      })(),
      history: rows.map((row) => ({
        ...row,
        evidence: JSON.parse(row.evidence) as unknown,
      })),
    };
  }

  group(id: string) {
    const group = this.sqlite
      .query<
        { id: string; first_seen: number; retired_at: number | null },
        [string]
      >("SELECT * FROM story_groups WHERE id=?")
      .get(id);
    if (!group) return null;
    const members = this.sqlite
      .query<
        {
          item_id: string;
          original_item_id: string | null;
          evidence: string;
          rule_version: string;
          started_at: number;
          ended_at: number | null;
        },
        [string]
      >(
        "SELECT item_id,original_item_id,evidence,rule_version,started_at,ended_at " +
          "FROM story_memberships WHERE group_id=? ORDER BY id",
      )
      .all(id)
      .map((member) => ({
        ...member,
        evidence: JSON.parse(member.evidence) as unknown,
      }));
    const relations = this.sqlite
      .query<
        {
          older_group_id: string;
          newer_group_id: string;
          reason: string;
          evidence: string;
          started_at: number;
          ended_at: number | null;
        },
        [string, string]
      >(
        "SELECT older_group_id,newer_group_id,reason,evidence,started_at,ended_at " +
          "FROM story_relations WHERE older_group_id=? OR newer_group_id=? ORDER BY id",
      )
      .all(id, id)
      .map((relation) => ({
        ...relation,
        evidence: JSON.parse(relation.evidence) as unknown,
      }));
    return { ...group, version: STORY_RULE_VERSION, members, relations };
  }

  status() {
    return {
      groups: this.sqlite
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM story_groups WHERE retired_at IS NULL",
        )
        .get()!.count,
      current_memberships: this.sqlite
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM story_memberships WHERE ended_at IS NULL",
        )
        .get()!.count,
      rule_version: STORY_RULE_VERSION,
    };
  }
}
