import { eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { settings } from "../db/schema";

const GLOBAL_AI_PROCESSING_KEY = "ai_processing_enabled";

export async function globalAiProcessingEnabled(binding: D1Database) {
  const [setting] = await createDb(binding)
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, GLOBAL_AI_PROCESSING_KEY))
    .limit(1);
  return setting?.value === "true";
}

export async function setGlobalAiProcessingEnabled(
  binding: D1Database,
  enabled: boolean,
) {
  const now = new Date();
  await createDb(binding)
    .insert(settings)
    .values({
      key: GLOBAL_AI_PROCESSING_KEY,
      value: String(enabled),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: String(enabled), updatedAt: now },
    });
  return { enabled };
}
