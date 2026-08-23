import { useEffect } from "react";
import { useMailboxes } from "./use-mail-data";

const APP_TITLE = "OpenWorkspace";
const DEFAULT_FAVICON = "/icons/app-icon.svg";
const UNREAD_FAVICON = "/icons/app-icon-unread.svg";

function unreadLabel(count: number) {
  return count > 999 ? "999+" : String(count);
}

function updateAppBadge(count: number) {
  const operation = count > 0
    ? navigator.setAppBadge?.(count)
    : navigator.clearAppBadge?.();
  void operation?.catch(() => {
    // Badging is optional and can be denied independently of notifications.
  });
}

export function UnreadDocumentIndicator() {
  const mailboxQuery = useMailboxes();
  let unreadCount = 0;
  for (const mailbox of mailboxQuery.data?.mailboxes ?? []) {
    unreadCount += mailbox.unreadCount;
  }

  useEffect(() => {
    document.title = unreadCount > 0
      ? `(${unreadLabel(unreadCount)}) ${APP_TITLE}`
      : APP_TITLE;
    const favicon = document.querySelector<HTMLLinkElement>("#app-favicon");
    if (favicon) {
      favicon.href = unreadCount > 0 ? UNREAD_FAVICON : DEFAULT_FAVICON;
    }
    updateAppBadge(unreadCount);
  }, [unreadCount]);

  useEffect(() => {
    return () => {
      document.title = APP_TITLE;
      const favicon = document.querySelector<HTMLLinkElement>("#app-favicon");
      if (favicon) favicon.href = DEFAULT_FAVICON;
      updateAppBadge(0);
    };
  }, []);

  return null;
}
