import { expect, test } from "playwright/test";

test("opens the seeded inbox and reads a message", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("The craft behind fast software", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Open The craft behind fast software" }).click();
  await expect(page.getByRole("article").getByRole("heading", { name: "The craft behind fast software" })).toBeVisible();
  await expect(page.getByText("Here are the notes from our design review", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delivery status: Delivered" })).toBeVisible();

  const olderMessage = page.locator('[data-message-id="msg_demo_01"]');
  await olderMessage.hover();
  await olderMessage.getByRole("button", { name: "Reply to this message" }).click();
  await expect(page.getByText("Replying to Karri Saarinen", { exact: false })).toBeVisible();
});

test("renders only meaningful sanitized HTML without loading remote images", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "HTML isolation is covered once");
  let trackingRequested = false;
  let separateHtmlRequested = false;
  let messageBodyText = "Plain fallback must not flash";
  let messageHtml = [
    '<table width="600" style="width:600px"><tbody><tr><td style="padding:32px">',
    "<p>Your one-time code is <strong>482901</strong></p>",
    '<img src="https://tracking.example.test/open.gif" alt="Tracking image">',
    "<script>parent.document.body.dataset.emailScriptRan = 'yes'</script>",
    "</td></tr></tbody></table>",
  ].join("");
  await page.route("https://tracking.example.test/**", async (route) => {
    trackingRequested = true;
    await route.abort();
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/html")) {
      separateHtmlRequested = true;
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.route("**/api/mail/conversations/*", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as {
      messages: Array<{
        id: string;
        bodyText: string;
        bodyHtml: string | null;
        quotedText: string | null;
      }>;
    };
    const message = body.messages.find((item) => item.id === "msg_demo_01");
    if (message) {
      message.bodyText = messageBodyText;
      message.bodyHtml = messageHtml;
      message.quotedText = null;
    }
    await route.fulfill({ response, json: body });
  });
  await page.evaluate(() => {
    document.body.dataset.plainFallbackSeen = "no";
    const observer = new MutationObserver(() => {
      if (document.body.textContent?.includes("Plain fallback must not flash")) {
        document.body.dataset.plainFallbackSeen = "yes";
        observer.disconnect();
      }
    });
    observer.observe(document.body, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  });

  await page.getByRole("button", { name: "Open The craft behind fast software" }).click();
  const frame = page.frameLocator('iframe[title^="HTML body of"]');
  await expect(frame.getByText("482901", { exact: false })).toBeVisible();
  await expect(frame.getByRole("img", { name: "Tracking image" })).toHaveCount(1);
  expect(await page.locator("body").getAttribute("data-email-script-ran")).toBeNull();
  expect(trackingRequested).toBe(false);
  expect(separateHtmlRequested).toBe(false);
  expect(await page.locator("body").getAttribute("data-plain-fallback-seen"))
    .toBe("no");

  const iframe = page.locator('iframe[title^="HTML body of"]');
  await expect.poll(() => iframe.evaluate((element) => element.clientWidth))
    .toBeGreaterThan(300);
  const initialHeight = await iframe.evaluate((element) => element.clientHeight);
  await frame.locator("body").evaluate((body) => {
    const lateContent = document.createElement("div");
    lateContent.style.height = "240px";
    lateContent.textContent = "Late content";
    body.append(lateContent);
  });
  await expect.poll(() => iframe.evaluate((element) => element.clientHeight))
    .toBeGreaterThan(initialHeight + 150);
  const documentWidth = await frame.locator("html").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(documentWidth.scroll).toBeLessThanOrEqual(documentWidth.client);

  messageBodyText = "hello";
  messageHtml = '<div dir="ltr">hello</div>';
  await page.reload();

  const plainMessage = page.locator('[data-message-id="msg_demo_01"]');
  await expect(plainMessage.getByText("hello", { exact: true })).toBeVisible();
  await expect(plainMessage.locator("iframe")).toHaveCount(0);
  await expect.poll(() =>
    plainMessage.locator('[data-slot="bubble-content"]').evaluate(
      (element) => element.clientWidth,
    )
  ).toBeLessThan(300);
});

test("opens outbound delivery details without crashing", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Delivery menu behavior is covered once");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.getByRole("button", { name: "Open The craft behind fast software" }).click();

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
  await expect(page).toHaveURL(/\/mail\//u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await expect(composer).toBeVisible();
  await expect(
    composer.getByRole("textbox", { name: "Message body" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cc", exact: true }).click();
  await page.getByRole("button", { name: "Bcc", exact: true }).click();
  await expect(composer.locator("span").filter({ hasText: /^Cc$/u })).toBeVisible();
  await expect(composer.locator("span").filter({ hasText: /^Bcc$/u })).toBeVisible();
});

test("admin can edit an existing user and create recovery", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop administration assertion");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);
  await page.getByRole("button", { name: /^Account and mailboxes/u }).click();
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
  const firstConversation = page.getByRole("button", {
    name: "Open The craft behind fast software",
  });
  const inboxBox = await firstConversation.boundingBox();
  expect(inboxBox).not.toBeNull();
  expect(inboxBox!.width).toBeGreaterThan(1150);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await expect(composer).toBeVisible({ timeout: 10_000 });
  const box = await composer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(620);
  expect(box!.height).toBeLessThanOrEqual(620);
  expect(box!.x + box!.width).toBeGreaterThan(1000);
  expect(box!.y + box!.height).toBeGreaterThan(650);
});

test("shared mailbox reads only visible messages and shows every viewer", async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop visibility behavior");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  const mailboxMenuButton = page.getByRole("button", {
    name: "Account and mailboxes, 3 unread in other mailboxes",
    exact: true,
  });
  await expect(mailboxMenuButton).toBeVisible();
  await mailboxMenuButton.click();
  const supportMailbox = page.getByRole("menuitem", { name: /Customer care/u });
  await expect(supportMailbox).toBeVisible();
  await expect(
    supportMailbox.getByLabel("3 unread messages"),
  ).toBeVisible();
  await supportMailbox.click();

  await page.route("**/api/mail/conversations/conv_demo_customer3?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as {
      messages: Array<{ id: string; bodyText: string | null }>;
    };
    const first = body.messages.find((message) => message.id === "msg_demo_10");
    if (first) {
      first.bodyText = Array.from(
        { length: 80 },
        (_, index) => `Visible message line ${index + 1}`,
      ).join("\n");
    }
    await route.fulfill({ response, json: body });
  });

  let firstMessageReadAttempts = 0;
  await page.route("**/api/mail/messages/msg_demo_10/read?*", async (route) => {
    firstMessageReadAttempts += 1;
    if (firstMessageReadAttempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { message: "Temporary read failure" },
        }),
      });
      return;
    }
    await route.continue();
  });

  const readMessageIds = new Set<string>();
  page.on("request", (request) => {
    if (request.method() !== "PATCH") return;
    const match = new URL(request.url()).pathname.match(
      /\/api\/mail\/messages\/([^/]+)\/read$/u,
    );
    if (match && request.postDataJSON()?.isRead === true) {
      readMessageIds.add(match[1]!);
    }
  });

  await page.getByRole("button", { name: "Open Shared inbox notifications" }).click();
  const archiveButton = page.getByRole("button", { name: "Archive conversation" });
  await archiveButton.hover();
  await expect(page.locator('[data-slot="tooltip-content"]'))
    .toHaveText("Archive conversation");
  await expect.poll(() => firstMessageReadAttempts, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(2);
  await expect.poll(() => readMessageIds.has("msg_demo_10")).toBe(true);
  await page.waitForTimeout(700);
  expect(readMessageIds.has("msg_demo_11")).toBe(false);
  const firstMessage = page.locator('[data-message-id="msg_demo_10"]');
  const viewedBy = firstMessage.getByText("Viewed by Ilya Morozov");
  await expect(viewedBy).toBeVisible();
  await firstMessage.hover();
  const viewedByBox = await viewedBy.boundingBox();
  const actionsBox = await firstMessage.locator('[data-slot="bubble-reactions"]').boundingBox();
  expect(viewedByBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(viewedByBox!.y + viewedByBox!.height).toBeLessThan(actionsBox!.y);

  const mayaContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const mayaPage = await mayaContext.newPage();
  await mayaPage.goto("/");
  const loginStatus = await mayaPage.evaluate(async () => {
    const response = await fetch("/api/auth/mock/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "usr_demo_member" }),
    });
    return response.status;
  });
  expect(loginStatus).toBe(200);
  await mayaPage.goto("/mail/mbx_demo_support?folder=inbox");
  await mayaPage.getByRole("button", { name: "Open Shared inbox notifications" }).click();
  await expect(
    mayaPage.locator('[data-message-id="msg_demo_10"]')
      .getByText(/Maya Chen/u),
  ).toBeVisible();
  await mayaContext.close();

  await expect(
    firstMessage.getByText("Viewed by Ilya Morozov and Maya Chen"),
  ).toBeVisible({ timeout: 10_000 });

  await page.locator('[data-message-id="msg_demo_11"]').scrollIntoViewIfNeeded();
  await expect.poll(() => readMessageIds.has("msg_demo_11")).toBe(true);
  await page.getByRole("button", { name: "Mark conversation as unread" }).click();
  const unreadConversation = page.getByRole("button", {
    name: "Open Shared inbox notifications",
  });
  await expect(unreadConversation).toBeVisible();
  await expect(
    unreadConversation.locator("..").getByLabel("1 unread messages"),
  ).toBeVisible();
});

test("closes the mailbox composer when switching mailboxes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Composer routing is covered once");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\/mbx_demo_personal\?/u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByRole("textbox", { name: "Message body" }).fill("Pinned draft");

  await page.getByRole("button", { name: /^Account and mailboxes/u }).click();
  await page.getByRole("menuitem", { name: /Customer care/u }).click();

  await expect(page).toHaveURL(/\/mail\/mbx_demo_support\?/u);
  await expect(composer).toHaveCount(0);
  await page.getByRole("button", { name: "Compose" }).click();
  const supportComposer = page.getByRole("dialog", { name: "New message" });
  await expect(supportComposer.getByText("From support@demo.example")).toBeVisible();
  await expect(
    supportComposer.getByRole("textbox", { name: "Message body" }),
  ).toHaveText("");
});

test("composer formats, autocompletes recipients, and uploads files immediately", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop composer interactions");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });

  const recipient = composer.getByRole("textbox", { name: "To recipients" });
  await recipient.fill("karri");
  const suggestion = composer.getByRole("option", { name: /Karri Saarinen/u });
  await expect(suggestion).toBeVisible();
  await suggestion.click();
  await expect(composer.getByText("Karri Saarinen", { exact: true })).toBeVisible();

  const body = composer.getByRole("textbox", { name: "Message body" });
  await body.pressSequentially("# Heading");
  await expect(body.locator("h1")).toHaveCount(0);
  await expect(body).toContainText("# Heading");
  await body.fill("Formatted message");
  await body.press("ControlOrMeta+a");
  await composer.getByRole("button", { name: "Bold" }).click();
  await expect(body.locator("strong")).toHaveText("Formatted message");

  const uploadCreated = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes("/api/mail/uploads?")
    && response.status() === 201
  );
  await composer.locator('input[type="file"]:not([accept])').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("composer upload"),
  });
  await uploadCreated;
  await expect(composer.getByText("Attached", { exact: true })).toBeVisible();

  const inlineUploadCreated = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes("/api/mail/uploads?")
    && response.status() === 201
  );
  await composer.locator('input[type="file"][accept]').setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"),
  });
  await inlineUploadCreated;
  await expect(composer.locator('img[alt="pixel.png"]')).toBeVisible();
  await expect(composer.getByText("Inline", { exact: true })).toBeVisible();

  const droppedUploadCreated = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes("/api/mail/uploads?")
    && response.status() === 201
  );
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    const png = atob(
      "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABpUlEQVR4nO2RUQnAQBSAXpzFuf6sy/Z9FhAeChbQeZ/zbXC2YIdsCLBDNgTYIRsC7JANAXbIhgA7ZEOAHbIhwA7ZEGCHbAiwQzYE2CEbAuyQDQF2yIYAO2RDgB2yIcAO2RBgh2wIsEM2BNghGwLskA0BdsiGADtkQ4AdsiHADtkQYIdsCLBDNgTYIRsC7JANAXbIhgA7ZEOAHbIhwA7ZEGCHbAiwQzYE2CEbAuyQDQF2yIYAO2RDgB2yIcAO2RBgh2wIsEM2BNghGwLskA0BdsiGADtkQ4AdsiHADtkQYIdsCLBDNgTYIRsC7JANAXbIhgA7ZEOAHbIhwA7ZEGCHbAiwQzYE2CEbAuyQDQF2yIYAO2RDgB2yIcAO2RBgh2wIsEM2BNghGwLskA0BdsiGADtkQ4AdsiHADtkQYIdsCLBDNgTYIRsC7JANAXbIhgA7ZEOAHbIhwA7ZEGCHbAiwQzYE2CEbAuyQDQF2yIYAO2RDgB2yIcAO2RBgh2wIsEM2BNghGwLskA0BdsiGADtkQ4AdsiHADtkQYIdsCLBDNgTYIRsyFz+rwWe8YrA/egAAAABJRU5ErkJggg==",
    );
    transfer.items.add(new File(
      [Uint8Array.from(png, (character) => character.charCodeAt(0))],
      "dropped.png",
      { type: "image/png" },
    ));
    return transfer;
  });
  const dropOverlay = composer.getByText(
    "Drop images into the message · other files attach below",
    { exact: true },
  );
  const editorDropSurface = composer.locator("[data-composer-editor-surface]");
  await editorDropSurface.dispatchEvent(
    "dragenter",
    { dataTransfer },
  );
  await expect(dropOverlay).toBeVisible();
  await editorDropSurface.dispatchEvent("drop", { dataTransfer });
  await droppedUploadCreated;
  await expect(dropOverlay).toHaveCount(0);
  const droppedImage = composer.locator('img[alt="dropped.png"]');
  await expect(droppedImage).toBeVisible();
  await expect(droppedImage).not.toHaveClass(/ProseMirror-selectednode/u);
  await expect.poll(() =>
    droppedImage.evaluate((image) => image.closest("p")?.tagName)
  ).toBe("P");
  await expect(body).toBeFocused();
  await expect.poll(() =>
    droppedImage.evaluate((image) => {
      const selection = window.getSelection();
      const parent = image.closest("p");
      let wrapper: Node | null = image;
      while (wrapper?.parentNode && wrapper.parentNode !== parent) {
        wrapper = wrapper.parentNode;
      }
      if (!parent || !selection?.isCollapsed || selection.anchorNode !== parent) {
        return false;
      }
      const imageIndex = Array.prototype.indexOf.call(
        parent.childNodes,
        wrapper,
      );
      return selection.anchorOffset === imageIndex + 1;
    })
  ).toBe(true);

  const pastedUploadCreated = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes("/api/mail/uploads?")
    && response.status() === 201
  );
  await body.evaluate((editor) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "Pasted caption");
    transfer.items.add(new File(
      [new Uint8Array([137, 80, 78, 71])],
      "pasted.png",
      { type: "image/png" },
    ));
    editor.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  });
  await pastedUploadCreated;
  await expect(body).toContainText("Pasted caption");
  await expect(composer.locator('img[alt="pasted.png"]')).toBeVisible();
  await expect(page).toHaveURL(/\/mail\//u);
});

test("retries upload finalization without uploading the file again", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop composer lifecycle");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  let contentUploads = 0;
  let completions = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "PUT" && pathname === "/api/mail/uploads/content") {
      contentUploads += 1;
    }
  });
  await page.route("**/api/mail/uploads/*/complete?**", async (route) => {
    completions += 1;
    if (completions === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "UNAVAILABLE", message: "Response was lost" },
        }),
      });
      return;
    }
    await route.continue();
  });

  await composer.locator('input[type="file"]:not([accept])').setInputFiles({
    name: "finalize-retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("upload once"),
  });

  await expect(composer.getByText("Attached", { exact: true })).toBeVisible();
  expect(contentUploads).toBe(1);
  expect(completions).toBe(2);
  await composer.getByRole("button", { name: "Close composer" }).click();
});

test("places a large linked attachment in the message and lets it move with the text", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop composer interactions");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  const body = composer.getByRole("textbox", { name: "Message body" });
  await body.pressSequentially("Before");
  await body.press("Enter");
  await body.pressSequentially("After");

  let releaseUpload = () => {};
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  await page.route("**/api/mail/uploads/content?**", async (route) => {
    await uploadGate;
    await route.continue();
  });

  const filename = "quarterly-video.mp4";
  await composer.locator('input[type="file"]:not([accept])').setInputFiles({
    name: filename,
    mimeType: "video/mp4",
    buffer: Buffer.alloc(4_000_000, 1),
  });
  const linkedAttachment = composer.locator("[data-linked-attachment-node]");
  await expect(linkedAttachment).toBeVisible();
  await expect(linkedAttachment).toContainText(filename);
  await expect(linkedAttachment).toContainText("Uploading");
  await expect.poll(() =>
    linkedAttachment.evaluate((attachment) =>
      attachment.parentElement?.classList.contains("ProseMirror-selectednode")
    )
  ).toBe(false);
  await expect.poll(() =>
    linkedAttachment.evaluate((attachment) => {
      const selection = window.getSelection();
      const parent = attachment.closest("p");
      let wrapper: Node | null = attachment;
      while (wrapper?.parentNode && wrapper.parentNode !== parent) {
        wrapper = wrapper.parentNode;
      }
      if (!parent || !selection?.isCollapsed || selection.anchorNode !== parent) {
        return false;
      }
      const attachmentIndex = Array.prototype.indexOf.call(
        parent.childNodes,
        wrapper,
      );
      return selection.anchorOffset === attachmentIndex + 1;
    })
  ).toBe(true);

  releaseUpload();
  await expect(linkedAttachment).toContainText("30-day link");
  await expect(composer.getByText(filename, { exact: true })).toHaveCount(1);

  await composer.getByRole("button", { name: "Undo" }).click();
  await expect(linkedAttachment).toHaveCount(0);
  await composer.getByRole("button", { name: "Redo" }).click();
  await expect(linkedAttachment).toContainText(filename);

  const attachmentIndex = () =>
    body.evaluate((editor) =>
      Array.from(editor.children).findIndex((child) =>
        child.querySelector("[data-linked-attachment-node]")
      )
    );
  const indexBeforeDrag = await attachmentIndex();
  const firstParagraph = body.locator("p").first();
  await linkedAttachment.dragTo(firstParagraph);
  await expect.poll(attachmentIndex).not.toBe(indexBeforeDrag);

  await linkedAttachment.getByRole("button", { name: `Remove ${filename}` }).click();
  await expect(linkedAttachment).toHaveCount(0);

  await composer.getByRole("button", { name: "Undo" }).click();
  await expect(linkedAttachment).toBeVisible();
  await expect(linkedAttachment).toContainText(filename);

  await linkedAttachment.getByRole("button", { name: `Remove ${filename}` }).click();
  await expect(linkedAttachment).toHaveCount(0);
  const cleanup = page.waitForResponse((response) =>
    response.request().method() === "DELETE"
    && response.url().includes("/api/mail/uploads/")
    && response.status() === 200
  );
  await composer.getByRole("button", { name: "Close composer" }).click();
  await cleanup;
});

test("keeps an attachment position when preflight changes it into a link", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop composer interactions");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  const body = composer.getByRole("textbox", { name: "Message body" });
  await body.pressSequentially("Before");
  await body.press("Enter");
  await body.pressSequentially("After");

  let preflightCount = 0;
  await page.route("**/api/mail/attachment-preflight", async (route) => {
    const request = route.request().postDataJSON() as {
      attachments: Array<{ uploadId: string }>;
    };
    preflightCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        externalizedAttachments: preflightCount > 1 ? 1 : 0,
        linkedUploadIds: preflightCount > 1
          ? request.attachments.map((attachment) => attachment.uploadId)
          : [],
      }),
    });
  });

  const filename = "positioned.txt";
  await composer.locator('input[type="file"]:not([accept])').setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from("positioned attachment"),
  });
  await expect(composer.getByText("Attached", { exact: true })).toBeVisible();
  await expect(
    composer.locator("[data-linked-attachment-node]"),
  ).toHaveCount(0);
  await expect.poll(() => preflightCount).toBe(1);

  await body.press("ControlOrMeta+Home");
  await body.pressSequentially("Changed ");
  const linkedAttachment = composer.locator("[data-linked-attachment-node]");
  await expect(linkedAttachment).toContainText(filename);
  await expect.poll(() =>
    linkedAttachment.evaluate((attachment) =>
      attachment.closest("p")?.textContent ?? ""
    )
  ).toContain("After");

  await composer.getByRole("button", { name: "Close composer" }).click();
});

test("previews a large inline image as the link that will be sent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop composer interactions");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByRole("textbox", { name: "To recipients" })
    .fill("karri@example.com");
  await composer.getByRole("textbox", { name: "To recipients" }).press("Enter");
  await composer.getByRole("textbox", { name: "Subject" }).fill("Large inline preview");
  await composer.getByRole("textbox", { name: "Message body" }).fill("See image.");

  const filename = "large-inline.png";
  await composer.locator('input[type="file"][accept]').setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: Buffer.alloc(4_000_000, 1),
  });
  const linkedImage = composer.locator("[data-linked-attachment-node]")
    .filter({ hasText: filename });
  await expect(linkedImage).toContainText("30-day link");
  await expect(composer.locator(`img[alt="${filename}"]`)).toHaveCount(0);
  await expect(composer.getByText(filename, { exact: true })).toHaveCount(1);

  const requestPromise = page.waitForRequest((request) =>
    request.method() === "POST"
    && new URL(request.url()).pathname === "/api/mail/messages"
  );
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  const request = await requestPromise;
  const payload = request.postDataJSON() as {
    attachments: Array<{
      disposition: string;
      contentId?: string;
    }>;
  };
  expect(payload.attachments).toEqual([
    expect.objectContaining({ disposition: "attachment" }),
  ]);
  expect(payload.attachments[0]).not.toHaveProperty("contentId");
  await expect(composer).toHaveCount(0);
});

test("keeps undo-retained uploads inside composer limits", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop composer interactions");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  const fileInput = composer.locator('input[type="file"]:not([accept])');
  const filename = "undo-reserved-video.mp4";

  await fileInput.setInputFiles({
    name: filename,
    mimeType: "video/mp4",
    buffer: Buffer.alloc(4_000_000, 1),
  });
  const linkedAttachment = composer.locator("[data-linked-attachment-node]");
  await expect(linkedAttachment).toContainText("30-day link");
  await linkedAttachment.getByRole("button", { name: `Remove ${filename}` }).click();
  await expect(linkedAttachment).toHaveCount(0);

  await fileInput.setInputFiles(
    Array.from({ length: 10 }, (_, index) => ({
      name: `replacement-${index + 1}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(`replacement ${index + 1}`),
    })),
  );
  await expect(page.getByText("Use at most 10 attachments", { exact: true }))
    .toBeVisible();
  await expect(composer.getByText("Attached", { exact: true })).toHaveCount(0);

  await composer.getByRole("button", { name: "Undo" }).click();
  await expect(linkedAttachment).toBeVisible();
  await composer.getByRole("button", { name: "Close composer" }).click();
});

test("does not discard submitted uploads while send is in flight", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop composer interactions");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByRole("textbox", { name: "To recipients" })
    .fill("karri@example.com");
  await composer.getByRole("textbox", { name: "To recipients" }).press("Enter");
  await composer.getByRole("textbox", { name: "Message body" })
    .fill("Submission ownership");
  await composer.locator('input[type="file"]:not([accept])').setInputFiles({
    name: "claimed.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("claimed upload"),
  });
  await expect(composer.getByText("Attached", { exact: true })).toBeVisible();

  let releaseSend = () => {};
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  await page.route("**/api/mail/messages", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await sendGate;
    await route.continue();
  });

  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer.getByRole("textbox", { name: "To recipients" }))
    .toBeDisabled();
  await expect(composer.getByRole("textbox", { name: "Subject" }))
    .toBeDisabled();
  await expect(composer.getByRole("textbox", { name: "Message body" }))
    .toHaveAttribute("contenteditable", "false");
  await expect(composer.getByRole("button", { name: "Add attachments" }))
    .toBeDisabled();
  const preventedFileDrop = await composer.evaluate((dialog) => {
    const form = dialog.querySelector("form")!;
    const transfer = new DataTransfer();
    transfer.items.add(new File(["ignored"], "ignored.txt", {
      type: "text/plain",
    }));
    const dragOver = new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    const drop = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    form.dispatchEvent(dragOver);
    form.dispatchEvent(drop);
    return dragOver.defaultPrevented && drop.defaultPrevented;
  });
  expect(preventedFileDrop).toBe(true);
  await composer.getByRole("button", { name: "Close composer" }).click();
  await expect(composer).toBeVisible();
  await expect(page.getByText("Wait for the message to finish sending", { exact: true }))
    .toBeVisible();

  releaseSend();
  await expect(composer).toHaveCount(0);
});

test("retries a transient send with the same request id", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop composer lifecycle");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByRole("textbox", { name: "To recipients" })
    .fill("karri@example.com");
  await composer.getByRole("textbox", { name: "To recipients" }).press("Enter");
  await composer.getByRole("textbox", { name: "Message body" })
    .fill("Idempotent retry");

  const requestIds: string[] = [];
  await page.route("**/api/mail/messages", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    requestIds.push(
      (route.request().postDataJSON() as { requestId: string }).requestId,
    );
    if (requestIds.length === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "UNAVAILABLE", message: "Try again" },
        }),
      });
      return;
    }
    await route.continue();
  });

  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveCount(0);
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).toBe(requestIds[0]);
});

test("cancels final attachment preflight when composer unmounts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop composer lifecycle");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByRole("textbox", { name: "To recipients" })
    .fill("karri@example.com");
  await composer.getByRole("textbox", { name: "To recipients" }).press("Enter");
  await composer.getByRole("textbox", { name: "Message body" })
    .fill("Do not send after close");
  await composer.locator('input[type="file"]:not([accept])').setInputFiles({
    name: "cancelled-preflight.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("cancelled preflight"),
  });
  await expect(composer.getByText("Attached", { exact: true })).toBeVisible();

  let releasePreflight = () => {};
  const preflightGate = new Promise<void>((resolve) => {
    releasePreflight = resolve;
  });
  let markPreflightStarted = () => {};
  const preflightStarted = new Promise<void>((resolve) => {
    markPreflightStarted = resolve;
  });
  await page.route("**/api/mail/attachment-preflight", async (route) => {
    markPreflightStarted();
    await preflightGate;
    await route.continue().catch(() => {});
  });
  let sendRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST"
      && new URL(request.url()).pathname === "/api/mail/messages"
    ) {
      sendRequests += 1;
    }
  });

  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await preflightStarted;
  await page.getByRole("button", { name: /^Account and mailboxes/u }).click();
  await page.getByRole("menuitem", { name: /Customer care/u }).click();
  await expect(composer).toHaveCount(0);
  releasePreflight();

  await page.waitForTimeout(300);
  expect(sendRequests).toBe(0);
});

test("does not restart a retry after composer closes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop composer lifecycle");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\/mbx_demo_personal/u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  let uploadIntents = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST"
      && new URL(request.url()).pathname === "/api/mail/uploads"
    ) {
      uploadIntents += 1;
    }
  });
  let failNextUpload = true;
  await page.route("**/api/mail/uploads/content?**", async (route) => {
    if (failNextUpload) {
      failNextUpload = false;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Simulated upload failure" }),
      });
      return;
    }
    await route.continue();
  });

  const filename = "retry-close.txt";
  await composer.locator('input[type="file"]:not([accept])').setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from("retry close"),
  });
  await expect(composer.getByText("Failed", { exact: true })).toBeVisible();
  expect(uploadIntents).toBe(1);

  let releaseDelete = () => {};
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let markDeleteStarted = () => {};
  const deleteStarted = new Promise<void>((resolve) => {
    markDeleteStarted = resolve;
  });
  await page.route("**/api/mail/uploads/**", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    markDeleteStarted();
    await deleteGate;
    await route.continue().catch(() => {});
  });

  await composer.getByRole("button", { name: `Retry ${filename}` }).click();
  await deleteStarted;
  await composer.getByRole("button", { name: "Close composer" }).click();
  await expect(composer).toHaveCount(0);
  releaseDelete();

  await page.waitForTimeout(300);
  expect(uploadIntents).toBe(1);
});

test("shows upload intent failures inside the attachment card", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop composer interactions");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await page.route("**/api/mail/uploads?**", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { code: "BAD_REQUEST", message: "Simulated intent failure" },
      }),
    });
  });

  const filename = "intent-failure.txt";
  await composer.locator('input[type="file"]:not([accept])').setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from("intent failure"),
  });
  const card = composer.locator("[data-linked-attachment-node]");
  await expect(card).toContainText(filename);
  await expect(card).toContainText("Upload failed");
  await expect(composer.getByText("Failed", { exact: true })).toBeVisible();

  await composer.getByRole("button", { name: "Close composer" }).click();
});

test("offers Reply and Reply all on a group message", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.getByRole("button", { name: "Open Your Workers architecture review" }).click();

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
  await replyForm.getByRole("button", { name: "Cc", exact: true }).click();
  const replyCc = replyForm.getByRole("textbox", { name: "Cc recipients" });
  await replyCc.fill("maya");
  await replyForm.getByRole("option", { name: /Maya Chen/u }).click();
  await expect(replyForm.getByText("Maya Chen", { exact: true })).toBeVisible();
  await replyForm.getByRole("button", { name: /Remove maya@/u }).click();
  const replyUploadCreated = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes("/api/mail/uploads?")
    && response.status() === 201
  );
  const replyDropPrevented = await replyForm.evaluate((form) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(
      [new Uint8Array(4_000_000)],
      "reply-note.txt",
      { type: "text/plain" },
    ));
    const dragOver = new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    const drop = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    form.dispatchEvent(dragOver);
    form.dispatchEvent(drop);
    return dragOver.defaultPrevented && drop.defaultPrevented;
  });
  expect(replyDropPrevented).toBe(true);
  await replyUploadCreated;
  await expect(replyForm.getByText("30-day link", { exact: true })).toBeVisible();
  await replyForm.getByPlaceholder(/Reply to/u).fill("Following up privately.");
  await replyForm.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("folder")).toBe("sent");
  expect(new URL(page.url()).searchParams.get("conversation")).toMatch(/^conv_/u);
  await expect(page.getByText("Following up privately.", { exact: false })).toBeVisible();
  await expect(page.getByText("reply-note.txt", { exact: true })).toBeVisible();
});

test("restores an archived conversation to the inbox", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "State transition is covered once");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.getByRole("button", { name: "Open Friday launch checklist" }).click();
  await page.getByRole("button", { name: "Archive conversation" }).click();

  await page.getByRole("tab", { name: /Archive/u }).click();
  await page.getByRole("button", { name: /Friday launch checklist/u }).click();
  await page.getByRole("button", { name: "Restore conversation" }).click();

  await page.getByRole("tab", { name: /Inbox/u }).click();
  await expect(page.getByText("Friday launch checklist", { exact: true })).toBeVisible();
});

test("filters unread mail and applies bulk actions to loaded conversations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Bulk list actions are covered once");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);

  const unreadButton = page.getByRole("button", { name: "Unread", exact: true });
  const unreadRequest = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === "/api/mail/conversations"
      && url.searchParams.get("unreadOnly") === "true";
  });
  await unreadButton.click();
  await unreadRequest;
  await expect(unreadButton).toHaveAttribute("aria-pressed", "true");

  await unreadButton.click();
  await expect(unreadButton).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Open The craft behind fast software" }),
  ).toBeVisible();

  const loadedCount = await page.getByRole("button", { name: /^Open /u }).count();
  expect(loadedCount).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select loaded conversations" }).click();
  await expect(page.getByText(`${loadedCount} selected`, { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Deselect loaded conversations" }).click();
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();

  const subjects = [
    "The craft behind fast software",
    "Your Workers architecture review",
  ];
  for (const subject of subjects) {
    await page.getByRole("button", { name: `Select ${subject}` }).click();
  }
  await expect(page.getByRole("button", { name: "Move selected", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Archive selected" }).click();
  await expect(page.getByText("2 conversations archived", { exact: true })).toBeVisible();
  for (const subject of subjects) {
    await expect(page.getByRole("button", { name: `Open ${subject}` })).toHaveCount(0);
  }

  await page.getByRole("tab", { name: /Archive/u }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  for (const subject of subjects) {
    await page.getByRole("button", { name: `Select ${subject}` }).click();
  }
  await page.getByRole("button", { name: "Restore selected" }).click();
  await expect(page.getByText("2 conversations restored", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: /Inbox/u }).click();
  for (const subject of subjects) {
    await expect(page.getByRole("button", { name: `Open ${subject}` })).toBeVisible();
  }
});

test("permanently deletes a selected conversation from Trash", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Destructive bulk action is covered once");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();

  const subject = `Permanent delete ${Date.now()}`;
  const created = await page.evaluate(async (messageSubject) => {
    const response = await fetch("/api/mail/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        mailboxId: "mbx_demo_personal",
        to: ["delete-test@example.com"],
        cc: [],
        bcc: [],
        subject: messageSubject,
        bodyText: "Temporary conversation used by the permanent-delete test.",
        attachments: [],
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    return await response.json() as { conversationId: string };
  }, subject);

  await page.goto("/mail/mbx_demo_personal?folder=sent");
  await expect(page.getByRole("button", { name: `Open ${subject}` })).toBeVisible();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: `Select ${subject}` }).click();
  await expect(page.getByRole("button", { name: "Move selected", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Move selected to Trash" }).click();
  await expect(page.getByText("1 conversation moved to Trash", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Open ${subject}` })).toHaveCount(0);

  await page.getByRole("tab", { name: /Trash/u }).click();
  await expect(page.getByRole("button", { name: `Open ${subject}` })).toBeVisible();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: `Select ${subject}` }).click();
  await page.getByRole("button", { name: "Delete selected permanently" }).click();
  await expect(page.getByRole("heading", { name: "Delete permanently?" })).toBeVisible();
  await page.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(page.getByText("1 conversation deleted permanently", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Open ${subject}` })).toHaveCount(0);

  const deletedStatus = await page.evaluate(async (conversationId) => {
    const response = await fetch(
      `/api/mail/conversations/${encodeURIComponent(conversationId)}?mailboxId=mbx_demo_personal`,
    );
    return response.status;
  }, created.conversationId);
  expect(deletedStatus).toBe(404);
});

test("opens a forwarded message in the corner composer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Composer path is covered once");
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await page.getByRole("button", { name: "Open The craft behind fast software" }).click();

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
  await expect(page).toHaveURL(/\/mail\//u);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  const accountButton = page.getByRole("button", { name: /^Account and mailboxes/u });
  await accountButton.click();
  const signOut = page.getByRole("menuitem", { name: "Sign out" });
  await expect(signOut).toBeVisible();
  await signOut.click();

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inbox" })).toHaveCount(0);
});
