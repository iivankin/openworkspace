import { useMutation } from "@tanstack/react-query";
import { Languages, LoaderCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, responseJson } from "@/lib/api";
import type { MessageDetail } from "./types";

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
  children,
}: {
  message: MessageDetail;
  mailboxId: string;
  children: ReactNode;
}) {
  const [language, setLanguage] = useState(browserLanguage);
  const [result, setResult] = useState<{ language: string; text: string } | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const translate = useMutation({
    mutationFn: async (targetLanguage: string) => {
      const response = await api.api.mail.messages[":id"].translate.$post({
        param: { id: message.id },
        query: { mailboxId },
        json: { language: targetLanguage },
      });
      return responseJson(response);
    },
  });
  const languages = COMMON_LANGUAGES.includes(language)
    ? COMMON_LANGUAGES
    : [language, ...COMMON_LANGUAGES];
  const displayNames = new Intl.DisplayNames([browserLanguage()], { type: "language" });
  const visible = showTranslation && result?.language === language;

  async function toggleTranslation() {
    if (visible) {
      setShowTranslation(false);
      return;
    }
    if (result?.language === language) {
      setShowTranslation(true);
      return;
    }
    try {
      const response = await translate.mutateAsync(language);
      setResult({ language, text: response.translation });
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
          disabled={translate.isPending}
          onClick={() => void toggleTranslation()}
        >
          {translate.isPending ? <LoaderCircle className="animate-spin" /> : <Languages />}
          {visible ? "Show original" : result?.language === language ? "Show translation" : "Translate"}
        </Button>
        <select
          aria-label="Translation language"
          className="h-7 max-w-40 rounded-md border border-current/15 bg-transparent px-1.5 text-xs"
          value={language}
          disabled={translate.isPending}
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
      {visible ? (
        <div className="whitespace-pre-wrap text-[0.9375rem] leading-[1.65]">
          {result.text}
        </div>
      ) : children}
    </>
  );
}
