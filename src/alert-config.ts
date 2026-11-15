import { validateEmailAddress } from "./db/delivery-store";

/**
 * Opt-in event alerts (issue #27). Everything here is disabled by default:
 * a default deployment constructs no alert worker and sends nothing, so the
 * daily digest behavior is unchanged. Every threshold is an explicit,
 * user-configured value — none is inferred from scores or behavior.
 */
export interface AlertConfig {
  apiKey: string;
  /** Alert sender address (an opt-in channel distinct from the daily digest). */
  sender: string;
  /** Opt-in alert destination; alerts go nowhere without it. */
  recipient: string;
  /** Europe/London semantics by default; quiet hours are local-time. */
  timezone: string;
  /** Priority threshold: the shipped deterministic score total must be ≥. */
  minScore: number;
  /** Credibility threshold: the score's evidence component must be ≥. */
  minEvidence: number;
  /** "HH:MM" local times; alerts scheduled after quietEnd when frozen inside the window. */
  quietStart: { hour: number; minute: number } | null;
  quietEnd: { hour: number; minute: number } | null;
  /** Per-development cooldown between two alerts, in hours. */
  cooldownHours: number;
  /** Maximum alerts frozen on one local calendar date. */
  dailyCap: number;
}

function parseClock(
  value: string,
  label: string,
): { hour: number; minute: number } {
  const match = /^(\d\d):(\d\d)$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
    throw new Error(`Invalid alert quiet-hours time (${label})`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Sending alerts is strictly opt-in; incomplete settings fail closed. */
export function alertConfig(
  env: Record<string, string | undefined> = process.env,
): AlertConfig | null {
  const enabled = env.ALERTS_ENABLED ?? "false";
  if (enabled === "false" || enabled === "") return null;
  if (enabled !== "true")
    throw new Error("ALERTS_ENABLED must be true or false");
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is required for alerts");
  const sender = validateEmailAddress(
    env.ALERTS_FROM ?? env.DELIVERY_FROM ?? "",
  );
  const recipient = validateEmailAddress(env.ALERTS_TO ?? "");
  const timezone = env.ALERTS_TIMEZONE || "Europe/London";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new Error("Invalid alert timezone");
  }
  const minScore = Number(env.ALERTS_MIN_SCORE ?? "75");
  const minEvidence = Number(env.ALERTS_MIN_EVIDENCE ?? "60");
  if (
    !Number.isInteger(minScore) ||
    minScore < 1 ||
    minScore > 100 ||
    !Number.isInteger(minEvidence) ||
    minEvidence < 1 ||
    minEvidence > 100
  )
    throw new Error("ALERTS_MIN_SCORE and ALERTS_MIN_EVIDENCE must be 1..100");
  const quietStartRaw = env.ALERTS_QUIET_START?.trim() || "22:00";
  const quietEndRaw = env.ALERTS_QUIET_END?.trim() || "07:00";
  const quietStart =
    quietStartRaw === "none" ? null : parseClock(quietStartRaw, "start");
  const quietEndRawValue = quietEndRaw === "none" ? null : quietEndRaw;
  const quietEnd = quietEndRawValue
    ? parseClock(quietEndRawValue, "end")
    : null;
  if ((quietStart === null) !== (quietEnd === null))
    throw new Error(
      "ALERTS_QUIET_START and ALERTS_QUIET_END must both be set or both be 'none'",
    );
  const cooldownHours = Number(env.ALERTS_COOLDOWN_HOURS ?? "12");
  const dailyCap = Number(env.ALERTS_DAILY_CAP ?? "3");
  if (
    !Number.isInteger(cooldownHours) ||
    cooldownHours < 0 ||
    cooldownHours > 168
  )
    throw new Error("ALERTS_COOLDOWN_HOURS must be 0..168");
  if (!Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > 50)
    throw new Error("ALERTS_DAILY_CAP must be 1..50");
  return {
    apiKey,
    sender,
    recipient,
    timezone,
    minScore,
    minEvidence,
    quietStart,
    quietEnd,
    cooldownHours,
    dailyCap,
  };
}

export const ALERTS_DECISION_VERSION = "event-alerts-v1";
export const ALERT_EVIDENCE_VERSION = "development-change-v1";
