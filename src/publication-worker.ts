import type { Store } from "./db/store";
import { DigestStore } from "./db/digest-store";
import { DeliveryStore } from "./db/delivery-store";
import { digestDefaults, freezeDigest, previewDigest } from "./digest-service";
import { historicalDigestDraft } from "./historical-digest";
import {
  runPublicationSchedule,
  type PublicationSchedule,
} from "./publication-schedule";
import { DeliveryWorker } from "./delivery";

/** Calendar, frozen digest, and outbox commit together before any network work. */
export class PublicationWorker {
  constructor(
    private readonly store: Store,
    private readonly deliveries: DeliveryStore,
    private readonly sender: DeliveryWorker,
    private readonly options: PublicationSchedule & {
      from: string;
      to: string;
    },
  ) {}
  async tick(now = Date.now()) {
    try {
      runPublicationSchedule(
        this.store.sqlite,
        this.options,
        (date, asOf, isHistorical, scheduledAt) => {
          const existing = new DigestStore(this.store.sqlite).get(date);
          if (existing) {
            this.deliveries.prepare(
              date,
              this.options.to,
              this.options.from,
              () => existing,
              asOf,
            );
            return "prepared";
          }
          if (isHistorical) {
            if (scheduledAt === null)
              return {
                status: "unavailable",
                reason: "scheduled_instant_unavailable",
              };
            const historicalOptions = {
              ...digestDefaults(date, scheduledAt),
              timezone: this.options.timezone,
            };
            const draft = historicalDigestDraft(this.store, historicalOptions);
            if (draft.status === "blocked")
              return { status: "processing" as const, reason: draft.reason };
            if (draft.status === "unavailable")
              return {
                status: "unavailable" as const,
                reason: `${draft.reason}:candidates=${draft.candidateCount}`,
              };
            if (draft.status === "no_digest") return "empty";
            if (!draft.rendered)
              return {
                status: "unavailable",
                reason: "historical_render_missing",
              };
            this.deliveries.prepare(
              date,
              this.options.to,
              this.options.from,
              () =>
                new DigestStore(this.store.sqlite).freeze(
                  {
                    date,
                    timezone: historicalOptions.timezone,
                    subject: draft.rendered!.subject,
                    html: draft.rendered!.html,
                    text: draft.rendered!.text,
                    decisionSnapshot: {
                      asOf: scheduledAt,
                      reconstructed: true,
                      intake: draft.intake,
                      limits: {
                        minScore: historicalOptions.minScore,
                        maxItems: historicalOptions.maxItems,
                        maxPerInterest: historicalOptions.maxPerInterest,
                      },
                      decisions: draft.decisions,
                      decisionEvidence: draft.decisionEvidence,
                      feedbackTargets: draft.rendered!.feedbackTargets,
                    },
                    items: draft.selected.map((item) => ({
                      itemId: item.itemId,
                      groupId: item.groupId,
                      scoreId: item.scoreId,
                      snapshot: item,
                    })),
                  },
                  asOf,
                ),
              asOf,
            );
            return "prepared";
          }
          const options = {
            ...digestDefaults(date, asOf),
            timezone: this.options.timezone,
          };
          const since = Math.max(0, asOf - 86_400_000);
          const currentCandidates = this.store.sqlite
            .query<{ item_id: string }, [number, number]>(
              "SELECT item_id FROM digest_activity WHERE activity_at>? AND activity_at<=? ORDER BY activity_at DESC,item_id DESC LIMIT 500",
            )
            .all(since, asOf);
          const overlap = currentCandidates
            .filter((candidate) =>
              this.store.sqlite
                .query<
                  { item_id: string },
                  [string, string, string, string, string, string]
                >(
                  `SELECT di.item_id FROM digest_items di
                   JOIN digests d ON d.id=di.digest_id
                   JOIN deliveries x ON x.digest_id=d.id
                   WHERE d.edition_date<? AND x.status IN ('pending','sending','ambiguous')
                     AND (di.item_id=? OR di.item_id IN (
                       SELECT old_id FROM item_redirects WHERE item_id=? OR item_id=(SELECT item_id FROM item_redirects WHERE old_id=?)
                     ) OR di.item_id=(SELECT item_id FROM item_redirects WHERE old_id=?)
                     OR di.group_id=(SELECT group_id FROM story_memberships WHERE item_id=? AND ended_at IS NULL LIMIT 1)) LIMIT 1`,
                )
                .get(
                  date,
                  candidate.item_id,
                  candidate.item_id,
                  candidate.item_id,
                  candidate.item_id,
                  candidate.item_id,
                ),
            )
            .map((candidate) => candidate.item_id);
          if (overlap.length)
            return {
              status: "processing",
              reason: `prior_delivery_requires_reconciliation:${[...new Set(overlap)].sort().join(",")}`,
            };
          const preview = previewDigest(this.store, options);
          if (preview.draft.status === "no_digest") return "empty";
          if (preview.draft.status !== "ready") return "processing";
          this.deliveries.prepare(
            date,
            this.options.to,
            this.options.from,
            () =>
              freezeDigest(
                this.store,
                options,
                preview.confirmation.hash,
                asOf,
              ),
            asOf,
          );
          return "prepared";
        },
        now,
      );
    } finally {
      // A damaged new draft must not starve a previously persisted outbox.
      await this.sender.send(now);
    }
  }
}
