import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Folder, MailFolder } from "./types";

const systemFolderLabels: Record<string, string> = {
  inbox: "Inbox",
  sent: "Sent",
  archive: "Archive",
  spam: "Spam",
  trash: "Trash",
};

const fallbackFolders: MailFolder[] = Object.keys(systemFolderLabels).map((id) => ({
  id,
  name: systemFolderLabels[id],
  kind: "system",
  systemType: id as MailFolder["systemType"],
}));

export function folderDisplayName(folder: Folder, folders?: MailFolder[]) {
  return folders?.find((item) => item.id === folder)?.name
    ?? systemFolderLabels[folder]
    ?? folder;
}

export function FolderTabBar({
  folder,
  folders,
  onSelect,
}: {
  folder: Folder;
  folders?: MailFolder[];
  onSelect: (folder: Folder) => void;
}) {
  const items = folders?.length ? folders : fallbackFolders;
  return (
    <>
      <FolderTabs
        className="hidden h-11 shrink-0 border-b px-6 lg:block"
        folder={folder}
        folders={items}
        onSelect={onSelect}
      />
      <FolderTabs
        className="fixed inset-x-0 bottom-0 z-30 h-[calc(3.5rem+env(safe-area-inset-bottom))] border-t bg-background/95 px-4 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
        folder={folder}
        folders={items}
        onSelect={onSelect}
      />
    </>
  );
}

function FolderTabs({
  className,
  folder,
  folders,
  onSelect,
}: {
  className: string;
  folder: Folder;
  folders: MailFolder[];
  onSelect: (folder: Folder) => void;
}) {
  return (
    <nav className={className} aria-label="Mail folders">
      <div className="h-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Tabs className="h-full gap-0" value={folder} onValueChange={(value) => onSelect(String(value))}>
          <TabsList variant="line" className="h-full w-max min-w-full justify-start gap-6 rounded-none p-0">
            {folders.map((item) => (
              <TabsTrigger
                key={item.id}
                value={item.id}
                className="h-full flex-none rounded-none px-0 text-sm after:bottom-0"
              >
                {item.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
    </nav>
  );
}
