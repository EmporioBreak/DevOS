import assert from "node:assert/strict";
import test from "node:test";
import { loadChatGptBrowserConfig, validateChatGptUrl } from "../src/browser-config.js";

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
