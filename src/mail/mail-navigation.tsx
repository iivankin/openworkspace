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
  totalCount: 0,
  unreadCount: 0,
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
        className="hidden h-12 shrink-0 border-b border-border/70 bg-surface/60 px-5 backdrop-blur-xl lg:block"
        folder={folder}
        folders={items}
        onSelect={onSelect}
      />
      <FolderTabs
        className="fixed inset-x-0 bottom-0 z-30 h-[calc(3.5rem+env(safe-area-inset-bottom))] border-t border-border/70 bg-surface/90 px-4 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_-16px_var(--shadow-color)] backdrop-blur-xl lg:hidden"
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
      <div className="scrollbar-none h-full overflow-x-auto">
        <Tabs className="h-full gap-0" value={folder} onValueChange={(value) => onSelect(String(value))}>
          <TabsList variant="line" className="h-full w-max min-w-full justify-start gap-1 rounded-none p-0">
            {folders.map((item) => (
              <TabsTrigger
                key={item.id}
                value={item.id}
                className="h-full flex-none rounded-none px-3 text-[0.8125rem] font-medium tracking-[-0.005em] after:inset-x-3 after:bottom-0"
              >
                <span>{item.name}</span>
                {item.unreadCount > 0 ? (
                  <span
                    className="min-w-5 rounded-full bg-primary/16 px-1.5 py-0.5 text-[10px] leading-none font-bold text-foreground tabular-nums"
                    aria-label={`${item.unreadCount} unread messages`}
                  >
                    {item.unreadCount}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
    </nav>
  );
}
