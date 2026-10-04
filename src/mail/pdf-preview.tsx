import { Languages, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PdfPreviewToolbar } from "./pdf-preview-toolbar";
import { usePdfViewer } from "./use-pdf-viewer";
import { usePdfTranslation } from "./use-pdf-translation";
import { browserLanguage, COMMON_LANGUAGES } from "./translation-language";
import "pdfjs-dist/web/pdf_viewer.css";
import "./pdf-preview.css";

export default function PdfPreview({ url, filename, messageId, mailboxId }: {
  url: string;
  filename: string;
  messageId: string;
  mailboxId: string;
}) {
  const pdf = usePdfViewer(url);
  const { visible, setVisible, language, setLanguage, translation } = usePdfTranslation({
    document: pdf.document, page: pdf.page, url, messageId, mailboxId,
  });
  const languages = COMMON_LANGUAGES.includes(language) ? COMMON_LANGUAGES : [language, ...COMMON_LANGUAGES];
  const displayNames = new Intl.DisplayNames([browserLanguage()], { type: "language" });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PdfPreviewToolbar pdf={pdf} />
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Button size="xs" variant="ghost" disabled={!pdf.ready || Boolean(pdf.error)} onClick={() => setVisible(!visible)}>
          {visible && translation.isFetching ? <LoaderCircle className="animate-spin" /> : <Languages />}
          {visible ? "Show original" : "Translate"}
        </Button>
        <select
          aria-label="PDF translation language" value={language}
          className="h-7 max-w-40 rounded-md border bg-transparent px-1.5 text-xs"
          onChange={(event) => setLanguage(event.target.value)}
        >
          {languages.map((code) => <option key={code} value={code}>{displayNames.of(code) ?? code}</option>)}
        </select>
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative min-h-0 min-w-0 flex-1 bg-surface-sunken">
          <div ref={pdf.containerRef} className="attachment-pdf-container absolute inset-0 overflow-auto" role="region" aria-label={`PDF: ${filename}`} tabIndex={0}>
            <div ref={pdf.pagesRef} className="pdfViewer" />
          </div>
          {(!pdf.ready || pdf.error) && (
            <div role="status" className="absolute inset-0 grid place-content-center justify-items-center gap-3 bg-surface-sunken p-6 text-muted-foreground">
              {pdf.error ?? <><LoaderCircle className="size-6 animate-spin" /><span className="sr-only">Loading PDF</span></>}
            </div>
          )}
        </div>
        {visible && (
          <section key={`${pdf.page}:${language}`} aria-label="PDF translation" lang={language} className="h-[40%] shrink-0 overflow-auto border-t p-4 md:h-auto md:w-80 md:border-t-0 md:border-l lg:w-96">
            <h3 className="mb-3 text-xs font-medium text-muted-foreground">Page {pdf.page}</h3>
            {translation.isPending ? (
              <div role="status" className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Translating…</div>
            ) : translation.isError ? (
              <div role="alert" className="space-y-2">
                <p>{translation.error.message}</p>
                <Button size="sm" variant="outline" disabled={translation.isFetching} onClick={() => void translation.refetch()}>Retry</Button>
              </div>
            ) : translation.data === null ? (
              <p role="status" className="text-muted-foreground">No selectable text on this page</p>
            ) : (
              <div dir="auto" className="whitespace-pre-wrap break-words text-sm leading-relaxed">{translation.data}</div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
