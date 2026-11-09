import type { Store } from "./db/store";
import { DigestStore } from "./db/digest-store";
import { DeliveryStore } from "./db/delivery-store";
import { digestDefaults, freezeDigest, previewDigest } from "./digest-service";
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
    runPublicationSchedule(
      this.store.sqlite,
      this.options,
      (date, asOf, isHistorical) => {
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
        if (isHistorical) return "skipped";
        const options = {
          ...digestDefaults(date, asOf),
          timezone: this.options.timezone,
        };
        const preview = previewDigest(this.store, options);
        if (preview.draft.status === "no_digest") return "empty";
        if (preview.draft.status !== "ready") return "processing";
        this.deliveries.prepare(
          date,
          this.options.to,
          this.options.from,
          () =>
            freezeDigest(this.store, options, preview.confirmation.hash, asOf),
          asOf,
        );
        return "prepared";
      },
      now,
    );
    await this.sender.send(now);
  }
}
