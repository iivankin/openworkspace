import {
  useEffect,
  useMemo,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import { normalizeExternalEmailAddress } from "../../shared/mail";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { cn } from "@/lib/utils";
import {
  normalizeComposerRecipient,
  parseComposerRecipients,
  RECIPIENT_SEPARATOR,
  type ComposerRecipient,
  type RecipientFieldValue,
} from "./composer-recipients";
import { useRecipientSuggestions } from "./use-mail-data";

export function RecipientCombobox({
  mailboxId,
  label,
  value,
  excludedAddresses,
  autoFocus = false,
  disabled = false,
  actions,
  onChange,
}: {
  mailboxId: string;
  label: string;
  value: RecipientFieldValue;
  excludedAddresses: ReadonlySet<string>;
  autoFocus?: boolean;
  disabled?: boolean;
  actions?: ReactNode;
  onChange: (value: RecipientFieldValue) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const query = useDebouncedValue(value.input.trim(), 120);
  const suggestionsQuery = useRecipientSuggestions(
    mailboxId,
    query,
    focused && !disabled && Boolean(value.input.trim()),
  );
  const selected = useMemo(
    () => new Set(
      value.recipients.map((recipient) =>
        normalizeExternalEmailAddress(recipient.address)
      ),
    ),
    [value.recipients],
  );
  const suggestions = (suggestionsQuery.data?.suggestions ?? []).flatMap(
    (suggestion) => {
      const normalized = normalizeComposerRecipient(suggestion);
      if (
        !normalized
        || selected.has(normalized.address)
        || excludedAddresses.has(normalized.address)
      ) {
        return [];
      }
      return [normalized];
    },
  );
  const showSuggestions = !disabled
    && focused
    && Boolean(value.input.trim())
    && suggestions.length > 0;

  useEffect(() => {
    setActiveIndex(0);
  }, [query, suggestions.length]);

  function addRecipients(recipients: ComposerRecipient[]) {
    if (!recipients.length) return;
    const seen = new Set([...selected, ...excludedAddresses]);
    const next = recipients.flatMap((recipient) => {
      const normalized = normalizeComposerRecipient(recipient);
      if (!normalized || seen.has(normalized.address)) return [];
      seen.add(normalized.address);
      return [normalized];
    });
    if (!next.length) {
      onChange({ ...value, input: "" });
      return;
    }
    setInvalid(false);
    onChange({
      recipients: [...value.recipients, ...next],
      input: "",
    });
  }

  function commitInput() {
    const parsed = parseComposerRecipients(value.input);
    const hasInvalid = parsed.invalidParts.length > 0;
    setInvalid(hasInvalid);
    if (hasInvalid || !parsed.recipients.length) return false;
    addRecipients(parsed.recipients);
    return true;
  }

  function selectSuggestion(index: number) {
    const suggestion = suggestions[index];
    if (!suggestion) return;
    addRecipients([suggestion]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (showSuggestions && event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, suggestions.length - 1));
      return;
    }
    if (showSuggestions && event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (showSuggestions && event.key === "Enter") {
      event.preventDefault();
      selectSuggestion(activeIndex);
      return;
    }
    if (
      event.key === "Enter"
      || event.key === "Tab"
      || event.key === ","
      || event.key === ";"
    ) {
      if (!value.input.trim()) return;
      if (event.key !== "Tab" || !commitInput()) event.preventDefault();
      return;
    }
    if (
      event.key === "Backspace"
      && !value.input
      && value.recipients.length > 0
    ) {
      onChange({
        ...value,
        recipients: value.recipients.slice(0, -1),
      });
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (!RECIPIENT_SEPARATOR.test(text)) return;
    const parsed = parseComposerRecipients(text);
    if (parsed.invalidParts.length || !parsed.recipients.length) {
      setInvalid(parsed.invalidParts.length > 0);
      return;
    }
    event.preventDefault();
    addRecipients(parsed.recipients);
  }

  return (
    <div
      className="relative flex min-h-11 items-start gap-2 py-2"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
          if (value.input.trim()) commitInput();
        }
      }}
    >
      <span className="w-11 shrink-0 pt-1 text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {value.recipients.map((recipient) => (
          <span
            key={recipient.address}
            className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-secondary px-2.5 text-xs text-secondary-foreground"
            title={recipient.address}
          >
            <span className="max-w-44 truncate">
              {recipient.name || recipient.address}
            </span>
            <button
              type="button"
              className="-mr-1 rounded-full p-0.5 text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
              aria-label={`Remove ${recipient.address}`}
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...value,
                  recipients: value.recipients.filter(
                    (candidate) => candidate.address !== recipient.address,
                  ),
                })}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          className={cn(
            "h-7 min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70",
            invalid && "text-destructive placeholder:text-destructive/70",
          )}
          aria-label={`${label} recipients`}
          aria-autocomplete="list"
          aria-expanded={showSuggestions}
          aria-invalid={invalid}
          autoFocus={autoFocus}
          disabled={disabled}
          value={value.input}
          placeholder={value.recipients.length ? "" : "name@example.com"}
          onFocus={() => setFocused(true)}
          onChange={(event) => {
            setInvalid(false);
            onChange({ ...value, input: event.target.value });
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
      </div>
      {focused && suggestionsQuery.isFetching ? (
        <LoaderCircle className="mt-1.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : null}
      {actions}

      {showSuggestions ? (
        <div
          className="absolute top-[calc(100%-2px)] right-0 left-11 z-60 overflow-hidden rounded-xl bg-popover p-1.5 text-popover-foreground shadow-xl ring-1 ring-border"
          role="listbox"
          aria-label={`${label} suggestions`}
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.address}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm",
                index === activeIndex && "bg-accent text-accent-foreground",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectSuggestion(index)}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold uppercase">
                {(suggestion.name || suggestion.address).slice(0, 2)}
              </span>
              <span className="min-w-0 flex-1">
                {suggestion.name ? (
                  <span className="block truncate font-medium">{suggestion.name}</span>
                ) : null}
                <span className="block truncate text-xs text-muted-foreground">
                  {suggestion.address}
                </span>
              </span>
              {index === activeIndex ? <Check className="size-3.5" /> : null}
            </button>
          ))}
        </div>
      ) : null}

    </div>
  );
}
