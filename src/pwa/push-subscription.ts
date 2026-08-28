import type { PushSubscriptionData } from "@mmmike/web-push/client";
import { api, responseJson } from "@/lib/api";

const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

function pushIsSupported() {
  return "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

async function activeServiceWorkerRegistration() {
  const current = await navigator.serviceWorker.getRegistration();
  if (current?.active) return current;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("The notification service is unavailable"));
        }, SERVICE_WORKER_READY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function createPushSubscription(
  registration: ServiceWorkerRegistration,
  publicKey: string,
) {
  const { urlBase64ToUint8Array } = await import("@mmmike/web-push/vapid");
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
}

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

async function currentBrowserPushSubscription() {
  if (!pushIsSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration?.pushManager.getSubscription() ?? null;
}

async function serializedSubscription(subscription: PushSubscription) {
  const client = await import("@mmmike/web-push/client");
  return client.serializeSubscription(subscription);
}

async function bindPushSubscription(subscription: PushSubscriptionData) {
  await responseJson(
    await api.api.notifications.subscriptions.$put({ json: subscription }),
  );
}

async function removeServerPushSubscription(endpoint: string) {
  await responseJson(
    await api.api.notifications.subscriptions.$delete({ json: { endpoint } }),
  );
}

export async function pushSubscriptionEndpointForLogout() {
  try {
    return (await currentBrowserPushSubscription())?.endpoint ?? null;
  } catch {
    // Logout must not depend on browser push APIs being healthy. The server
    // still revokes the session even when this device cannot identify itself.
    return null;
  }
}

export async function syncCurrentPushSubscription() {
  const subscription = await currentBrowserPushSubscription();
  if (!subscription) return;
  await bindPushSubscription(await serializedSubscription(subscription));
}

export async function currentPushRegistrationStatus(publicKey: string) {
  if (!pushIsSupported()) return "unsupported" as const;
  const subscription = await currentBrowserPushSubscription();
  if (Notification.permission === "denied") {
    if (subscription) await removeServerPushSubscription(subscription.endpoint);
    return "denied" as const;
  }
  if (!subscription) return "prompt" as const;
  if (!await subscriptionUsesKey(subscription, publicKey)) return "repair" as const;
  await bindPushSubscription(await serializedSubscription(subscription));
  return "enabled" as const;
}

export async function enableCurrentPushSubscription(publicKey: string) {
  if (!pushIsSupported()) {
    throw new Error("Push is not supported on this device");
  }
  if (await Notification.requestPermission() !== "granted") {
    throw new Error("Notification permission was denied");
  }
  const registration = await activeServiceWorkerRegistration();
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !await subscriptionUsesKey(subscription, publicKey)) {
    if (!await subscription.unsubscribe()) {
      throw new Error("Could not replace the previous notification subscription");
    }
    subscription = null;
  }
  subscription ??= await createPushSubscription(registration, publicKey);
  await bindPushSubscription(await serializedSubscription(subscription));
}

export async function disableCurrentPushSubscription() {
  const subscription = await currentBrowserPushSubscription();
  if (!subscription) return { browserUnsubscribed: true };

  await removeServerPushSubscription(subscription.endpoint);
  let browserUnsubscribed = false;
  try {
    browserUnsubscribed = await subscription.unsubscribe();
  } catch {
    // The account mapping is already gone, which is the security boundary.
  }
  return { browserUnsubscribed };
}
