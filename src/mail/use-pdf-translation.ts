import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { api, responseJson } from "@/lib/api";
import { MAX_TRANSLATION_CHARACTERS } from "../../shared/mail-translation";
import { browserLanguage } from "./translation-language";

export function usePdfTranslation({ document, page, url, messageId, mailboxId }: {
  document: PDFDocumentProxy | null;
  page: number;
  url: string;
  messageId: string;
  mailboxId: string;
}) {
  const [visible, setVisible] = useState(false);
  const [language, setLanguage] = useState(browserLanguage);
  const translation = useQuery({
    queryKey: ["pdf-translation", url, page, language],
    enabled: visible && Boolean(document),
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!document) throw new Error("PDF is not loaded");
      const pdfPage = await document.getPage(page);
      const content = await pdfPage.getTextContent();
      const text = content.items.map((item) =>
        "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""
      ).join("").trim();
      if (!text) return null;
      if (text.length > MAX_TRANSLATION_CHARACTERS) throw new Error("Page is too long to translate");
      signal.throwIfAborted();
      const response = await api.api.mail.messages[":id"].translate.$post({
        param: { id: messageId }, query: { mailboxId },
        json: { language, segments: [text] },
      }, { init: { signal } });
      return (await responseJson(response)).translations[0];
    },
  });
  return { visible, setVisible, language, setLanguage, translation };
}
