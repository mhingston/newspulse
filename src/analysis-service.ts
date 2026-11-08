import { ProfileStore } from "./profiles";
import { AnalysisBudget } from "./analysis-budget";
import {
  AnalysisHttpError,
  CompletedAnalysisError,
  type OpenAICompatibleAnalysis,
} from "./adapters/analysis";
import type { Store, ProcessingJob } from "./db/store";

export interface AnalysisOptions {
  provider: string;
  model: string;
  promptVersion: string;
  reserveTokens: number;
  reserveMicros: number;
}
/** An ambiguous dispatch retains its reservation; do not automatically charge twice. */
export function analysisHandler(
  store: Store,
  client: OpenAICompatibleAnalysis,
  budget: AnalysisBudget,
  options: AnalysisOptions,
) {
  return async (job: ProcessingJob, signal: AbortSignal) => {
    const item = store.getItem(job.item_id);
    if (!item) throw new Error("Item not found");
    const extracted = store.processingResult(
      "extract",
      job.item_id,
      job.generation,
    );
    const parsed: { text?: string; sourceUrl?: string } = extracted
      ? JSON.parse(extracted)
      : {};
    const text = parsed.text || item.text;
    const ref = (
      item.references as {
        source_id: string;
        native_id: string;
        url: string | null;
      }[]
    )[0];
    const source =
      parsed.sourceUrl ||
      item.url ||
      ref?.url ||
      (ref ? `source:${ref.source_id}:${ref.native_id}` : null);
    if (!text || !source) return { status: "unavailable" };
    const inputHash = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify([text, source, client.identity()]))
      .digest("hex");
    const profileStore = new ProfileStore(store.sqlite);
    const active = profileStore.activeInterests();
    const profiles = [...active, ...profileStore.latestEditorial()];
    client.prepare(text, source, profiles);
    const prior = store.sqlite
      .query<
        { result: string; usage: string | null; cost: number | null },
        [string, string, string, string, string, string]
      >(
        "SELECT result,usage,cost FROM analyses WHERE item_id=? AND input_hash=? AND provider=? AND model=? AND prompt_version=? AND profiles=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(
        job.item_id,
        inputHash,
        options.provider,
        options.model,
        options.promptVersion,
        JSON.stringify(profiles),
      );
    if (prior)
      return {
        status: "analysed",
        analysisRecord: {
          inputHash,
          provider: options.provider,
          model: options.model,
          promptVersion: options.promptVersion,
          profiles,
          analysis: JSON.parse(prior.result) as { summary: string },
          usage: prior.usage ? JSON.parse(prior.usage) : null,
          cost: prior.cost,
        },
      };

    const key = new Bun.CryptoHasher("sha256")
      .update(
        JSON.stringify([
          job.item_id,
          inputHash,
          options.provider,
          options.model,
          options.promptVersion,
          profiles,
        ]),
      )
      .digest("hex");
    const cached = budget.result(key);
    if (cached)
      return {
        status: "analysed",
        analysisRecord: JSON.parse(
          cached,
        ) as import("./db/store").AnalysisRecord,
      };
    if (!budget.reserve(key, options.reserveTokens, options.reserveMicros))
      throw new Error(
        "Analysis budget unavailable or dispatch requires reconciliation",
      );
    let response: Awaited<ReturnType<OpenAICompatibleAnalysis["analyse"]>>;
    try {
      response = await client.analyse(text, source, signal, profiles);
    } catch (error) {
      if (
        (error instanceof AnalysisHttpError &&
          (error.status === 429 || error.status >= 500)) ||
        error instanceof CompletedAnalysisError
      )
        budget.reconcile(key);
      throw error;
    }
    const used = response.usage
      ? response.usage.inputTokens + response.usage.outputTokens
      : null;
    const analysisRecord = {
      inputHash,
      provider: options.provider,
      model: options.model,
      promptVersion: options.promptVersion,
      profiles,
      analysis: response.analysis,
      usage: response.usage,
      cost: null,
    };
    if (!budget.finish(key, JSON.stringify(analysisRecord), used))
      throw new Error("Analysis reservation lost");
    return { status: "analysed", analysisRecord };
  };
}
