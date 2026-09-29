import { useMutation } from "@tanstack/react-query";
import { Languages, LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, responseJson } from "@/lib/api";
import {
  MAX_TRANSLATION_CHARACTERS,
  MAX_TRANSLATION_SEGMENTS,
} from "../../shared/mail-translation";
import { EmailHtmlBody } from "./email-html-body";
import { emailHtmlTextSegments } from "./translation-html";
import type { MessageDetail } from "./types";
import { useSanitizedEmailHtml } from "./use-sanitized-email-html";

const COMMON_LANGUAGES = [
  "en", "es", "fr", "de", "it", "pt", "ru", "uk", "sr", "tr",
  "ar", "hi", "zh", "ja", "ko",
];

function browserLanguage() {
  return navigator.languages?.[0] || navigator.language || "en";
}

export function MessageTranslation({
  message,
  mailboxId,
  onRenderModeChange,
}: {
  message: MessageDetail;
  mailboxId: string;
  onRenderModeChange: (renderAsHtml: boolean) => void;
}) {
  const [language, setLanguage] = useState(browserLanguage);
  const [result, setResult] = useState<{
    messageId: string;
    language: string;
    translations: string[];
  } | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const html = useSanitizedEmailHtml(message.bodyHtml, mailboxId, message);
  const sourceHtml = message.direction === "incoming"
    ? (html.data?.renderAsHtml ? html.data.srcDoc : null)
    : (html.data?.composerHtml || null);
  const segments = useMemo(() => sourceHtml
    ? emailHtmlTextSegments(sourceHtml)
    : [message.bodyText || message.preview].filter((text) => Boolean(text.trim())),
  [message.bodyText, message.preview, sourceHtml]);
  const translate = useMutation({
    mutationFn: async ({ targetLanguage, textSegments }: {
      targetLanguage: string;
      textSegments: string[];
    }) => {
      const response = await api.api.mail.messages[":id"].translate.$post({
        param: { id: message.id },
        query: { mailboxId },
        json: { language: targetLanguage, segments: textSegments },
      });
      return responseJson(response);
    },
  });
  const languages = COMMON_LANGUAGES.includes(language)
    ? COMMON_LANGUAGES
    : [language, ...COMMON_LANGUAGES];
  const displayNames = new Intl.DisplayNames([browserLanguage()], { type: "language" });
  const visible = showTranslation
    && result?.language === language
    && result.messageId === message.id;

  async function toggleTranslation() {
    if (visible) {
      setShowTranslation(false);
      return;
    }
    if (result?.language === language && result.messageId === message.id) {
      setShowTranslation(true);
      return;
    }
    if (!segments.length) {
      toast.error("Message has no text to translate");
      return;
    }
    if (segments.length > MAX_TRANSLATION_SEGMENTS
      || segments.join("").length > MAX_TRANSLATION_CHARACTERS) {
      toast.error("Message is too long to translate");
      return;
    }
    try {
      const response = await translate.mutateAsync({
        targetLanguage: language,
        textSegments: segments,
      });
      setResult({ messageId: message.id, language, translations: response.translations });
      setShowTranslation(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not translate this message");
    }
  }

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={translate.isPending || Boolean(message.bodyHtml && html.isPending)}
          onClick={() => void toggleTranslation()}
        >
          {translate.isPending ? <LoaderCircle className="animate-spin" /> : <Languages />}
          {visible ? "Show original" : result?.language === language ? "Show translation" : "Translate"}
        </Button>
        <select
          aria-label="Translation language"
          className="h-7 max-w-40 rounded-md border border-current/15 bg-transparent px-1.5 text-xs"
          value={language}
          disabled={translate.isPending || Boolean(message.bodyHtml && html.isPending)}
          onChange={(event) => {
            setLanguage(event.target.value);
            setShowTranslation(false);
          }}
        >
          {languages.map((code) => (
            <option key={code} value={code}>
              {displayNames.of(code) ?? code}
            </option>
          ))}
        </select>
      </div>
      {message.bodyHtml && (!visible || sourceHtml) ? (
        <EmailHtmlBody
          bodyHtml={message.bodyHtml}
          mailboxId={mailboxId}
          message={message}
          onRenderModeChange={onRenderModeChange}
          translations={visible ? result.translations : undefined}
        />
      ) : (
        <div className="whitespace-pre-wrap text-[0.9375rem] leading-[1.65]">
          {visible ? result.translations[0] : message.bodyText}
        </div>
      )}
    </>
  );
}
