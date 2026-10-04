import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { api, responseJson } from "@/lib/api";
import { MAX_TRANSLATION_CHARACTERS, MAX_TRANSLATION_SEGMENTS } from "../../shared/mail-translation";
import { getPdfTranslationLayout } from "./pdf-translation-layout";
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
    queryKey: ["pdf-inline-translation", url, page, language],
    enabled: visible && Boolean(document),
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!document) throw new Error("PDF is not loaded");
      const pdfPage = await document.getPage(page);
      const layout = await getPdfTranslationLayout(pdfPage);
      if (!layout.blocks.length) return null;
      const segments = layout.blocks.filter((block) => block.translate).map((block) => block.text);
      if (!segments.length) return layout;
      if (segments.length > MAX_TRANSLATION_SEGMENTS || segments.join("").length > MAX_TRANSLATION_CHARACTERS) {
        throw new Error("Page is too long to translate");
      }
      signal.throwIfAborted();
      const response = await api.api.mail.messages[":id"].translate.$post({
        param: { id: messageId }, query: { mailboxId },
        json: { language, segments },
      }, { init: { signal } });
      const { translations } = await responseJson(response);
      if (translations.length !== segments.length || translations.some((text) => !text.trim())) {
        throw new Error("Incomplete page translation");
      }
      let index = 0;
      return { ...layout, blocks: layout.blocks.map((block) => ({
        ...block, text: block.translate ? translations[index++].replace(/\s+/gu, " ") : block.text,
      })) };
    },
  });
  return { visible, setVisible, language, setLanguage, translation };
}
