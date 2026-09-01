import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, Save, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { SamlNameIdFormat } from "../../shared/saml";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, responseJson } from "@/lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
} from "./admin-panel";
import { CopyableValueRow } from "./copyable-value-row";
import { SelectionList } from "./selection-list";
import type {
  AdminGroup,
  AdminSamlApplicationDetails,
  AdminSamlProvider,
  AdminUser,
} from "./types";

type SamlApplicationInput = {
  name: string;
  entityId: string;
  acsUrl: string;
  nameIdFormat: SamlNameIdFormat;
  accessPolicy: "all_active_users" | "selected_users";
  emailAttributeName: string;
  nameAttributeName: string;
  groupsAttributeName: string | null;
  signResponse: boolean;
  requireSignedAuthnRequests: boolean;
  spSigningCertificate: string | null;
  allowIdpInitiated: boolean;
  enabled: boolean;
  assignedUserIds: string[];
  exposedGroupIds: string[];
};

const emptyApplication: SamlApplicationInput = {
  name: "",
  entityId: "",
  acsUrl: "",
  nameIdFormat: "email",
  accessPolicy: "selected_users",
  emailAttributeName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  nameAttributeName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  groupsAttributeName: "http://schemas.xmlsoap.org/claims/Group",
  signResponse: true,
  requireSignedAuthnRequests: false,
  spSigningCertificate: null,
  allowIdpInitiated: true,
  enabled: true,
  assignedUserIds: [],
  exposedGroupIds: [],
};

export function SamlApplicationForm({
  application,
  provider,
  users,
  groups,
  onSaved,
  onDeleted,
}: {
  application?: AdminSamlApplicationDetails;
  provider: AdminSamlProvider;
  users: AdminUser[];
  groups: AdminGroup[];
  onSaved: (applicationId: string) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const initial: SamlApplicationInput = application
    ? {
      name: application.name,
      entityId: application.entityId,
      acsUrl: application.acsUrl,
      nameIdFormat: application.nameIdFormat,
      accessPolicy: application.accessPolicy,
      emailAttributeName: application.emailAttributeName,
      nameAttributeName: application.nameAttributeName,
      groupsAttributeName: application.groupsAttributeName,
      signResponse: application.signResponse,
      requireSignedAuthnRequests: application.requireSignedAuthnRequests,
      spSigningCertificate: application.spSigningCertificate,
      allowIdpInitiated: application.allowIdpInitiated,
      enabled: application.enabled,
      assignedUserIds: application.assignedUserIds,
      exposedGroupIds: application.exposedGroupIds,
    }
    : emptyApplication;
  const [input, setInput] = useState(initial);

  const save = useMutation({
    mutationFn: async (payload: SamlApplicationInput) => {
      if (application) {
        await responseJson(
          await api.api.admin["saml-applications"][":id"].$patch({
            param: { id: application.id },
            json: payload,
          }),
        );
        return { applicationId: application.id };
      }
      return responseJson(
        await api.api.admin["saml-applications"].$post({ json: payload }),
      );
    },
    onSuccess: async (result) => {
      toast.success(application ? "SAML application updated" : "SAML application created");
      await onSaved(result.applicationId);
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (!application) return;
      await responseJson(
        await api.api.admin["saml-applications"][":id"].$delete({
          param: { id: application.id },
        }),
      );
    },
    onSuccess: async () => {
      toast.success("SAML application deleted");
      await onDeleted();
    },
    onError: (error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const groupsAttributeName = input.groupsAttributeName?.trim() || null;
    save.mutate({
      ...input,
      groupsAttributeName,
      exposedGroupIds: groupsAttributeName ? input.exposedGroupIds : [],
      spSigningCertificate: input.spSigningCertificate?.trim() || null,
      assignedUserIds:
        input.accessPolicy === "selected_users" ? input.assignedUserIds : [],
    });
  }

  return (
    <form className={`${adminPanelClass} max-w-3xl`} onSubmit={submit}>
      <div className="flex items-start justify-between gap-4 border-b border-border/70 bg-surface-sunken/60 px-5 py-4">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] tracking-[0.06em] text-muted-foreground">
            {application?.id ?? "New SAML application"}
          </p>
          <h2 className="mt-1.5 truncate text-lg font-semibold tracking-[-0.02em]">
            {application?.name ?? "Register application"}
          </h2>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-muted-foreground">
          Enabled
          <Switch
            checked={input.enabled}
            onCheckedChange={(enabled) => setInput({ ...input, enabled })}
          />
        </label>
      </div>

      <AdminPanelBody className="space-y-7">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Application name" id="saml-name">
            <Input
              id="saml-name"
              value={input.name}
              onChange={(event) => setInput({ ...input, name: event.target.value })}
              required
            />
          </Field>
          <div className="space-y-2">
            <Label>NameID</Label>
            <Select
              value={input.nameIdFormat}
              onValueChange={(nameIdFormat) => setInput({
                ...input,
                nameIdFormat: nameIdFormat as SamlNameIdFormat,
              })}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {input.nameIdFormat === "email" ? "Email address" : "Persistent user ID"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Email address</SelectItem>
                <SelectItem value="persistent">Persistent user ID</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <Field label="Service provider Entity ID" id="saml-entity-id">
          <Input
            id="saml-entity-id"
            className="font-mono text-xs"
            value={input.entityId}
            onChange={(event) => setInput({ ...input, entityId: event.target.value })}
            placeholder="https://service.example.com/saml/metadata"
            required
          />
        </Field>
        <Field label="Assertion Consumer Service URL" id="saml-acs-url">
          <Input
            id="saml-acs-url"
            className="font-mono text-xs"
            type="url"
            value={input.acsUrl}
            onChange={(event) => setInput({ ...input, acsUrl: event.target.value })}
            placeholder="https://service.example.com/saml/acs"
            required
          />
        </Field>

        <div className="space-y-3">
          <p className="text-[0.8125rem] font-semibold text-foreground/85">Attributes</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email attribute" id="saml-email-attribute">
              <Input
                id="saml-email-attribute"
                className="font-mono text-xs"
                value={input.emailAttributeName}
                onChange={(event) => setInput({ ...input, emailAttributeName: event.target.value })}
                required
              />
            </Field>
            <Field label="Name attribute" id="saml-name-attribute">
              <Input
                id="saml-name-attribute"
                className="font-mono text-xs"
                value={input.nameAttributeName}
                onChange={(event) => setInput({ ...input, nameAttributeName: event.target.value })}
                required
              />
            </Field>
          </div>
          <Field label="Groups attribute" id="saml-groups-attribute">
            <Input
              id="saml-groups-attribute"
              className="font-mono text-xs"
              value={input.groupsAttributeName ?? ""}
              onChange={(event) => {
                const groupsAttributeName = event.target.value || null;
                setInput({
                  ...input,
                  groupsAttributeName,
                  exposedGroupIds: groupsAttributeName
                    ? input.exposedGroupIds
                    : [],
                });
              }}
            />
          </Field>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Application access</Label>
            <Select
              value={input.accessPolicy}
              onValueChange={(accessPolicy) => setInput({
                ...input,
                accessPolicy: accessPolicy as SamlApplicationInput["accessPolicy"],
              })}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {input.accessPolicy === "selected_users" ? "Selected users" : "All active users"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="selected_users">Selected users</SelectItem>
                <SelectItem value="all_active_users">All active users</SelectItem>
              </SelectContent>
            </Select>
            {input.accessPolicy === "selected_users" ? (
              <SelectionList
                label="Assigned users"
                items={users
                  .filter((user) =>
                    user.status === "active" || input.assignedUserIds.includes(user.id)
                  )
                  .map((user) => ({
                    id: user.id,
                    label: user.name,
                    detail: user.status === "disabled"
                      ? `${user.personalEmail ? `${user.personalEmail} · ` : ""}Disabled`
                      : user.personalEmail ?? undefined,
                  }))}
                value={input.assignedUserIds}
                onChange={(assignedUserIds) => setInput({ ...input, assignedUserIds })}
              />
            ) : null}
          </div>
          <div className="space-y-2">
            <Label>Groups attribute</Label>
            {input.groupsAttributeName ? (
              <SelectionList
                label="Exposed groups"
                items={groups.map((group) => ({
                  id: group.id,
                  label: group.name,
                  detail: group.slug,
                }))}
                value={input.exposedGroupIds}
                onChange={(exposedGroupIds) => setInput({ ...input, exposedGroupIds })}
              />
            ) : null}
          </div>
        </div>

        <div className="divide-y divide-border/60 border-y border-border/70">
          <SwitchRow
            label="Sign response"
            checked={input.signResponse}
            onCheckedChange={(signResponse) => setInput({ ...input, signResponse })}
          />
          <SwitchRow
            label="IdP-initiated sign-in"
            checked={input.allowIdpInitiated}
            onCheckedChange={(allowIdpInitiated) => setInput({ ...input, allowIdpInitiated })}
          />
          <SwitchRow
            label="Require signed AuthnRequest"
            checked={input.requireSignedAuthnRequests}
            onCheckedChange={(requireSignedAuthnRequests) => setInput({
              ...input,
              requireSignedAuthnRequests,
            })}
          />
        </div>

        {input.requireSignedAuthnRequests ? (
          <Field label="Service provider signing certificate" id="saml-sp-certificate">
            <Textarea
              id="saml-sp-certificate"
              className="min-h-40 font-mono text-[11px]"
              value={input.spSigningCertificate ?? ""}
              onChange={(event) => setInput({
                ...input,
                spSigningCertificate: event.target.value || null,
              })}
              placeholder="-----BEGIN CERTIFICATE-----"
              required
            />
          </Field>
        ) : null}

        {input.allowIdpInitiated && application?.launchUrl ? (
          <div className="border-t border-border/70 pt-4">
            <CopyableValueRow label="Launch URL" value={application.launchUrl} />
          </div>
        ) : null}
        {!provider.configured ? (
          <Badge variant="outline">
            {provider.configurationError ?? "SAML provider is unavailable"}
          </Badge>
        ) : null}
      </AdminPanelBody>

      <AdminPanelFooter className="justify-between">
        <div>
          {application ? (
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete ${application.name}?`)) remove.mutate();
              }}
            >
              <Trash2 /> Delete
            </Button>
          ) : null}
        </div>
        <Button
          type="submit"
          disabled={
            save.isPending
            || !input.name
            || !input.entityId
            || !input.acsUrl
          }
        >
          {save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
          {application ? "Save application" : "Create application"}
        </Button>
      </AdminPanelFooter>
    </form>
  );
}

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function SwitchRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-3 text-[0.8125rem] font-semibold">
      {label}
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}
