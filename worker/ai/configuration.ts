import { eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { installations } from "../db/schema";
import { INSTALLATION_ID } from "../auth/constants";

export async function globalAiProcessingEnabled(binding: D1Database) {
  const [installation] = await createDb(binding)
    .select({ enabled: installations.aiProcessingEnabled })
    .from(installations)
    .where(eq(installations.id, INSTALLATION_ID))
    .limit(1);
  return installation?.enabled ?? false;
}

export async function setGlobalAiProcessingEnabled(
  binding: D1Database,
  enabled: boolean,
) {
  const updated = await createDb(binding)
    .update(installations)
    .set({ aiProcessingEnabled: enabled })
    .where(eq(installations.id, INSTALLATION_ID))
    .returning({ enabled: installations.aiProcessingEnabled });
  return updated[0] ?? null;
}
