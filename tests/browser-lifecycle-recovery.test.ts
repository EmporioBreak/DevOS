import { runInNewContext } from 'node:vm';
import type { BrowserContext, Page } from 'playwright-core';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGptBrowserExecutor, chatGptBrowserDeps, sendAndRead } from '../src/chatgpt-browser-executor.js';
import { loadChatGptBrowserConfig } from '../src/browser-config.js';
const saved = 'https://chatgpt.com/g/one/c/saved';
const terminal = 'Recovered\nDEVOS_RESULT {"status":"done"}';
function data(overrides: Record<string, unknown> = {}) {
  return {
    conversation_id: 'saved', mapping: {
      u: {
        id: 'u', parent: null, message: {
          id: 'u', author: {
            role: 'user'
          }, metadata: {
            turn_exchange_id: 'turn'
          }
        }
      }, a: {
        id: 'a', parent: 'u', message: {
          id: 'a', author: {
            role: 'assistant'
          }, channel: 'final', status: 'finished_successfully', end_turn: true, metadata: {
            turn_exchange_id: 'turn'
          }, content: {
            content_type: 'text', parts: [terminal]
          }, ...overrides
        }
      }
    }
  };
}
function fixture(options: {
  payload?: unknown;
  missingId?: boolean;
  navigationStatus?: number;
  failPreparation?: boolean;
  failStream?: boolean;
  changed?: boolean;
  pageGone?: boolean;
  fresh?: boolean;
  streamError?: string;
} = {}) {
  let sends = 0, newPages = 0, closed = 0, reads = 0, url = 'about:blank';
  const listeners = new Map<string, Function[]>();
  const page = {
    on(event: string, fn: Function) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    url: () => url, isClosed: () => options.pageGone === true && sends > 0,
    async goto(target: string) {
      url = options.changed && reads ? 'https://chatgpt.com/g/one/c/other' : target;
      return {
        status: () => reads ? (options.navigationStatus ?? 200) : 200
      };
    },
    locator() {
      return {
        first() {
          return this;
        }, async waitFor() {
          if (options.failPreparation)
            throw Error('ChatGPT authentication required');
        }, async fill() {
        }, async isVisible() {
          return true;
        }, async click() {
          sends++;
          if (options.fresh)
            url = saved;
          for (const fn of listeners.get('request') ?? [])
            fn({
              url: () => 'https://chatgpt.com/backend-api/f/conversation', method: () => 'POST', postDataJSON: () => ({
                ...(options.fresh ? {} : {
                  conversation_id: 'saved'
                }), messages: [{
                    id: options.missingId ? undefined : 'u', author: {
                      role: 'user'
                    }, content: {
                      content_type: 'text', parts: ['Work']
                    }
                  }]
              })
            });
        }, async press() {
          await this.click();
        }
      };
    },
    async evaluate(fn: Function) {
      if (fn.toString().includes('document.body'))
        return '';
      if (fn.toString().includes('__DEVOS_ARM_STREAM__'))
        return 1;
      return {
        text: terminal, failed: false
      };
    },
    async waitForFunction() {
      if (options.failStream !== false)
        throw Error(options.streamError ?? 'Execution context was destroyed');
    },
    async waitForResponse(predicate: Function) {
      reads++;
      const response = {
        url: () => 'https://chatgpt.com/backend-api/conversations/saved', status: () => options.navigationStatus ?? 200, json: async () => options.payload ?? data()
      };
      assert.equal(predicate(response), true);
      return response;
    },
    async close() {
    },
  };
  const context = {
    pages: () => [page], async newPage() {
      newPages++;
      return page;
    }, async close() {
      closed++;
    }
  };
  const executor = new ChatGptBrowserExecutor({
    projectUrl: 'https://chatgpt.com/g/one/project', profileDir: '/unused', headless: false
  }, 30);
  Object.assign(executor, {
    context
  });
  return {
    executor, sends: () => sends, newPages: () => newPages, closed: () => closed, reads: () => reads
  };
}
test('headed Camoufox is the reliability default', () => assert.equal(loadChatGptBrowserConfig({}).headless, false));
for (const mode of ['success', 'pre-submit', 'recovery'] as const)
  test(`initial persistent page reused and task context stays alive on ${mode}`, async () => {
    const f = fixture({
      failStream: mode === 'recovery', failPreparation: mode === 'pre-submit'
    });
    if (mode === 'pre-submit')
      await assert.rejects(f.executor.run({
        projectRoot: '/project', prompt: 'Work', sessionId: saved
      }));
    else
      assert.equal((await f.executor.run({
        projectRoot: '/project', prompt: 'Work', sessionId: saved
      })).text, terminal);
    assert.equal(f.newPages(), 0);
    assert.equal(f.closed(), 0);
    assert.equal(f.sends(), mode === 'pre-submit' ? 0 : 1);
  });
test('lost stream recovers exact submitted turn read-only, one send', async () => {
  const f = fixture();
  const r = await f.executor.run({
    projectRoot: '/project', prompt: 'Work', sessionId: saved
  });
  assert.equal(r.text, terminal);
  assert.equal(r.sessionId, saved);
  assert.equal(f.sends(), 1);
  assert.equal(f.reads(), 1);
  assert.equal(f.closed(), 0);
});
for (const [name, options] of Object.entries({
  'no outgoing identity': {
    missingId: true
  }, 'different turn': {
    payload: data({
      metadata: {
        turn_exchange_id: 'other'
      }
    })
  },
  'incomplete': {
    payload: data({
      status: 'in_progress', end_turn: false
    })
  }, 'failed': {
    payload: data({
      status: 'failed'
    })
  },
  'changed conversation': {
    changed: true
  }, '401': {
    navigationStatus: 401
  }, '403': {
    navigationStatus: 403
  }, '404': {
    navigationStatus: 404
  },
  'missing result': {
    payload: data({
      content: {
        content_type: 'text', parts: ['hello']
      }
    })
  }, 'malformed result': {
    payload: data({
      content: {
        content_type: 'text', parts: ['DEVOS_RESULT nope']
      }
    })
  },
  'different user': {
    payload: {
      conversation_id: 'saved', mapping: {}
    }
  }, 'different conversation data': {
    payload: {
      ...data(), conversation_id: 'other'
    }
  },
  'ambiguous finals': {
    payload: {
      ...data(), mapping: {
        ...data().mapping, b: {
          ...data().mapping.a, id: 'b', message: {
            ...data().mapping.a.message, id: 'b'
          }
        }
      }
    }
  },
}))
  test(`post-submit ${name} stops without replay and keeps task context`, async () => {
    const f = fixture(options);
    await assert.rejects(f.executor.run({
      projectRoot: '/project', prompt: 'Work', sessionId: saved
    }), /post-submit/);
    assert.equal(f.sends(), 1);
    assert.equal(f.closed(), 0);
    if (options.missingId)
      assert.equal(f.reads(), 0);
  });
test('hanging context cleanup is bounded and reported as failure', async () => {
  const f = fixture({
    failStream: false
  });
  Object.assign(f.executor, {
    context: {
      pages: () => [], async newPage() {
        throw Error('authentication required');
      }, close: () => new Promise(() => {
      })
    }
  });
  const started = Date.now();
  await assert.rejects(f.executor.close(), /cleanup.*unconfirmed/i);
  assert.ok(Date.now() - started < 250);
});
test('continued stream progress across old ten-minute boundary does not expire; idle does', async () => {
  let now = 0;
  const state = {
    request: 1, text: null, failed: false, lastActivityAt: 0
  };
  const locator = {
    first() {
      return this;
    }, async click() {
    }, async press() {
    }
  };
  const page = {
    locator: () => locator, async waitForFunction(fn: Function, arg: unknown, options: {
      timeout: number;
    }) {
      assert.equal(options.timeout, 60 * 60000);
      const ready = () => runInNewContext(`(${fn.toString()})(arg)`, {
        arg, window: {
          __DEVOS_STREAM_STATE__: state
        }, Date: {
          now: () => now
        }
      });
      now = 11 * 60000;
      state.lastActivityAt = now - 1000;
      assert.equal(ready(), false, 'active generation must keep waiting past ten minutes');
      now += 6 * 60000;
      assert.equal(ready(), true, 'idle generation must enter recovery');
    }, async evaluate() {
      return state;
    }
  } as unknown as Page;
  await assert.rejects(sendAndRead(page, 'Work', 60 * 60000, undefined, {
    token: 1, useButton: true
  }), /response idle timeout/i);
});
test('recovery JSON body that never finishes is bounded and sends once', async () => {
  const f = fixture();
  // Keep the actual outgoing POST proof while simulating a wedged read transport.
  const context = (f.executor as unknown as {
    context: {
      pages(): Array<{
        waitForResponse: Function;
      }>;
    };
  }).context;
  context.pages()[0]!.waitForResponse = async () => ({
    status: () => 200, json: () => new Promise(() => {
    })
  });
  const started = Date.now();
  await assert.rejects(f.executor.run({
    projectRoot: '/project', prompt: 'Work', sessionId: saved
  }), /post-submit.*deadline/);
  assert.ok(Date.now() - started < 250);
  assert.equal(f.sends(), 1);
  assert.equal(f.closed(), 1);
});
for (const failure of ['SSE parsing failed', 'net::ERR_CONNECTION_RESET', 'Target page crashed', 'ChatGPT response idle timeout'])
  test(`post-submit ${failure} reads the submitted turn without another send`, async () => {
    const f = fixture({
      streamError: failure
    });
    assert.equal((await f.executor.run({
      projectRoot: '/project', prompt: 'Work', sessionId: saved
    })).text, terminal);
    assert.equal(f.sends(), 1);
    assert.equal(f.reads(), 1);
  });
test('lost fresh stream persists created Project URL before exact-turn read', async () => {
  const f = fixture({
    fresh: true
  });
  let persisted: string | undefined;
  const output = await f.executor.run({
    projectRoot: '/project', prompt: 'Work', enforceProjectScope: true, onSession: id => {
      persisted = id;
    }
  });
  assert.equal(persisted, saved);
  assert.equal(output.sessionId, saved);
  assert.equal(f.reads(), 1);
  assert.equal(f.sends(), 1);
});
test('closed worker page reopens the same profile and conversation without sending', async (t) => {
  const f = fixture({
    pageGone: true
  });
  const reader = fixture({
    failStream: false
  });
  const readerContext = (reader.executor as unknown as {
    context: BrowserContext;
  }).context;
  let launches = 0;
  Object.assign(f.executor, {
    timeoutMs: 2000, config: {
      projectUrl: 'https://chatgpt.com/g/one/project', profileDir: process.cwd() + '/.devos/test-profile', headless: false
    }
  });
  t.mock.method(chatGptBrowserDeps, "loadIdentity", async () => ({
    schema: 1 as const,
    os: "macos" as const,
    preset: { userAgent: "stable-test-preset" },
  }));

  t.mock.method(chatGptBrowserDeps, "launchPersistentContext", async (profile: string, options: Parameters<typeof chatGptBrowserDeps.launchPersistentContext>[1]) => {
    launches++;
    assert.equal(profile, process.cwd() + '/.devos/test-profile');
    assert.equal(options?.headless, false);
    return Object.assign(readerContext, {
      async addInitScript() {
      }, on() {
      }
    });
  });
  assert.equal((await f.executor.run({
    projectRoot: '/project', prompt: 'Work', sessionId: saved
  })).text, terminal);
  assert.equal(launches, 1);
  assert.equal(f.sends(), 1);
  assert.equal(reader.sends(), 0);
  assert.equal(f.closed(), 1);
  assert.equal(reader.closed(), 0);
});
test('malformed read body is not echoed in diagnostics', async () => {
  const f = fixture();
  const context = (f.executor as unknown as {
    context: {
      pages(): Array<{
        waitForResponse: Function;
      }>;
    };
  }).context;
  context.pages()[0]!.waitForResponse = async () => ({
    status: () => 200, json: async () => {
      throw Error('account-secret-body');
    }
  });
  await assert.rejects(f.executor.run({
    projectRoot: '/project', prompt: 'Work', sessionId: saved
  }), error => error instanceof Error && error.message.includes('not structured JSON') && !error.message.includes('account-secret-body'));
  assert.equal(f.sends(), 1);
  assert.equal(f.closed(), 0);
});

test('a later unrelated assistant final cannot replace the captured user answer', async () => {
  const payload = data();
  const f = fixture({ payload: {
    ...payload,
    mapping: {
      ...payload.mapping,
      otherUser: { id: 'otherUser', parent: 'a', message: { id: 'otherUser', author: { role: 'user' } } },
      lastAssistant: { ...payload.mapping.a, id: 'lastAssistant', parent: 'otherUser', message: { ...payload.mapping.a.message, id: 'lastAssistant', content: { content_type: 'text', parts: ['Unrelated final'] } } },
    },
  } });
  assert.equal((await f.executor.run({ projectRoot: '/project', prompt: 'Work', sessionId: saved })).text, terminal);
  assert.equal(f.sends(), 1);
});

test('a final whose nearest user ancestor differs cannot settle the captured turn', async () => {
  const payload = data();
  const f = fixture({ payload: {
    ...payload,
    mapping: {
      ...payload.mapping,
      otherUser: { id: 'otherUser', parent: 'u', message: { id: 'otherUser', author: { role: 'user' } } },
      a: { ...payload.mapping.a, parent: 'otherUser' },
    },
  } });
  await assert.rejects(f.executor.run({ projectRoot: '/project', prompt: 'Work', sessionId: saved }), /post-submit.*still-running/);
  assert.equal(f.sends(), 1);
  assert.equal(f.closed(), 0);
});
