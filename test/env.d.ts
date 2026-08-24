declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: D1Migration[];
    VAPID_PUBLIC_KEY: string;
    VAPID_PRIVATE_KEY: string;
    VAPID_SUBJECT: string;
  }
}
