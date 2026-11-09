import { scoreWithSpecialist } from "./scoring";
import type { ProcessingJob, Store } from "./db/store";

/** Calculate outside the transaction; the store revalidates the input before commit. */
export function scoringHandler(store: Store) {
  return async (job: ProcessingJob) => {
    const capturedAt = Date.now();
    const snapshot = store.scoringSnapshot(job, capturedAt);
    if (!snapshot) throw new Error("Scoring input is no longer current");
    const result = await scoreWithSpecialist(snapshot.input);
    return {
      status: "scored",
      scoreRecord: {
        capturedAt,
        inputHash: snapshot.inputHash,
        criteriaVersion: result.criteriaVersion,
        provenance: snapshot.provenance,
        result,
      },
    };
  };
}
