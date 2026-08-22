import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { MAILBOX_REALTIME_UPDATE } from "../../shared/mail";
import { useAuth } from "@/auth/auth-context";
import { scheduleMailboxRefresh } from "./mail-query-cache";
import { useMailboxes } from "./use-mail-data";

type MailboxConnection = {
  socket: WebSocket | null;
  retryAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

const PRESENCE_HEARTBEAT_MS = 25_000;

function realtimeUrl(mailboxId: string, visibility: "visible" | "hidden") {
  const url = new URL(
    `/api/mail/mailboxes/${encodeURIComponent(mailboxId)}/realtime`,
    window.location.origin,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("visibility", visibility);
  return url;
}

function mailboxFromPath(pathname: string, mailboxIds: string[]) {
  if (pathname === "/") return mailboxIds[0] ?? null;
  const match = /^\/mail\/([^/]+)\/?$/u.exec(pathname);
  if (!match) return null;
  try {
    const mailboxId = decodeURIComponent(match[1]!);
    return mailboxIds.includes(mailboxId) ? mailboxId : null;
  } catch {
    return null;
  }
}

export function MailboxRealtimeConnections() {
  const auth = useAuth();
  const client = useQueryClient();
  const location = useLocation();
  const mailboxQuery = useMailboxes();
  const mailboxIds = mailboxQuery.data?.mailboxes.map((mailbox) => mailbox.id) ?? [];
  const mailboxKey = mailboxIds.join("\0");
  const userId = auth.user?.id;
  const sessionVersion = auth.sessionVersion;
  const activeMailboxId = mailboxFromPath(location.pathname, mailboxIds);
  const activeMailboxRef = useRef<string | null>(activeMailboxId);
  const sendPresenceRef = useRef<(() => void) | null>(null);
  activeMailboxRef.current = activeMailboxId;

  useEffect(() => {
    if (!userId || !mailboxKey) return;
    const ids = mailboxKey.split("\0");
    const connections = new Map<string, MailboxConnection>();
    let stopped = false;
    let ownershipRefresh: Promise<void> | null = null;

    function refreshOwnership() {
      if (!ownershipRefresh) {
        ownershipRefresh = Promise.all([
          client.invalidateQueries({ queryKey: ["auth-state"] }),
          client.invalidateQueries({ queryKey: ["mailboxes"] }),
        ]).then(() => undefined).catch((error) => {
          console.error("Could not refresh realtime connection ownership", error);
        }).finally(() => {
          ownershipRefresh = null;
        });
      }
      return ownershipRefresh;
    }

    function visibilityFor(mailboxId: string) {
      return document.visibilityState === "visible"
        && activeMailboxRef.current === mailboxId
        ? "visible" as const
        : "hidden" as const;
    }

    function sendMailboxPresence(mailboxId: string) {
      const connection = connections.get(mailboxId);
      if (connection?.socket?.readyState === WebSocket.OPEN) {
        connection.socket.send(visibilityFor(mailboxId));
      }
    }

    function sendPresence() {
      for (const mailboxId of connections.keys()) sendMailboxPresence(mailboxId);
    }
    sendPresenceRef.current = sendPresence;

    function connect(mailboxId: string) {
      const connection = connections.get(mailboxId);
      if (!connection || stopped || !navigator.onLine) return;
      if (
        connection.socket?.readyState === WebSocket.OPEN
        || connection.socket?.readyState === WebSocket.CONNECTING
      ) {
        return;
      }
      const socket = new WebSocket(realtimeUrl(mailboxId, visibilityFor(mailboxId)));
      let opened = false;
      connection.socket = socket;
      socket.addEventListener("open", () => {
        if (stopped || connection.socket !== socket) return;
        opened = true;
        connection.retryAttempt = 0;
        sendMailboxPresence(mailboxId);
        scheduleMailboxRefresh(client, mailboxId);
      });
      socket.addEventListener("message", (message) => {
        if (message.data === MAILBOX_REALTIME_UPDATE) {
          scheduleMailboxRefresh(client, mailboxId);
        }
      });
      socket.addEventListener("close", (event) => {
        if (connection.socket === socket) connection.socket = null;
        if (stopped || event.code === 1000) return;
        if (event.code === 1008) {
          void refreshOwnership();
          return;
        }
        const delay = Math.min(30_000, 500 * 2 ** connection.retryAttempt);
        connection.retryAttempt += 1;
        connection.retryTimer = setTimeout(() => {
          connection.retryTimer = null;
          void (async () => {
            // Browsers expose a rejected WebSocket handshake as an abnormal
            // close, so refresh access before retrying a socket that never opened.
            if (!opened && navigator.onLine) await refreshOwnership();
            connect(mailboxId);
          })();
        }, delay + Math.floor(Math.random() * Math.min(delay, 1_000)));
      });
    }

    for (const mailboxId of ids) {
      connections.set(mailboxId, {
        socket: null,
        retryAttempt: 0,
        retryTimer: null,
      });
      connect(mailboxId);
    }
    const reconnect = () => {
      for (const mailboxId of ids) connect(mailboxId);
    };
    document.addEventListener("visibilitychange", sendPresence);
    window.addEventListener("online", reconnect);
    const heartbeat = () => {
      const mailboxId = activeMailboxRef.current;
      if (document.visibilityState === "visible" && mailboxId) {
        sendMailboxPresence(mailboxId);
      }
    };
    const presenceTimer = window.setInterval(heartbeat, PRESENCE_HEARTBEAT_MS);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", sendPresence);
      window.removeEventListener("online", reconnect);
      window.clearInterval(presenceTimer);
      if (sendPresenceRef.current === sendPresence) sendPresenceRef.current = null;
      for (const connection of connections.values()) {
        if (connection.retryTimer) clearTimeout(connection.retryTimer);
        connection.socket?.close(1000, "Client disconnected");
      }
    };
  }, [client, mailboxKey, sessionVersion, userId]);

  useEffect(() => {
    sendPresenceRef.current?.();
  }, [activeMailboxId]);

  return null;
}
