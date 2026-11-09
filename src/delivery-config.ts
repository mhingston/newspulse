import { validateEmailAddress } from "./db/delivery-store";

export interface DeliveryConfig {
  apiKey: string;
  sender: string;
  recipient: string;
  timezone: string;
  hour: number;
  minute: number;
}

/** Sending is opt-in and incomplete settings fail closed. */
export function deliveryConfig(
  env: Record<string, string | undefined> = process.env,
): DeliveryConfig | null {
  const enabled = env.DELIVERY_ENABLED ?? "false";
  if (enabled === "false" || enabled === "") return null;
  if (enabled !== "true")
    throw new Error("DELIVERY_ENABLED must be true or false");
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is required for delivery");
  const sender = validateEmailAddress(env.DELIVERY_FROM ?? "");
  const recipient = validateEmailAddress(env.DELIVERY_TO ?? "");
  const timezone = env.DELIVERY_TIMEZONE || "Europe/London";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new Error("Invalid delivery timezone");
  }
  const time = /^(\d\d):(\d\d)$/.exec(env.DELIVERY_TIME || "06:00");
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59)
    throw new Error("Invalid delivery time");
  return {
    apiKey,
    sender,
    recipient,
    timezone,
    hour: Number(time[1]),
    minute: Number(time[2]),
  };
}
