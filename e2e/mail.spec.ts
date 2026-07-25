import { expect, test } from "playwright/test";

test("opens the seeded inbox and reads a message", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("The craft behind fast software", { exact: true })).toBeVisible();

  await page.getByText("The craft behind fast software", { exact: true }).click();
  await expect(page.getByRole("article").getByRole("heading", { name: "The craft behind fast software" })).toBeVisible();
  await expect(page.getByText("Here are the notes from our design review", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delivery status: Delivered" })).toBeVisible();

  const olderMessage = page.locator('[data-message-id="msg_demo_01"]');
  await olderMessage.hover();
  await olderMessage.getByRole("button", { name: "Reply to this message" }).click();
  await expect(page.getByText("Replying to Karri Saarinen", { exact: false })).toBeVisible();
});

test("renders sanitized HTML without loading remote images", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "HTML isolation is covered once");
  let trackingRequested = false;
  await page.route("https://tracking.example.test/**", async (route) => {
    trackingRequested = true;
    await route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.route("**/api/mail/conversations/*", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as {
      messages: Array<{
        id: string;
        hasHtmlBody: boolean;
        quotedText: string | null;
      }>;
    };
    const message = body.messages.find((item) => item.id === "msg_demo_01");
    if (message) {
      message.hasHtmlBody = true;
      message.quotedText = null;
    }
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/mail/messages/msg_demo_01/html?*", async (route) => {
    await route.fulfill({
      contentType: "text/plain",
      body: [
        "<p>Your one-time code is <strong>482901</strong></p>",
        '<img src="https://tracking.example.test/open.gif" alt="Tracking image">',
        "<script>parent.document.body.dataset.emailScriptRan = 'yes'</script>",
      ].join(""),
    });
  });

  await page.getByText("The craft behind fast software", { exact: true }).click();
  const frame = page.frameLocator('iframe[title^="HTML body of"]');
  await expect(frame.getByText("482901", { exact: false })).toBeVisible();
  await expect(frame.getByText("Tracking image", { exact: true })).toBeVisible();
  expect(await page.locator("body").getAttribute("data-email-script-ran")).toBeNull();
  expect(trackingRequested).toBe(false);
});

test("opens outbound delivery details without crashing", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Delivery menu behavior is covered once");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.getByText("The craft behind fast software", { exact: true }).click();

  const outgoing = page.locator('[data-message-id="msg_demo_07"]');
  await outgoing.getByRole("button", { name: "Delivery status: Delivered" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByText("Delivery", { exact: true })).toBeVisible();
  await expect(menu.getByText("karri@linear.app", { exact: true })).toBeVisible();
});

test("searches message bodies across the selected folder", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.waitForURL(/\/mail\//u);
  const search = page.locator('input[placeholder="Search in Inbox"]:visible');
  await Promise.all([
    page.waitForResponse((response) => {
      return (
        response.url().includes("/api/mail/conversations") &&
        response.url().includes("search=three") &&
        response.ok()
      );
    }),
    search.fill("three decisions"),
  ]);

  await expect(page.getByText("The craft behind fast software", { exact: true })).toBeVisible();
  await expect(page.getByText("Friday launch checklist", { exact: true })).toHaveCount(0);
});

test("opens a responsive composer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile layout assertion");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await expect(composer).toBeVisible();
  await expect(page.getByPlaceholder("Write a message")).toBeVisible();
  await page.getByRole("button", { name: "Cc", exact: true }).click();
  await page.getByRole("button", { name: "Bcc", exact: true }).click();
  await expect(composer.locator("span").filter({ hasText: /^Cc$/u })).toBeVisible();
  await expect(composer.locator("span").filter({ hasText: /^Bcc$/u })).toBeVisible();
});

test("admin can edit an existing user and create recovery", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop administration assertion");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.getByRole("button", { name: "Account and mailboxes" }).click();
  await page.getByRole("menuitem", { name: "Administration" }).click();
  await expect(page).toHaveURL(/\/admin/u);
  await expect(page.locator("aside")).toBeVisible();
  await page.getByRole("button", { name: "Manage Ilya Morozov" }).click();
  await page.getByRole("button", { name: "Back to list" }).click();
  await page.getByRole("button", { name: "Manage Maya Chen" }).click();
  await expect(page.getByRole("heading", { name: "Person" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await page.getByRole("button", { name: "Recovery link" }).click();
  await expect(page.locator("input[readonly]")).toHaveValue(/\/recover\//u);
  await page.goBack();
  await page.goBack();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await expect(page.locator("input[readonly]")).toHaveCount(0);
});

test("direct admin links select loaded SSO and group records", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop administration assertion");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  const created = await page.evaluate(async () => {
    const stateResponse = await fetch("/api/admin/state");
    const state = await stateResponse.json() as {
      users: Array<{ id: string }>;
    };
    const userId = state.users[0]!.id;
    const [clientResponse, groupResponse] = await Promise.all([
      fetch("/api/admin/oidc-clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Direct-link application",
          clientType: "public",
          accessPolicy: "selected_users",
          redirectUris: ["https://direct.example.test/callback"],
          postLogoutRedirectUris: [],
          allowedOrigins: [],
          allowedScopes: ["openid"],
          trusted: true,
          enabled: true,
          assignedUserIds: [userId],
          exposedGroupIds: [],
        }),
      }),
      fetch("/api/admin/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Direct-link group",
          slug: "direct-link-group",
          description: null,
          memberIds: [userId],
        }),
      }),
    ]);
    return {
      clientStatus: clientResponse.status,
      groupStatus: groupResponse.status,
    };
  });
  expect(created).toEqual({ clientStatus: 201, groupStatus: 201 });

  await page.goto("/admin?view=sso-applications");
  await expect(
    page.getByRole("heading", { name: "Direct-link application" }),
  ).toBeVisible();
  await page.goto("/admin?view=groups");
  await expect(page.getByRole("heading", { name: "Direct-link group" }))
    .toBeVisible();
});

test("desktop mail uses navbar navigation and a corner composer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop layout assertion");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page.getByRole("navigation", { name: "Mail folders" })).toBeVisible();
  await expect(page.locator("aside")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Product" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Pitch Decks" })).toBeVisible();
  const firstConversation = page.getByRole("button", { name: /Karri Saarinen/u });
  const inboxBox = await firstConversation.boundingBox();
  expect(inboxBox).not.toBeNull();
  expect(inboxBox!.width).toBeGreaterThan(1150);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await expect(composer).toBeVisible();
  const box = await composer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(540);
  expect(box!.height).toBeLessThanOrEqual(540);
  expect(box!.x + box!.width).toBeGreaterThan(1000);
  expect(box!.y + box!.height).toBeGreaterThan(650);
});

test("closes the mailbox composer when switching mailboxes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Composer routing is covered once");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\/mbx_demo_personal\?/u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByPlaceholder("Write a message").fill("Pinned draft");

  await page.getByRole("button", { name: "Account and mailboxes" }).click();
  await page.getByRole("menuitem", { name: /Customer care/u }).click();

  await expect(page).toHaveURL(/\/mail\/mbx_demo_support\?/u);
  await expect(composer).toHaveCount(0);
  await page.getByRole("button", { name: "Compose" }).click();
  const supportComposer = page.getByRole("dialog", { name: "New message" });
  await expect(supportComposer.getByText("From support@demo.example")).toBeVisible();
  await expect(supportComposer.getByPlaceholder("Write a message")).toHaveValue("");
});

test("offers Reply and Reply all on a group message", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.getByText("Your Workers architecture review", { exact: true }).click();

  const message = page.locator('[data-message-id="msg_demo_02"]');
  await message.hover();
  await expect(message.getByRole("button", { name: "Reply to this message" })).toBeVisible();
  await expect(message.getByRole("button", { name: "Reply all to this message" })).toBeVisible();
  await expect(page.locator("form")).toHaveCount(0);
  await message.getByRole("button", { name: "Reply all to this message" }).click();
  await expect(page.locator("form").getByRole("button", { name: /Reply all/u })).toBeVisible();
  await expect(page.getByText("2 people", { exact: true })).toBeVisible();
  await message.getByRole("button", { name: "Reply to this message" }).click();
  const replyForm = page.locator("form");
  await replyForm.getByPlaceholder(/Reply to/u).fill("Following up privately.");
  await replyForm.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("folder")).toBe("sent");
  expect(new URL(page.url()).searchParams.get("conversation")).toMatch(/^conv_/u);
  await expect(page.getByText("Following up privately.", { exact: true })).toBeVisible();
});

test("restores an archived conversation to the inbox", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "State transition is covered once");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.getByText("Friday launch checklist", { exact: true }).click();
  await page.getByRole("button", { name: "Archive conversation" }).click();

  await page.getByRole("tab", { name: /Archive/u }).click();
  await page.getByRole("button", { name: /Friday launch checklist/u }).click();
  await page.getByRole("button", { name: "Move conversation to inbox" }).click();

  await page.getByRole("tab", { name: /Inbox/u }).click();
  await expect(page.getByText("Friday launch checklist", { exact: true })).toBeVisible();
});

test("opens a forwarded message in the corner composer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Composer path is covered once");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.getByText("The craft behind fast software", { exact: true }).click();

  const message = page.locator('[data-message-id="msg_demo_01"]');
  await message.hover();
  await message.getByRole("button", { name: "Forward this message" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await expect(composer).toBeVisible();
  await expect(composer.getByText("Forwarding Karri Saarinen", { exact: true })).toBeVisible();
  await expect(composer.getByPlaceholder("Subject")).toHaveValue(
    "Fwd: The craft behind fast software",
  );
});

test("signs out without leaving stale mailbox state", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.getByRole("button", { name: "Account and mailboxes" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inbox" })).toHaveCount(0);
});
