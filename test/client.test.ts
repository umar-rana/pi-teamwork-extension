import test from "node:test";
import assert from "node:assert/strict";
import {
  SPEC_URLS,
  TeamworkApiError,
  authHeader,
  buildUrl,
  extractOperations,
  loadOpenApiSpecs,
  normalizeApiPath,
  operationDetail,
  requestTeamwork,
  searchOperations,
  siteBaseUrl,
  type Fetcher,
} from "../client.ts";

const SITE = "acme";
const AUTH = "Bearer test-token";
const ORIGIN = "https://acme.teamwork.com";
const json = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });
const noFetch: Fetcher = async () => {
  throw new Error("network must not be reached");
};

test("rejects hostile site labels and confines the origin", () => {
  assert.equal(siteBaseUrl(" ACME \n".replace("\n", "")).origin, ORIGIN);
  for (const hostile of [
    "", "  ", "acme.evil.test", "https://acme.teamwork.com", "acme:8443", "acme/../evil", "acme@evil",
    "-acme", "acme-", "acme_1", "ac me", "acmé", "acme%2eevil", "a".repeat(64), "evil.com#",
    // Trim-stripped characters must not smuggle a label past the allowlist.
    "acme\n", "acme\r\n", "acme\t", "acme\u0085", "acme\u00a0", "acme\ufeff", "acme\u2028",
  ]) {
    assert.throws(() => siteBaseUrl(hostile), `expected rejection of ${JSON.stringify(hostile)}`);
  }
});

test("rejects unsafe paths and serializes query arrays", () => {
  assert.equal(normalizeApiPath("projects/api/v3/projects.json"), "/projects/api/v3/projects.json");
  for (const hostile of [
    "https://evil.test/x", "http://evil.test/x", "//evil.test/x", "javascript:alert(1)",
    "/x?a=1", "/x#frag", "/x\\..\\y", "/projects/../../secret", "/%2e%2e/secret",
    "/foo%2f..%2fsecret", "/x%5cy", "/bad\u0000path", "/bad\npath",
    // Control characters must be rejected, not trimmed away into a "clean" path.
    "/x.json\r\nX-Injected: 1", "/x.json\n", "\r\n/x.json", "/x.json\t", " \u001b[2J/x.json",
    // String.trim() also strips these, so a trim-then-check order would accept them.
    "/x.json\u0085", "/x.json\u2028", "/x.json\u2029", "/x.json\u00a0", "/x.json\ufeff",
    "\ufeff//evil.test/x", "\u0085/x.json", "/x\u202ejson", "/a b.json",
  ]) {
    assert.throws(() => normalizeApiPath(hostile), `expected rejection of ${JSON.stringify(hostile)}`);
  }
  // Only plain ASCII spaces are trimmed, and the result never carries a forbidden character.
  assert.equal(normalizeApiPath("  /x.json  "), "/x.json");
  assert.doesNotMatch(normalizeApiPath("  /x.json  "), /[\p{C}\p{Z}]/u);
  assert.equal(
    buildUrl("/projects/api/v3/tasks.json", { "ids[]": [1, 2], includeArchived: false, empty: null }, SITE).toString(),
    `${ORIGIN}/projects/api/v3/tasks.json?ids%5B%5D=1&ids%5B%5D=2&includeArchived=false&empty=`,
  );
});

test("raw-value validation diverges from a raw-first order only for ASCII space padding", () => {
  // Sweeps every control, format, and separator code point through U+2100 (C0, C1, all Z).
  // A raw-first order rejects all of them; the only intended exemption is plain-space padding.
  const forbidden = /[\p{C}\p{Z}]/u;
  const accepted: string[] = [];
  for (let cp = 0; cp <= 0x2100; cp++) {
    const char = String.fromCodePoint(cp);
    if (!forbidden.test(char)) continue;
    for (const input of [`/safe${char}`, `${char}/safe`, `/sa${char}fe`]) {
      try {
        normalizeApiPath(input);
        accepted.push(`path U+${cp.toString(16).padStart(4, "0")} ${JSON.stringify(input)}`);
      } catch {
        // Rejection is the expected outcome for every forbidden character.
      }
    }
    try {
      authHeader({ TEAMWORK_OAUTH_TOKEN: `secret${char}` });
      accepted.push(`credential U+${cp.toString(16).padStart(4, "0")}`);
    } catch {
      // Rejection is the expected outcome here too.
    }
  }
  assert.deepEqual(accepted, ['path U+0020 "/safe "', 'path U+0020 " /safe"', "credential U+0020"]);
});

test("validates the path before any network or auth use", async () => {
  await assert.rejects(requestTeamwork({ method: "GET", path: "https://evil.test/steal" }, { site: SITE, auth: AUTH, fetchImpl: noFetch }));
  await assert.rejects(requestTeamwork({ method: "GET", path: "/x" }, { site: "evil.test", auth: AUTH, fetchImpl: noFetch }));
});

test("selects auth deterministically and never leaks secrets", async () => {
  assert.equal(authHeader({ TEAMWORK_API_KEY: "twp_key" }), `Basic ${Buffer.from("twp_key:X", "utf8").toString("base64")}`);
  assert.equal(authHeader({ TEAMWORK_OAUTH_TOKEN: "tok" }), "Bearer tok");
  assert.equal(authHeader({ TEAMWORK_OAUTH_TOKEN: "tok", TEAMWORK_API_KEY: "twp_key" }), "Bearer tok");
  assert.throws(() => authHeader({}));
  assert.throws(() => authHeader({ TEAMWORK_OAUTH_TOKEN: "   " }));
  // A line break must be rejected even when trimming alone would have removed it,
  // and even when the other variable would otherwise satisfy the request.
  for (const env of [
    { TEAMWORK_API_KEY: "bad\r\nX-Injected: 1" },
    { TEAMWORK_OAUTH_TOKEN: "tok\r\nX-Injected: 1" },
    { TEAMWORK_API_KEY: "twp_key\n" },
    { TEAMWORK_OAUTH_TOKEN: "tok\r" },
    { TEAMWORK_OAUTH_TOKEN: "tok", TEAMWORK_API_KEY: "twp_key\nX-Injected: 1" },
    // Trim-stripped characters must fail too, not be cleaned into an accepted credential.
    { TEAMWORK_OAUTH_TOKEN: "tok\u0085" },
    { TEAMWORK_API_KEY: "twp_key\u2028" },
    { TEAMWORK_OAUTH_TOKEN: "tok\ufeff" },
    { TEAMWORK_API_KEY: "twp\u00a0key" },
    { TEAMWORK_OAUTH_TOKEN: "tok tok" },
  ]) {
    assert.throws(() => authHeader(env), `expected rejection of ${JSON.stringify(env)}`);
  }
  // The credential after the scheme can therefore never carry a control or whitespace character.
  for (const env of [{ TEAMWORK_OAUTH_TOKEN: " tok " }, { TEAMWORK_API_KEY: " twp_key " }]) {
    const [scheme, credential, ...rest] = authHeader(env).split(" ");
    assert.ok(["Bearer", "Basic"].includes(scheme));
    assert.deepEqual(rest, []);
    assert.doesNotMatch(credential, /[\p{C}\p{Z}]/u);
  }

  let seen: Headers | undefined;
  const fetchImpl: Fetcher = async (_url, init) => {
    seen = new Headers(init?.headers);
    return json('{"denied":true}', 401);
  };
  const error = await requestTeamwork({ method: "GET", path: "/projects/api/v3/me.json" }, { site: SITE, auth: "Basic c2VjcmV0Olg=", fetchImpl })
    .then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof TeamworkApiError && error.status === 401);
  assert.equal(seen?.get("authorization"), "Basic c2VjcmV0Olg=");
  assert.doesNotMatch(`${(error as Error).message}${(error as TeamworkApiError).response}`, /c2VjcmV0|secret/);
});

test("sends authenticated JSON with manual redirects and rejects 3xx", async () => {
  let init: RequestInit | undefined;
  let url: string | URL | undefined;
  const fetchImpl: Fetcher = async (target, options) => {
    url = target;
    init = options;
    return json('{"id":7}');
  };
  const result = await requestTeamwork({ method: "POST", path: "/projects/api/v3/projects.json", body: { name: "P" } }, { site: SITE, auth: AUTH, fetchImpl });
  assert.equal(String(url), `${ORIGIN}/projects/api/v3/projects.json`);
  assert.equal(init?.redirect, "manual");
  assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
  assert.equal(init?.body, '{"name":"P"}');
  assert.deepEqual(result.data, { id: 7 });

  const redirect: Fetcher = async () => new Response("", { status: 302, headers: { location: "https://evil.test/" } });
  await assert.rejects(
    requestTeamwork({ method: "GET", path: "/projects/api/v3/me.json" }, { site: SITE, auth: AUTH, fetchImpl: redirect }),
    (caught: unknown) => caught instanceof TeamworkApiError && caught.status === 302,
  );
});

test("retries 429 for any method but replays no mutation after 5xx", async () => {
  for (const method of ["GET", "POST"] as const) {
    let calls = 0;
    const delays: number[] = [];
    await requestTeamwork({ method, path: "/projects/api/v3/me.json" }, {
      site: SITE,
      auth: AUTH,
      fetchImpl: async () => (++calls === 1 ? new Response("slow", { status: 429, headers: { "retry-after": "0" } }) : json("{}")),
      sleepImpl: async ms => { delays.push(ms); },
    });
    assert.equal(calls, 2, `${method} should retry an explicit 429`);
    assert.deepEqual(delays, [0]);
  }

  let getCalls = 0;
  const getDelays: number[] = [];
  await requestTeamwork({ method: "GET", path: "/projects/api/v3/me.json" }, {
    site: SITE,
    auth: AUTH,
    fetchImpl: async () => (++getCalls < 3 ? new Response("down", { status: 503 }) : json("{}")),
    sleepImpl: async ms => { getDelays.push(ms); },
  });
  assert.equal(getCalls, 3);
  assert.deepEqual(getDelays, [500, 1_000]);

  for (const status of [502, 503, 504]) {
    let mutationCalls = 0;
    await assert.rejects(
      requestTeamwork({ method: "PATCH", path: "/projects/api/v3/tasks/1.json", body: {} }, {
        site: SITE,
        auth: AUTH,
        fetchImpl: async () => {
          mutationCalls++;
          return new Response("down", { status });
        },
      }),
      (caught: unknown) => caught instanceof TeamworkApiError && caught.status === status,
    );
    assert.equal(mutationCalls, 1, `a ${status} mutation must not be replayed`);
  }

  let networkCalls = 0;
  await assert.rejects(requestTeamwork({ method: "DELETE", path: "/projects/api/v3/tasks/1.json" }, {
    site: SITE,
    auth: AUTH,
    fetchImpl: async () => {
      networkCalls++;
      throw new Error("socket hang up");
    },
  }));
  assert.equal(networkCalls, 1);
});

test("cancellation stops the retry wait", async () => {
  const controller = new AbortController();
  await assert.rejects(requestTeamwork({ method: "GET", path: "/projects/api/v3/me.json" }, {
    site: SITE,
    auth: AUTH,
    signal: controller.signal,
    fetchImpl: async () => new Response("slow", { status: 429, headers: { "retry-after": "30" } }),
    sleepImpl: async (_ms, signal) => {
      controller.abort(new Error("cancelled"));
      if (signal?.aborted) throw signal.reason;
    },
  }), /cancelled/);
});

test("requires every spec source and a paths mapping", async () => {
  const requested: string[] = [];
  const ok: Fetcher = async input => {
    requested.push(String(input));
    return new Response("paths:\n  /a.json:\n    get: {}\n");
  };
  const specs = await loadOpenApiSpecs(ok);
  assert.deepEqual(new Set(requested), new Set(Object.values(SPEC_URLS)));
  assert.deepEqual(Object.keys(specs).sort(), ["object", "v1", "v2", "v3"]);

  await assert.rejects(loadOpenApiSpecs(async input =>
    String(input) === SPEC_URLS.v3 ? new Response("nope", { status: 500 }) : new Response("paths: {}")), /v3/);

  // `paths` must be a mapping; null and sequences would otherwise publish an empty catalog.
  for (const malformed of ["just a string", "- a\n- b", "paths:\n", "paths: []", "paths: 3", "paths: text", ""]) {
    await assert.rejects(
      loadOpenApiSpecs(async () => new Response(malformed)),
      /valid OpenAPI/,
      `expected rejection of ${JSON.stringify(malformed)}`,
    );
    await assert.rejects(
      loadOpenApiSpecs(async input => new Response(String(input) === SPEC_URLS.v1 ? malformed : "paths: {}")),
      /valid OpenAPI/,
      `expected one malformed source to fail the whole load: ${JSON.stringify(malformed)}`,
    );
  }
});

test("dedupes the union, prefers versioned specs, and resolves local refs only", () => {
  const shared = {
    paths: {
      "/projects.json": { get: { operationId: "v3Projects", summary: "v3 list", tags: ["Projects"], responses: { "200": {} } } },
    },
  };
  const operations = extractOperations({
    v1: {
      paths: {
        "/tasks.json/": {
          post: {
            operationId: "v1CreateTask",
            "x-private": true,
            parameters: [{ in: "body", name: "body", schema: { $ref: "#/definitions/Task" } }],
            responses: { "201": {} },
          },
        },
      },
      definitions: { Task: { type: "object", properties: { name: { type: "string" } } } },
    },
    v3: shared,
    object: {
      paths: {
        "/projects.json": { get: { operationId: "objectProjects", summary: "object list", responses: { "200": {} } } },
        "/objects-only.json": { get: { operationId: "objectOnly", summary: "only here", responses: { "200": {} } } },
        "/tasks.json": { post: { operationId: "objectCreateTask", responses: { "201": {} } } },
      },
    },
  });

  assert.deepEqual(operations.map(operation => operation.id).sort(), ["objectOnly", "v1CreateTask", "v3Projects"]);
  assert.equal(operations.find(operation => operation.path === "/projects.json")?.source, "v3");
  assert.equal(searchOperations(operations, "projects")[0].id, "v3Projects");
  assert.equal(searchOperations(operations, "objectOnly", "v1").length, 0);

  const detail = operationDetail(searchOperations(operations, "v1CreateTask")[0]);
  assert.equal(detail.private, true);
  assert.deepEqual((detail.request_body as Record<string, unknown>).schema, { type: "object", properties: { name: { type: "string" } } });
});

test("never dereferences an external ref", () => {
  const operations = extractOperations({
    v3: {
      paths: {
        "/x.json": {
          get: { operationId: "external", parameters: [{ $ref: "https://evil.test/schema.json#/Steal" }], responses: { "200": {} } },
        },
      },
    },
  });
  assert.deepEqual(operationDetail(operations[0]).parameters, [{ $ref: "https://evil.test/schema.json#/Steal", external: true }]);
});

// Opt-in, read-only. The ADR snapshot was 88/354/9/407 → 783 union, but the versioned
// assets are live and grow, so assert those as floors plus the dedup invariant.
test("live specs cover the documented catalog", { skip: !process.env.TEAMWORK_LIVE_SPEC_TEST }, async () => {
  const specs = await loadOpenApiSpecs();
  const baseline = { object: 88, v1: 354, v2: 9, v3: 407 } as const;
  let total = 0;
  for (const [source, floor] of Object.entries(baseline)) {
    const count = extractOperations({ [source]: specs[source as keyof typeof baseline] }).length;
    assert.ok(count >= floor, `${source} has ${count} operations, below the documented ${floor}`);
    total += count;
  }

  const union = extractOperations(specs);
  assert.ok(union.length >= 783, `union has ${union.length} operations, below the documented 783`);
  assert.ok(union.length < total, "the union must deduplicate overlapping method/path pairs");
  // The curated object reference contributes exactly the operations the versioned specs lack.
  assert.equal(union.filter(operation => operation.source === "object").length, 13);
});
