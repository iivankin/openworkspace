import { DurableObject } from "cloudflare:workers";
import { officePreviewExtension, officePreviewKey } from "../../shared/office-preview";
import { convertOfficeDocument, type OfficeConversionResult } from "./office-conversion";

export class OfficePreviewContainer extends DurableObject<Env> {
  private conversion: Promise<OfficeConversionResult> | null = null;

  async convert(sourceKey: string, extension: string) {
    if (officePreviewExtension(`document.${extension}`) !== extension) return "failed" as const;
    // Queue redelivery can overlap. Each attachment uses its own Durable Object,
    // so duplicate requests share one conversion and cannot stop each other's container.
    if (this.conversion) return this.conversion;
    this.conversion = this.runConversion(sourceKey, extension);
    try {
      return await this.conversion;
    } finally {
      this.conversion = null;
    }
  }

  private async runConversion(sourceKey: string, extension: string): Promise<OfficeConversionResult> {
    if (await this.env.MAIL_STORAGE.head(officePreviewKey(sourceKey))) return "ready";
    const container = this.ctx.container;
    if (!container) throw new Error("Office preview container is not configured");
    try {
      if (!container.running) container.start({ enableInternet: false });
      await container.setInactivityTimeout(10_000);
      const port = container.getTcpPort(3000);
      await waitForConverter(port);
      return await convertOfficeDocument(
        this.env.MAIL_STORAGE,
        (request) => port.fetch(request),
        sourceKey,
        extension,
      );
    } finally {
      // R2 has consumed the PDF before this runs; no container is kept warm.
      await container.destroy();
    }
  }
}

async function waitForConverter(port: Fetcher) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await port.fetch("http://container/health", {
        signal: AbortSignal.timeout(1_000),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // The container process starts before its HTTP port is ready.
    }
    await scheduler.wait(500);
  }
  throw new Error("Office preview container did not become ready");
}
