import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { normalizeExternalEmailAddress } from "../../shared/mail";
import type { RecipientFieldValue } from "./composer-recipients";
import { RecipientCombobox } from "./recipient-combobox";
import { RecipientFieldRow } from "./recipient-field-row";

function committedAddresses(value: RecipientFieldValue) {
  return new Set(
    value.recipients.map((recipient) =>
      normalizeExternalEmailAddress(recipient.address)
    ),
  );
}

export function ComposerRecipientFields({
  mailboxId,
  to,
  cc,
  bcc,
  replyTo,
  subject,
  subjectReadOnly,
  disabled,
  onToChange,
  onCcChange,
  onBccChange,
  onReplyToChange,
  onSubjectChange,
}: {
  mailboxId: string;
  to: RecipientFieldValue;
  cc: RecipientFieldValue;
  bcc: RecipientFieldValue;
  replyTo: string;
  subject: string;
  subjectReadOnly: boolean;
  disabled: boolean;
  onToChange: (value: RecipientFieldValue) => void;
  onCcChange: (value: RecipientFieldValue) => void;
  onBccChange: (value: RecipientFieldValue) => void;
  onReplyToChange: (value: string) => void;
  onSubjectChange: (value: string) => void;
}) {
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [showReplyTo, setShowReplyTo] = useState(false);
  const excludedFromTo = useMemo(
    () => new Set([...committedAddresses(cc), ...committedAddresses(bcc)]),
    [cc, bcc],
  );
  const excludedFromCc = useMemo(
    () => new Set([...committedAddresses(to), ...committedAddresses(bcc)]),
    [to, bcc],
  );
  const excludedFromBcc = useMemo(
    () => new Set([...committedAddresses(to), ...committedAddresses(cc)]),
    [to, cc],
  );

  return (
    <div className="shrink-0 divide-y divide-border/70 border-b border-border/70 px-4">
      <RecipientCombobox
        mailboxId={mailboxId}
        label="To"
        value={to}
        excludedAddresses={excludedFromTo}
        autoFocus
        disabled={disabled}
        onChange={onToChange}
        actions={
          <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
            {!showCc ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled}
                onClick={() => setShowCc(true)}
              >
                Cc
              </Button>
            ) : null}
            {!showBcc ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled}
                onClick={() => setShowBcc(true)}
              >
                Bcc
              </Button>
            ) : null}
            {!showReplyTo ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled}
                onClick={() => setShowReplyTo(true)}
              >
                Reply-to
              </Button>
            ) : null}
          </div>
        }
      />
      {showCc ? (
        <RecipientCombobox
          mailboxId={mailboxId}
          label="Cc"
          value={cc}
          excludedAddresses={excludedFromCc}
          disabled={disabled}
          onChange={onCcChange}
        />
      ) : null}
      {showBcc ? (
        <RecipientCombobox
          mailboxId={mailboxId}
          label="Bcc"
          value={bcc}
          excludedAddresses={excludedFromBcc}
          disabled={disabled}
          onChange={onBccChange}
        />
      ) : null}
      {showReplyTo ? (
        <RecipientFieldRow
          label="Reply-to"
          value={replyTo}
          disabled={disabled}
          onChange={onReplyToChange}
        />
      ) : null}
      <InputGroup className="h-11 rounded-none border-0 bg-transparent shadow-none dark:bg-transparent">
        <InputGroupAddon className="w-11 justify-start pl-0">
          <InputGroupText className="text-xs font-medium">
            Subject
          </InputGroupText>
        </InputGroupAddon>
        <InputGroupInput
          className="px-2"
          value={subject}
          readOnly={subjectReadOnly}
          disabled={disabled}
          aria-label="Subject"
          onChange={(event) => onSubjectChange(event.target.value)}
          placeholder="Subject"
        />
      </InputGroup>
    </div>
  );
}
