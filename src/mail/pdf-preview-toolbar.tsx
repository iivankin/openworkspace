import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Minus, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { usePdfViewer } from "./use-pdf-viewer";

export function PdfPreviewToolbar({ pdf }: { pdf: ReturnType<typeof usePdfViewer> }) {
  const [pageInput, setPageInput] = useState("1");
  const [query, setQuery] = useState("");
  useEffect(() => setPageInput(String(pdf.page)), [pdf.page]);
  const disabled = !pdf.ready || Boolean(pdf.error);
  const pages = pdf.document?.numPages ?? 0;

  function goToPage(page: number) {
    if (pdf.viewerRef.current && Number.isInteger(page) && page >= 1 && page <= pages) {
      pdf.viewerRef.current.currentPageNumber = page;
    }
    setPageInput(String(pdf.viewerRef.current?.currentPageNumber ?? 1));
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
      <div className="flex items-center gap-1">
        <Button size="icon-xs" variant="ghost" aria-label="Previous page" disabled={disabled || pdf.page <= 1} onClick={() => goToPage(pdf.page - 1)}>
          <ChevronLeft />
        </Button>
        <input
          aria-label="Page number" inputMode="numeric" className="h-7 w-12 rounded border bg-transparent text-center text-xs tabular-nums"
          value={pageInput} disabled={disabled} onChange={(event) => setPageInput(event.target.value)}
          onBlur={() => goToPage(Number(pageInput))}
          onKeyDown={(event) => { if (event.key === "Enter") goToPage(Number(pageInput)); }}
        />
        <span className="text-xs tabular-nums text-muted-foreground">/ {pages || "—"}</span>
        <Button size="icon-xs" variant="ghost" aria-label="Next page" disabled={disabled || pdf.page >= pages} onClick={() => goToPage(pdf.page + 1)}>
          <ChevronRight />
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <Button size="icon-xs" variant="ghost" aria-label="Zoom out" disabled={disabled} onClick={() => pdf.viewerRef.current?.decreaseScale()}><Minus /></Button>
        <span aria-label="Zoom level" className="w-10 text-center text-xs tabular-nums">{Math.round(pdf.scale * 100)}%</span>
        <Button size="icon-xs" variant="ghost" aria-label="Zoom in" disabled={disabled} onClick={() => pdf.viewerRef.current?.increaseScale()}><Plus /></Button>
        <Button size="xs" variant="ghost" disabled={disabled} onClick={() => {
          if (pdf.viewerRef.current) pdf.viewerRef.current.currentScaleValue = "page-width";
        }}>Fit width</Button>
      </div>
      <div role="search" className="flex w-full min-w-0 items-center gap-1 sm:ml-auto sm:w-auto sm:max-w-80 sm:flex-1">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          type="search" aria-label="Find in PDF" placeholder="Find in document"
          className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={query} disabled={disabled}
          onChange={(event) => { setQuery(event.target.value); pdf.find(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); pdf.find(query, true, event.shiftKey); }
          }}
        />
        {query && <span role="status" className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{pdf.matches.current} / {pdf.matches.total}</span>}
        <Button size="icon-xs" variant="ghost" aria-label="Previous match" disabled={disabled || !query || !pdf.matches.total} onClick={() => pdf.find(query, true, true)}><ChevronLeft /></Button>
        <Button size="icon-xs" variant="ghost" aria-label="Next match" disabled={disabled || !query || !pdf.matches.total} onClick={() => pdf.find(query, true)}><ChevronRight /></Button>
      </div>
    </div>
  );
}
