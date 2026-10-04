import { useEffect, useRef, useState } from "react";
import { AnnotationMode, getDocument, GlobalWorkerOptions, version, type PDFDocumentProxy } from "pdfjs-dist";
import { EventBus, PDFViewer, PDFLinkService, PDFFindController, LinkTarget } from "pdfjs-dist/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

export function usePdfViewer(url: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState({ current: 0, total: 0 });

  useEffect(() => {
    const container = containerRef.current;
    const pages = pagesRef.current;
    if (!container || !pages) return;
    const lifetime = new AbortController();
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
    const findController = new PDFFindController({ eventBus, linkService });
    const options = {
      container, viewer: pages, eventBus, linkService, findController,
      // Read-only attachments: no form editing, document scripts, or automatic downloads.
      annotationMode: AnnotationMode.ENABLE,
      maxCanvasPixels: 16_777_216,
      abortSignal: lifetime.signal,
    };
    const viewer = new PDFViewer(options);
    viewerRef.current = viewer;
    linkService.setViewer(viewer);
    // Re-fit when the viewport changes. PDFViewer's
    // own observer updates dimensions, but does not recalculate named zoom levels.
    const resize = new ResizeObserver(() => {
      if (!viewer.pdfDocument) return;
      if (viewer.currentScaleValue === "page-width") viewer.currentScaleValue = "page-width";
      viewer.update();
    });
    resize.observe(container);
    const listenerOptions = { signal: lifetime.signal };
    eventBus.on("pagesinit", () => {
      viewer.currentScaleValue = "page-width";
      setReady(true);
    }, listenerOptions);
    eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => setPage(pageNumber), listenerOptions);
    eventBus.on("scalechanging", ({ scale }: { scale: number }) => setScale(scale), listenerOptions);
    const updateMatches = ({ matchesCount }: { matchesCount: { current: number; total: number } }) => setMatches(matchesCount);
    eventBus.on("updatefindmatchescount", updateMatches, listenerOptions);
    eventBus.on("updatefindcontrolstate", updateMatches, listenerOptions);
    eventBus.on("pagerendered", ({ error }: { error?: Error }) => {
      if (error) setError("Could not render this PDF");
    }, listenerOptions);

    const assets = `/pdfjs/${version}/`;
    const task = getDocument({
      url,
      cMapUrl: `${assets}cmaps/`,
      standardFontDataUrl: `${assets}standard_fonts/`,
      wasmUrl: `${assets}wasm/`,
      iccUrl: `${assets}iccs/`,
      enableXfa: false,
    });
    void task.promise.then(async (pdf) => {
      if (lifetime.signal.aborted) return;
      linkService.setDocument(pdf);
      viewer.setDocument(pdf);
      setDocument(pdf);
      // PDFViewer reports initialization failures via its pages promise.
      await viewer.pagesPromise;
    }).catch((error: unknown) => {
      if (lifetime.signal.aborted) return;
      setError(error instanceof Error && error.name === "PasswordException"
        ? "This PDF requires a password" : "Could not open this PDF");
    });
    return () => {
      resize.disconnect();
      lifetime.abort();
      // PDF.js explicitly accepts null to detach; its generated declaration omits null.
      const detach = viewer.setDocument as (document: PDFDocumentProxy | null) => void;
      detach.call(viewer, null);
      linkService.setDocument(null);
      viewerRef.current = null;
      void task.destroy();
    };
  }, [url]);

  function find(query: string, again = false, previous = false) {
    viewerRef.current?.eventBus.dispatch("find", {
      source: containerRef.current, type: again ? "again" : "", query,
      caseSensitive: false, entireWord: false, highlightAll: true,
      findPrevious: previous, matchDiacritics: false,
    });
  }

  return { containerRef, pagesRef, viewerRef, document, page, scale, ready, error, matches, find };
}
