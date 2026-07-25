import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImageUp, LoaderCircle, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "@/admin/admin-panel";
import { useAuth } from "@/auth/auth-context";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { api, responseJson } from "@/lib/api";

export function ProfileSettings() {
  const auth = useAuth();
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = await responseJson(
        await api.api.auth.avatar.$post({
          form: { file },
        }),
      );
      return body;
    },
    onSuccess: async () => {
      toast.success("Avatar updated");
      setPreviewUrl(null);
      await client.invalidateQueries({ queryKey: ["auth-state"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: async () =>
      responseJson(await api.api.auth.avatar.$delete()),
    onSuccess: async () => {
      toast.success("Avatar removed");
      setPreviewUrl(null);
      await client.invalidateQueries({ queryKey: ["auth-state"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const pending = upload.isPending || remove.isPending;
  const avatarSrc = previewUrl ?? auth.user?.avatarUrl ?? undefined;
  const hasAvatar = Boolean(auth.user?.avatarUrl || previewUrl);

  function onFileChange(file: File | undefined) {
    if (!file) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    upload.mutate(file);
  }

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={ImageUp}
        title="Profile photo"
        description="Shown in mail, SSO picture claims, and your account menu."
      />
      <AdminPanelBody className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
        <Avatar className="size-24 text-xl">
          <AvatarImage src={avatarSrc} />
          <AvatarFallback>{auth.user?.name.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold">{auth.user?.name}</p>
          <p className="text-xs text-muted-foreground capitalize">{auth.user?.role}</p>
          <p className="text-xs text-muted-foreground">
            JPEG, PNG, WebP, or GIF up to 2 MB.
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="sr-only"
          onChange={(event) => {
            onFileChange(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </AdminPanelBody>
      <AdminPanelFooter className="justify-between">
        <Button
          type="button"
          variant="outline"
          disabled={pending || !hasAvatar}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
          Remove
        </Button>
        <Button
          type="button"
          disabled={pending}
          onClick={() => inputRef.current?.click()}
        >
          {upload.isPending ? <LoaderCircle className="animate-spin" /> : <ImageUp />}
          Upload
        </Button>
      </AdminPanelFooter>
    </div>
  );
}
