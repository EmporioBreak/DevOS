import assert from "node:assert/strict";
import test from "node:test";
import {
  assertChatGptProjectScope,
  getChatGptProjectScope,
  loadChatGptBrowserConfig,
  validateChatGptUrl,
} from "../src/browser-config.js";

test("loads deterministic browser defaults", () => {
  const config = loadChatGptBrowserConfig({
    HOME: "/tmp/home",
    DEVOS_CHATGPT_PROJECT_URL: "https://chatgpt.com/",
    DEVOS_BROWSER_PROFILE_DIR: "/tmp/devos-profile",
  });

  assert.equal(config.projectUrl, "https://chatgpt.com/");
  assert.equal(config.browserChannel, "chrome");
  assert.equal(config.profileDir, "/tmp/devos-profile");
  assert.equal(config.headless, false);
});

test("project-local ChatGPT Project URL overrides environment fallback", () => {
  const config = loadChatGptBrowserConfig(
    {
      DEVOS_CHATGPT_PROJECT_URL: "https://chatgpt.com/g/environment/",
      DEVOS_BROWSER_PROFILE_DIR: "/tmp/devos-profile",
    },
    "https://chatgpt.com/g/project/c/",
  );

  assert.equal(config.projectUrl, "https://chatgpt.com/g/project/c/");
});

test("only accepts ChatGPT https hosts", () => {
  assert.equal(validateChatGptUrl("https://chatgpt.com/c/abc").hostname, "chatgpt.com");
  assert.throws(() => validateChatGptUrl("https://example.com/"), /Invalid ChatGPT URL/);
  assert.throws(() => validateChatGptUrl("http://chatgpt.com/"), /Invalid ChatGPT URL/);
});


test("extracts project identity from the configured project new-chat URL", () => {
  assert.deepEqual(
    getChatGptProjectScope("https://chatgpt.com/g/g-p-project/c/"),
    { origin: "https://chatgpt.com", projectId: "g-p-project" },
  );
  assert.equal(getChatGptProjectScope("https://chatgpt.com/"), null);
});

test("accepts the configured ChatGPT Project landing URL", () => {
  const projectUrl = "https://chatgpt.com/g/g-p-project-denis-devos/";
  assert.deepEqual(getChatGptProjectScope(projectUrl), {
    origin: "https://chatgpt.com",
    projectId: "g-p-project-denis-devos",
  });
  assert.equal(
    assertChatGptProjectScope(
      projectUrl,
      "https://chatgpt.com/g/g-p-project-denis-devos/",
    ).pathname,
    "/g/g-p-project-denis-devos/",
  );
  assert.equal(
    assertChatGptProjectScope(
      projectUrl,
      "https://chatgpt.com/g/g-p-project-denis-devos/c/conversation-1",
      true,
    ).pathname,
    "/g/g-p-project-denis-devos/c/conversation-1",
  );
});

test("accepts the live ChatGPT Project overview as a landing state only", () => {
  const projectUrl = "https://chatgpt.com/g/g-p-project-denis-devos/";
  const overviewUrl =
    "https://chatgpt.com/g/g-p-project-denis-devos/project";

  assert.equal(
    assertChatGptProjectScope(projectUrl, overviewUrl).pathname,
    "/g/g-p-project-denis-devos/project",
  );
  assert.throws(
    () => assertChatGptProjectScope(projectUrl, overviewUrl, true),
    /Project conversation URL did not appear/,
  );
  assert.throws(
    () =>
      assertChatGptProjectScope(
        projectUrl,
        "https://chatgpt.com/g/g-p-other/project",
      ),
    /escaped the configured Project/,
  );
});

test("rejects a configured ChatGPT URL that cannot enforce project scope", () => {
  assert.throws(
    () => getChatGptProjectScope("https://chatgpt.com/c/standalone"),
    /Invalid configured ChatGPT Project URL/,
  );
});

test("accepts only conversations in the configured ChatGPT Project", () => {
  assert.equal(
    assertChatGptProjectScope(
      "https://chatgpt.com/g/g-p-project/c/",
      "https://chatgpt.com/g/g-p-project/c/conversation-1",
      true,
    ).pathname,
    "/g/g-p-project/c/conversation-1",
  );

  assert.throws(
    () =>
      assertChatGptProjectScope(
        "https://chatgpt.com/g/g-p-project/c/",
        "https://chatgpt.com/c/standalone",
        true,
      ),
    /escaped the configured Project/,
  );
  assert.throws(
    () =>
      assertChatGptProjectScope(
        "https://chatgpt.com/g/g-p-project/c/",
        "https://chatgpt.com/g/g-p-other/c/conversation-2",
        true,
      ),
    /escaped the configured Project/,
  );
});

test("rejects provisional local ChatGPT conversation IDs as resumable sessions", () => {
  assert.throws(
    () =>
      assertChatGptProjectScope(
        "https://chatgpt.com/g/g-p-project-denis-devos/",
        "https://chatgpt.com/g/g-p-project-denis-devos/c/local-chatgpt%3A1234",
        true,
      ),
    /Project conversation URL did not appear/,
  );
});
