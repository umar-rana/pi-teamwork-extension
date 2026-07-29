import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import teamworkExtension from "../index.ts";

type AnyTool = ToolDefinition<any, any, any>;

function tools(): Record<string, AnyTool> {
  const registered: Record<string, AnyTool> = {};
  teamworkExtension({ registerTool: (tool: AnyTool) => { registered[tool.name] = tool; } } as unknown as ExtensionAPI);
  return registered;
}

/** Records what the confirmation dialog was actually shown, and what it answered. */
function context(options: { hasUI?: boolean; answer?: boolean } = {}) {
  const prompts: Array<{ title: string; message: string }> = [];
  const ctx = {
    hasUI: options.hasUI ?? true,
    cwd: process.cwd(),
    ui: {
      confirm: async (title: string, message: string) => {
        prompts.push({ title, message });
        return options.answer ?? false;
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, prompts };
}

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Replaces global fetch, because the tool boundary owns credential and site resolution. */
async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    calls++;
    return impl(...args);
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

const CONFIGURED = { TEAMWORK_SITE_NAME: "acme", TEAMWORK_OAUTH_TOKEN: "test-token", TEAMWORK_API_KEY: undefined };
const OK = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

test("every mutating method requires confirmation and no UI fails closed", async () => {
  const api = tools().teamwork_api;

  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    const declined = context({ answer: false });
    const { calls: declinedCalls } = await withFetch(OK, () => withEnv(CONFIGURED, () => assert.rejects(
      api.execute("call", { method, path: "/projects/api/v3/tasks/1.json", body: { name: "x" } }, undefined, undefined, declined.ctx),
      new RegExp(`Teamwork ${method} cancelled`),
    )));
    assert.equal(declinedCalls, 0, `${method} must not reach the network when declined`);
    assert.equal(declined.prompts.length, 1, `${method} must prompt exactly once`);

    const headless = context({ hasUI: false, answer: true });
    const { calls: headlessCalls } = await withFetch(OK, () => withEnv(CONFIGURED, () => assert.rejects(
      api.execute("call", { method, path: "/projects/api/v3/tasks/1.json" }, undefined, undefined, headless.ctx),
      new RegExp(`Teamwork ${method} cancelled`),
    )));
    assert.equal(headlessCalls, 0, `${method} must fail closed without UI`);
    assert.equal(headless.prompts.length, 0);

    const approved = context({ answer: true });
    const { calls: approvedCalls } = await withFetch(OK, () => withEnv(CONFIGURED, () =>
      api.execute("call", { method, path: "/projects/api/v3/tasks/1.json", body: {} }, undefined, undefined, approved.ctx)));
    assert.equal(approvedCalls, 1, `${method} must proceed once approved`);
    assert.equal(approved.prompts.length, 1);
  }
});

test("GET never prompts", async () => {
  const { ctx, prompts } = context({ answer: false });
  const { result, calls } = await withFetch(OK, () => withEnv(CONFIGURED, () =>
    tools().teamwork_api.execute("call", { method: "GET", path: "/projects/api/v3/me.json" }, undefined, undefined, ctx)));
  assert.equal(prompts.length, 0);
  assert.equal(calls, 1);
  assert.equal(result.details.status, 200);
});

test("approval is never remembered across invocations", async () => {
  const api = tools().teamwork_api;
  const { ctx, prompts } = context({ answer: true });
  await withFetch(OK, () => withEnv(CONFIGURED, async () => {
    for (let i = 0; i < 3; i++) {
      await api.execute("call", { method: "DELETE", path: "/projects/api/v3/tasks/1.json" }, undefined, undefined, ctx);
    }
  }));
  assert.equal(prompts.length, 3);
});

test("the prompt shows the confined URL and never the body or a raw hostile path", async () => {
  const api = tools().teamwork_api;
  const { ctx, prompts } = context({ answer: true });
  await withFetch(OK, () => withEnv(CONFIGURED, () =>
    api.execute("call", {
      method: "POST",
      path: "projects/api/v3/projects.json",
      query: { secretish: "q" },
      body: { name: "Secret Project", token: "twp_do_not_show" },
    }, undefined, undefined, ctx)));
  assert.deepEqual(prompts, [{
    title: "Send this Teamwork change?",
    message: "POST https://acme.teamwork.com/projects/api/v3/projects.json",
  }]);
  assert.doesNotMatch(prompts[0].message, /twp_do_not_show|Secret Project|test-token|secretish/);

  // A hostile path is rejected before any dialog can render its control characters.
  for (const hostile of ["/tasks\u0000\u001b[2Jspoofed.json", "https://evil.test/steal", "/x?a=1", "/../../secret"]) {
    const hostileCtx = context({ answer: true });
    const { calls } = await withFetch(OK, () => withEnv(CONFIGURED, () => assert.rejects(
      api.execute("call", { method: "DELETE", path: hostile }, undefined, undefined, hostileCtx.ctx))));
    assert.equal(hostileCtx.prompts.length, 0, `must not prompt for ${JSON.stringify(hostile)}`);
    assert.equal(calls, 0);
  }
});

test("a misconfigured site or credential is rejected before prompting", async () => {
  const api = tools().teamwork_api;
  for (const env of [
    { ...CONFIGURED, TEAMWORK_SITE_NAME: "acme.evil.test" },
    { ...CONFIGURED, TEAMWORK_SITE_NAME: undefined },
  ]) {
    const { ctx, prompts } = context({ answer: true });
    const { calls } = await withFetch(OK, () => withEnv(env, () => assert.rejects(
      api.execute("call", { method: "POST", path: "/projects/api/v3/projects.json" }, undefined, undefined, ctx))));
    assert.equal(prompts.length, 0);
    assert.equal(calls, 0);
  }

  // Missing credentials must fail after approval but before any request leaves.
  const { ctx, prompts } = context({ answer: true });
  const { calls } = await withFetch(OK, () => withEnv(
    { ...CONFIGURED, TEAMWORK_OAUTH_TOKEN: undefined },
    () => assert.rejects(
      api.execute("call", { method: "PUT", path: "/projects/api/v3/tasks/1.json" }, undefined, undefined, ctx),
      /auth not configured/,
    ),
  ));
  assert.equal(prompts.length, 1);
  assert.equal(calls, 0);
});
