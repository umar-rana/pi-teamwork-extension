import { parse as parseYaml } from "yaml";

export const SPEC_URLS = {
  object: "https://assets.contento.io/assets/s_01hHCKV8wW0z3wF9dTn8qCEKhq/teamwork.com-api-object-reference.oas-edit18.yml",
  v1: "https://contento-assets.s3.eu-west-1.amazonaws.com/oas/teamwork_docs/projects/reference/projects-api-v1.oas2.yml",
  v2: "https://contento-assets.s3.eu-west-1.amazonaws.com/oas/teamwork_docs/projects/reference/projects-api-v2.oas2.yml",
  v3: "https://contento-assets.s3.eu-west-1.amazonaws.com/oas/teamwork_docs/projects/reference/projects-api-v3.oas2.yml",
} as const;

/** Versioned specs win identity collisions; the curated object reference only adds what they lack. */
export const SPEC_ORDER = ["v1", "v2", "v3", "object"] as const;

const SITE_NAME = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SPEC_TIMEOUT_MS = 30_000;
const SPEC_MAX_BYTES = 10 * 1024 * 1024;
const ERROR_EXCERPT_BYTES = 8_000;

export type SpecSource = keyof typeof SPEC_URLS;
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean | null | Array<string | number | boolean>;
export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const MUTATING_METHODS: readonly HttpMethod[] = ["POST", "PUT", "PATCH", "DELETE"];

export interface ApiRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  timeout_ms?: number;
}

export interface ApiResult {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

export interface RequestOptions {
  auth?: string;
  site?: string;
  signal?: AbortSignal;
  fetchImpl?: Fetcher;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface OpenApiOperation {
  source: SpecSource;
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: unknown[];
  requestBody?: unknown;
  responseCodes: string[];
  private: boolean;
  raw: Record<string, unknown>;
  spec: Record<string, unknown>;
}

export class TeamworkApiError extends Error {
  readonly status: number;
  readonly response: string;

  constructor(status: number, message: string, response: string) {
    super(message);
    this.name = "TeamworkApiError";
    this.status = status;
    this.response = response;
  }
}

/** Builds the only origin this extension may talk to. The site name is a label, never a URL. */
export function siteBaseUrl(input = process.env.TEAMWORK_SITE_NAME): URL {
  const site = (input ?? "").trim().toLowerCase();
  if (!site) throw new Error("Teamwork site not configured. Set TEAMWORK_SITE_NAME to your site name, for example `acme`.");
  if (!SITE_NAME.test(site)) throw new Error("TEAMWORK_SITE_NAME must be a bare site label such as `acme`, not a URL, host, or path.");

  const url = new URL(`https://${site}.teamwork.com/`);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname !== `${site}.teamwork.com`) {
    throw new Error("Refusing to build a Teamwork base URL outside https://<site>.teamwork.com.");
  }
  return url;
}

export function normalizeApiPath(input: string): string {
  // Check the raw value first: trimming would silently strip a trailing CR/LF instead of rejecting it.
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new Error("Control characters are not allowed in an API path.");
  const path = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) throw new Error("Use a Teamwork API path, not a full URL.");
  if (path.startsWith("//")) throw new Error("Use a Teamwork API path, not a protocol-relative URL.");
  if (path.includes("?")) throw new Error("Put query parameters in the query object.");
  if (path.includes("#")) throw new Error("Fragments are not allowed in an API path.");
  if (path.includes("\\")) throw new Error("Backslashes are not allowed in an API path.");
  if (/%(?:2e|2f|5c)/i.test(path)) throw new Error("Encoded path traversal characters are not allowed.");
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (normalized.split("/").includes("..")) throw new Error("Path traversal segments are not allowed.");
  return normalized;
}

export function buildUrl(path: string, query: Record<string, QueryValue> = {}, site?: string): URL {
  const base = siteBaseUrl(site);
  const url = new URL(normalizeApiPath(path), base);
  if (url.origin !== base.origin || url.protocol !== "https:") {
    throw new Error(`Resolved path must remain under ${base.origin}.`);
  }
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item === null ? "" : String(item));
  }
  return url;
}

/** OAuth wins deterministically; the API key is the Basic username with a placeholder password. */
export function authHeader(env: NodeJS.ProcessEnv = process.env): string {
  // Reject line breaks in the raw values: trimming first would hide header injection
  // attempts behind a silently "cleaned" credential.
  for (const name of ["TEAMWORK_OAUTH_TOKEN", "TEAMWORK_API_KEY"] as const) {
    if (/[\r\n]/.test(env[name] ?? "")) throw new Error(`${name} contains an illegal line break.`);
  }
  const token = env.TEAMWORK_OAUTH_TOKEN?.trim();
  const key = env.TEAMWORK_API_KEY?.trim();
  const secret = token || key;
  if (!secret) throw new Error("Teamwork auth not configured. Set TEAMWORK_OAUTH_TOKEN or TEAMWORK_API_KEY.");
  return token ? `Bearer ${token}` : `Basic ${Buffer.from(`${key}:X`, "utf8").toString("base64")}`;
}

export async function requestTeamwork(input: ApiRequest, options: RequestOptions = {}): Promise<ApiResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const url = buildUrl(input.path, input.query, options.site);
  const auth = options.auth ?? authHeader();
  const mutating = MUTATING_METHODS.includes(input.method);
  const attempts = 3;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const headers = new Headers({ Accept: "application/json", Authorization: auth });
    let body: string | undefined;
    if (input.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(input.body);
    }
    const timeout = AbortSignal.timeout(input.timeout_ms ?? 30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await fetchImpl(url, { method: input.method, headers, body, signal, redirect: "manual" });

    if (response.status >= 300 && response.status < 400) {
      throw new TeamworkApiError(response.status, `Teamwork API returned redirect ${response.status}; redirects are not followed.`, "");
    }

    const text = await response.text();
    const last = attempt === attempts - 1;

    // A 429 was explicitly refused, so replaying it cannot duplicate a mutation.
    if (!last && response.status === 429) {
      await sleepImpl(rateLimitDelay(response.headers, attempt), options.signal);
      continue;
    }
    // A mutating 5xx may already have been applied; never replay it.
    if (!last && !mutating && [502, 503, 504].includes(response.status)) {
      await sleepImpl(500 * 2 ** attempt, options.signal);
      continue;
    }

    if (!response.ok) {
      const excerpt = text.length > ERROR_EXCERPT_BYTES ? `${text.slice(0, ERROR_EXCERPT_BYTES)}…` : text;
      throw new TeamworkApiError(response.status, `Teamwork API ${response.status} ${response.statusText}`, excerpt);
    }

    return {
      status: response.status,
      data: parseResponse(text, response.headers.get("content-type")),
      headers: Object.fromEntries(response.headers.entries()),
    };
  }

  throw new Error("Teamwork request failed after retries.");
}

function parseResponse(text: string, contentType: string | null): unknown {
  if (!text) return null;
  if (contentType?.includes("json")) return JSON.parse(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function rateLimitDelay(headers: Headers, attempt: number): number {
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.min(60_000, Math.max(100, reset * 1_000 - Date.now() + 100));
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(60_000, retryAfter * 1_000);
  return 1_000 * 2 ** attempt;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/** All-or-nothing: a partial catalog would silently hide documented operations. */
export async function loadOpenApiSpecs(
  fetchImpl: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<Record<SpecSource, Record<string, unknown>>> {
  const entries = await Promise.all(SPEC_ORDER.map(async source => [source, await loadSpec(source, fetchImpl, signal)] as const));
  return Object.fromEntries(entries) as Record<SpecSource, Record<string, unknown>>;
}

async function loadSpec(source: SpecSource, fetchImpl: Fetcher, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(SPEC_TIMEOUT_MS);
  const response = await fetchImpl(SPEC_URLS[source], {
    headers: { Accept: "application/yaml, application/json, text/yaml, */*" },
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`Could not load the Teamwork ${source} specification (${response.status}).`);

  // YAML also parses the JSON bodies some of these .yml URLs return; those contain
  // duplicate keys, which JSON allows (last wins) but strict YAML rejects.
  const spec = parseYaml(await readLimited(response, SPEC_MAX_BYTES, source), { uniqueKeys: false }) as unknown;
  if (!isMapping(spec) || !isMapping(spec.paths)) {
    throw new Error(`The Teamwork ${source} specification is not a valid OpenAPI document.`);
  }
  return spec;
}

/** A YAML mapping only: `null` and sequences are both `typeof "object"` but cannot carry `paths`. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readLimited(response: Response, limit: number, source: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`The Teamwork ${source} specification exceeds the ${limit}-byte limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function extractOperations(specs: Partial<Record<SpecSource, Record<string, unknown>>>): OpenApiOperation[] {
  const operations = new Map<string, OpenApiOperation>();
  for (const source of SPEC_ORDER) {
    const spec = specs[source];
    if (!spec) continue;
    const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
    for (const [path, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== "object") continue;
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const raw = pathItem[method] as Record<string, unknown> | undefined;
        if (!raw || typeof raw !== "object") continue;
        const upper = method.toUpperCase() as HttpMethod;
        const key = `${upper} ${path.replace(/\/+$/, "") || "/"}`;
        if (operations.has(key)) continue;
        const parameters = [
          ...((pathItem.parameters as unknown[] | undefined) ?? []),
          ...((raw.parameters as unknown[] | undefined) ?? []),
        ];
        operations.set(key, {
          source,
          id: String(raw.operationId ?? `${source}:${method}-${path}`),
          method: upper,
          path,
          summary: String(raw.summary ?? ""),
          description: String(raw.description ?? ""),
          tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
          parameters,
          // OAS2 carries the body as an `in: body` parameter; OAS3 uses requestBody.
          requestBody: raw.requestBody ?? parameters.find(item => (item as Record<string, unknown> | null)?.in === "body"),
          responseCodes: Object.keys((raw.responses as Record<string, unknown> | undefined) ?? {}),
          private: Boolean(raw["x-private"]),
          raw,
          spec,
        });
      }
    }
  }
  return [...operations.values()];
}

export function searchOperations(operations: OpenApiOperation[], query: string, source: SpecSource | "all" = "all"): OpenApiOperation[] {
  const needle = query.trim().toLowerCase();
  return operations
    .filter(operation => source === "all" || operation.source === source)
    .map(operation => ({ operation, score: operationScore(operation, needle) }))
    .filter(match => !needle || match.score > 0)
    .sort((a, b) => b.score - a.score || a.operation.id.localeCompare(b.operation.id))
    .map(match => match.operation);
}

export function operationDetail(operation: OpenApiOperation): Record<string, unknown> {
  return {
    source: operation.source,
    operation_id: operation.id,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    description: operation.description,
    tags: operation.tags,
    private: operation.private,
    parameters: resolveLocalRefs(operation.parameters, operation.spec),
    request_body: resolveLocalRefs(operation.requestBody, operation.spec),
    response_codes: operation.responseCodes,
  };
}

function operationScore(operation: OpenApiOperation, needle: string): number {
  if (!needle) return 1;
  const id = operation.id.toLowerCase();
  const path = operation.path.toLowerCase();
  if (id === needle) return 1_000;
  if (path === needle) return 900;
  let score = id.includes(needle) ? 100 : 0;
  if (path.includes(needle)) score += 80;
  if (operation.summary.toLowerCase().includes(needle)) score += 60;
  if (operation.tags.some(tag => tag.toLowerCase().includes(needle))) score += 40;
  if (`${operation.method} ${operation.path}`.toLowerCase().includes(needle)) score += 20;
  if (operation.description.toLowerCase().includes(needle)) score += 10;
  return score;
}

/** Local `#/...` pointers only; a spec must never make the extension fetch a remote ref. */
function resolveLocalRefs(value: unknown, spec: Record<string, unknown>, depth = 0, seen = new Set<string>()): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => resolveLocalRefs(item, spec, depth + 1, new Set(seen)));

  const object = value as Record<string, unknown>;
  if (typeof object.$ref === "string") {
    if (!object.$ref.startsWith("#/")) return { $ref: object.$ref, external: true };
    if (seen.has(object.$ref)) return { $ref: object.$ref, circular: true };
    const target = object.$ref.slice(2).split("/").reduce<unknown>((current, key) =>
      current && typeof current === "object" ? (current as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined,
    spec);
    if (target === undefined) return object;
    return resolveLocalRefs(target, spec, depth + 1, new Set(seen).add(object.$ref));
  }

  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, resolveLocalRefs(item, spec, depth + 1, new Set(seen))]));
}
