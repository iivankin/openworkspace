import { api, responseJson } from "@/lib/api";

async function subscriptionUsesKey(
  subscription: PushSubscription,
  publicKey: string,
) {
  const boundKey = subscription.options.applicationServerKey;
  if (!boundKey) return true;
  const { urlBase64ToUint8Array } = await import("@mmmike/web-push/vapid");
  const expectedKey = urlBase64ToUint8Array(publicKey);
  const currentKey = new Uint8Array(boundKey);
  return currentKey.length === expectedKey.length
    && currentKey.every((byte, index) => byte === expectedKey[index]);
}

export async function currentPushRegistrationStatus(publicKey: string) {
  const client = await import("@mmmike/web-push/client");
  if (!client.isPushSupported()) return "unsupported" as const;
  if (Notification.permission === "denied") return "denied" as const;
  const subscription = await client.getCurrentSubscription();
  if (!subscription) return "prompt" as const;
  if (!await subscriptionUsesKey(subscription, publicKey)) return "repair" as const;
  const status = await responseJson(
    await api.api.notifications.subscriptions.status.$post({
      json: { endpoint: subscription.endpoint },
    }),
  );
  return status.registered ? "enabled" as const : "prompt" as const;
}

export async function disableCurrentPushSubscription() {
  const client = await import("@mmmike/web-push/client");
  const subscription = await client.getCurrentSubscription();
  if (!subscription) {
    return {
      hadSubscription: false,
      browserUnsubscribed: true,
    };
  }
  // The D1 registration is authoritative. Browser cleanup cannot re-enable
  // delivery if unsubscribe fails, so it is deliberately best-effort.
  await responseJson(
    await api.api.notifications.subscriptions.$delete({
      json: { endpoint: subscription.endpoint },
    }),
  );
  let browserUnsubscribed = false;
  try {
    browserUnsubscribed = await subscription.unsubscribe();
  } catch {
    // The server registration is already gone, which is the security boundary.
  }
  return { hadSubscription: true, browserUnsubscribed };
}

export async function unsubscribeCurrentPushSubscription() {
  const { getCurrentSubscription } = await import("@mmmike/web-push/client");
  const subscription = await getCurrentSubscription();
  if (!subscription) return;
  await subscription.unsubscribe();
}
