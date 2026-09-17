import { describe, expect, it } from "vitest";
import { emptyFacts, extractFacts } from "../src/index/facts.ts";
import type { FileFacts, ImportFact } from "../src/index/facts.ts";
import { DESCRIPTOR, estimateTokens, fillDescriptor, identWords, optionBudget, signatureOf } from "../src/index/signature.ts";
import type { Signature } from "../src/index/signature.ts";

const imp = (spec: string, names: string[] = [], more: Partial<ImportFact> = {}): ImportFact => ({ spec, names, how: "import", typeOnly: false, line: 1, ...more });
const facts = (more: Partial<FileFacts>): FileFacts => ({ ...emptyFacts(), ...more });

/** idf-like: what the lexical index will supply. Unknown words are middling. */
const RARE: Record<string, number> = { cimd: 7, jwt: 6.2, bearer: 5.9, svix: 7.5, mcp: 4.2, admin: 2.7, better: 2, auth: 1.5, plugins: 3, api: 1.2, error: 1, get: 0.5, create: 0.5, webhook: 3 };
const rarity = (w: string) => RARE[w] ?? 3.5;

/** Mirrors packages/db/src/auth-horse.ts: the file "where do we mint jwts" has to find. */
const AUTH_HORSE = [
  "// horse-api's better-auth instance (horse.dev) — the same auth behaviour as",
  "// law-api's (auth-base.ts) plus the OAuth 2.1 authorization server the admin",
  "// MCP server needs: jwt() signs the access tokens, mcp() is the authorization",
  "// server configured for the MCP profile, cimd() lets clients identify themselves",
  "// with a Client ID Metadata Document instead of dynamic registration.",
  "//",
  "// Only horse-api mounts this. Issuer, resource and page URLs come from horse-urls.ts.",
  "",
  "import { betterAuth } from 'better-auth';",
  "import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';",
  "import { admin, bearer, jwt } from 'better-auth/plugins';",
  "import { mcp } from '@better-auth/mcp';",
  "import { cimd } from '@better-auth/cimd';",
  "import { fetchClientMetadataResource } from '@better-auth/cimd/node';",
  "",
  "import { baseAuthOptions } from './auth-base';",
  "import { horseApiOrigin, horseAppOrigin, horseMcpResource } from './horse-urls';",
  "import { assertMcpOAuthGrant, MCP_GRANT_CLAIM, MCP_OAUTH_SCOPES } from './mcp-oauth-policy';",
  "",
  "export type { AuthSession, AuthUser } from './auth-base';",
  "",
  "const HORSE_MCP_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;",
  "const HORSE_OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access', ...MCP_OAUTH_SCOPES] as const;",
  "",
  "export function horseMcpAllowsDcr(env: NodeJS.ProcessEnv = process.env): boolean {",
  "  return env.HORSE_MCP_ALLOW_DCR === '1';",
  "}",
  "export function consentRequestedScopes(body: { scope?: unknown } | undefined): string[] {",
  "  return String(body?.scope ?? new URLSearchParams('').get('scope')).split(' ').filter(Boolean);",
  "}",
  "export function consentClientId(body: { oauth_query?: unknown } | undefined): string | null {",
  "  return typeof body?.oauth_query === 'string' ? new URLSearchParams(body.oauth_query).get('client_id') : null;",
  "}",
  "",
  "const base = baseAuthOptions({ appOrigin: horseAppOrigin(), apiOrigin: horseApiOrigin() });",
  "export const horseAuth = betterAuth({",
  "  ...base,",
  "  hooks: {",
  "    before: createAuthMiddleware(async (ctx) => {",
  "      const session = await getSessionFromCtx(ctx);",
  "      if (!session) throw new APIError('UNAUTHORIZED', { error: 'login_required' });",
  "      await assertMcpOAuthGrant(session.user.id, consentClientId(ctx.body), consentRequestedScopes(ctx.body));",
  "    }),",
  "  },",
  "  plugins: [",
  "    admin(),",
  "    bearer(),",
  "    jwt({ jwt: { audience: horseMcpResource(), expirationTime: HORSE_MCP_ACCESS_TOKEN_TTL_SECONDS } }),",
  "    mcp({ loginPage: '/sign-in', consentPage: '/oauth2/consent', scopes: [...HORSE_OAUTH_SCOPES], allowDcr: horseMcpAllowsDcr() }),",
  "    cimd({ fetch: fetchClientMetadataResource, claim: MCP_GRANT_CLAIM }),",
  "  ],",
  "});",
].join("\n");
const BASE = { kind: "file", ext: "ts", lines: 140 };

describe("identWords", () => {
  const cases: Array<[string, string[]]> = [
    ["getSessionFromCtx", ["get", "session", "from", "ctx"]],
    ["HTTPServer2xx", ["http", "server2xx"]],
    ["@better-auth/cimd/node", ["better", "auth", "cimd", "node"]],
    ["HORSE_MCP_ALLOW_DCR", ["horse", "mcp", "allow", "dcr"]],
    ["customer.subscription.updated", ["customer", "subscription", "updated"]],
    ["v2.x-1", ["v2"]],
  ];
  it.each(cases)("%s", (ident, words) => {
    expect(identWords(ident)).toEqual(words);
  });
});

describe("signatureOf", () => {
  it("groups imports by package, turns relative and aliased ones into basenames, and drops names that name nothing", () => {
    const sig = signatureOf(
      facts({
        imports: [
          imp("stripe", ["default"], { typeOnly: true }),
          imp("better-auth/plugins", ["admin", "jwt"]),
          imp("better-auth/plugins", ["jwt", "bearer"], { typeOnly: true }),
          imp("node:fs", ["*"]),
          imp("./auth-base", ["baseAuthOptions"]),
          imp("../lib/foo/index.ts", ["x"]),
          imp("@/components/ui/button.tsx", ["Button"]),
          imp("~/server/db", ["db"]),
          imp("./auth-base", ["AuthUser"], { how: "reexport" }),
          imp(".models.user", ["User"]),
          imp(".", ["sibling"]),
          imp("./index", ["y"]),
          imp("@scope/pkg/sub", [], { how: "dynamic" }),
        ],
      }),
    );
    expect(sig.imports).toEqual({ stripe: [], "better-auth/plugins": ["admin", "jwt", "bearer"], "node:fs": [], "@scope/pkg/sub": [] });
    expect(sig.local).toEqual(["auth-base", "foo", "button", "db", "user"]);
  });

  it("splits declarations into exports and the rest; re-exports are exports under the name this file gives them", () => {
    const sig = signatureOf(
      facts({
        decls: [
          { name: "helper", kind: "function", exported: false, line: 2 },
          { name: "horseAuth", kind: "const", exported: true, line: 9 },
          { name: "default", kind: "default", exported: true, line: 12 },
        ],
        imports: [imp("./auth-base", ["AuthSession", "a"], { how: "reexport", as: ["AuthSession", "b"], line: 5 }), imp("./all", ["*"], { how: "reexport", line: 6 }), imp("./api", ["*"], { how: "reexport", as: ["api"], line: 7 })],
        calls: ["helper", "betterAuth"],
      }),
    );
    expect(sig.exports).toEqual(["AuthSession", "b", "api", "horseAuth"]);
    expect(sig.decls).toEqual(["helper"]);
    expect(sig.calls).toEqual(["betterAuth"]); // its own function is listed once already
  });

  it("omits empty fields", () => {
    expect(signatureOf(emptyFacts())).toEqual({});
    expect(signatureOf(facts({ headings: ["T"] }))).toEqual({ headings: ["T"] });
  });

  it("keeps source order without a rarity function", () => {
    const sig = signatureOf(facts({ calls: ["fetch", "jwt", "createThing"], strings: ["a-b", "svix-id"], keys: ["name", "scripts.build"], imports: [imp("express", ["Router"]), imp("svix", ["Webhook"])] }));
    expect(sig).toEqual({ calls: ["fetch", "jwt", "createThing"], strings: ["a-b", "svix-id"], keys: ["name", "scripts.build"], imports: { express: ["Router"], svix: ["Webhook"] } });
  });

  it("with one, leads with the identifier whose rarest word is rarest; ties keep source order", () => {
    const sig = signatureOf(
      facts({
        calls: ["getThing", "createAuth", "jwt", "otherThing", "verifyJwtShape"],
        strings: ["x-api-key", "svix-id"],
        keys: ["name", "dependencies.svix", "scripts.build"],
        decls: [{ name: "plain", kind: "const", exported: false, line: 1 }, { name: "cimdCache", kind: "const", exported: false, line: 2 }],
        headings: ["Zeta", "cimd"],
        tables: ["users", "jwt_keys"],
      }),
      rarity,
    );
    expect(sig.calls).toEqual(["jwt", "verifyJwtShape", "getThing", "otherThing", "createAuth"]);
    expect(sig.strings).toEqual(["svix-id", "x-api-key"]);
    expect(sig.keys).toEqual(["dependencies.svix", "name", "scripts.build"]);
    expect(sig.decls).toEqual(["cimdCache", "plain"]);
    expect(sig.headings).toEqual(["Zeta", "cimd"]); // document order is information
    expect(sig.tables).toEqual(["users", "jwt_keys"]);
  });

  it("ranks a package by its rarest NAME too, and its names rarest first", () => {
    const sig = signatureOf(facts({ imports: [imp("better-auth", ["betterAuth"]), imp("better-auth/api", ["APIError", "createAuthMiddleware"]), imp("better-auth/plugins", ["admin", "bearer", "jwt"]), imp("@better-auth/cimd", ["cimd"])] }), rarity);
    expect(Object.entries(sig.imports!)).toEqual([
      ["@better-auth/cimd", ["cimd"]],
      ["better-auth/plugins", ["jwt", "bearer", "admin"]],
      ["better-auth/api", ["createAuthMiddleware", "APIError"]],
      ["better-auth", ["betterAuth"]],
    ]);
  });

  it("caps every list so a node stays small", () => {
    const many = Array.from({ length: 60 }, (_, i) => `name${i}`);
    const sig = signatureOf(facts({ about: "word ".repeat(200), calls: many, strings: many, headings: many, keys: many, tables: many, imports: many.map((m) => imp(m, many)), decls: many.map((name, i) => ({ name, kind: "const", exported: i % 2 === 0, line: i })) }));
    for (const key of ["exports", "decls", "strings", "headings", "keys", "tables"] as const) expect(sig[key]!.length).toBeLessThanOrEqual(24);
    expect(Object.keys(sig.imports!)).toHaveLength(12);
    expect(Object.values(sig.imports!).every((n) => n.length === 8)).toBe(true);
    expect(sig.about!.length).toBeLessThanOrEqual(320);
    expect(sig.calls).toBeUndefined(); // every call was one of its own declarations
  });

  it("is deterministic and leaves the facts alone", () => {
    const f = extractFacts(AUTH_HORSE, "ts");
    const frozen = JSON.stringify(f);
    expect(JSON.stringify(signatureOf(f, rarity))).toBe(JSON.stringify(signatureOf(f, rarity)));
    expect(JSON.stringify(f)).toBe(frozen);
  });
});

describe("estimateTokens / optionBudget", () => {
  it("estimates from the JSON length", () => {
    expect(estimateTokens({ kind: "file" })).toBe(Math.ceil(15 / DESCRIPTOR.CHARS_PER_TOKEN));
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens(undefined)).toBe(0);
  });

  const budgets: Array<[number, number]> = [[0, 160], [1, 160], [60, 160], [75, 160], [100, 120], [123, 97], [133, 90], [266, 45], [347, 45], [5000, 45]];
  it.each(budgets)("%i children → %i tokens per option", (children, budget) => {
    expect(optionBudget(children)).toBe(budget);
  });
});

describe("fillDescriptor", () => {
  const sig = signatureOf(extractFacts(AUTH_HORSE, "ts"), rarity);

  it("no signature → the base, exactly", () => {
    const base = { kind: "file", ext: "ts", lines: 3, exports: ["a"], about: "today's hint" };
    const out = fillDescriptor(base, undefined);
    expect(out).toEqual(base);
    expect(JSON.stringify(out)).toBe(JSON.stringify(base));
    expect(out).not.toBe(base);
    expect(fillDescriptor(base, {})).toEqual(base);
  });

  it("the mint-jwt file keeps the word jwt at the full budget and at a crowded directory's 90", () => {
    const full = fillDescriptor(BASE, sig, 160);
    expect((full.imports as Record<string, string[]>)["better-auth/plugins"]).toContain("jwt");
    expect(estimateTokens(full)).toBeLessThanOrEqual(160);

    // The grouped form no longer fits; the word list that replaces it is led by each package's rarest name.
    const tight = fillDescriptor(BASE, sig, 90);
    expect(tight.imports).toEqual(["cimd", "fetchClientMetadataResource", "jwt", "mcp"]);
    expect(estimateTokens(tight)).toBeLessThanOrEqual(90);
    expect(tight.about).toBe("horse-api's better-auth instance (horse.dev) — the same auth behaviour as law-api's (auth-base.ts) plus the…");
    expect(tight.exports).toEqual(full.exports); // tier 1 is intact in both
  });

  it("without a rarity function jwt still survives the full budget (source order, all names fit)", () => {
    const plain = fillDescriptor(BASE, signatureOf(extractFacts(AUTH_HORSE, "ts")), 160);
    expect(JSON.stringify(plain.imports)).toContain('"jwt"');
  });

  it("the header comment alone would not have done it: tier 1 shows 110 chars, jwt() comes later", () => {
    const tier1 = fillDescriptor(BASE, { about: sig.about, exports: sig.exports }, 75);
    expect(JSON.stringify(tier1)).not.toContain("jwt");
    expect((tier1.about as string).length).toBeLessThanOrEqual(DESCRIPTOR.ABOUT_SHORT);
    // with room to spare the about grows to ABOUT_LONG, in place, and then it does
    const roomy = fillDescriptor(BASE, { about: sig.about, exports: sig.exports }, 160);
    expect(roomy.about as string).toContain("jwt() signs the access tokens");
    expect((roomy.about as string).length).toBeLessThanOrEqual(DESCRIPTOR.ABOUT_LONG);
    expect(Object.keys(roomy)).toEqual(["kind", "ext", "lines", "about", "exports"]);
  });

  it("never exceeds the budget, keeps one key order, and is deterministic", () => {
    const rich: Signature = {
      about: "Verifies bearer tokens for the MCP resource server and resolves the actor behind them. ".repeat(4),
      exports: ["OAuthVerifierConfig", "VerifiedActor", "isJwtShaped", "parseScopeClaim", "resolveActor", "actorToAuthInfo", "actorFromAuthInfo", "mcpBearerAuth", "ninth"],
      imports: { "@modelcontextprotocol/server": ["McpServer", "AuthInfo"], jose: ["jwtVerify", "createRemoteJWKSet", "errors", "decodeJwt", "fifth"], express: ["Request", "Response", "NextFunction"], "better-auth/oauth2": ["verifyAccessToken"], svix: [], zod: ["z"], seventh: ["x"] },
      local: ["horse-urls", "mcp-oauth-policy", "logger", "env", "a", "b", "c"],
      decls: ["JWKS_CACHE_KEY", "clientIp", "isTokenShaped"],
      calls: ["jwtVerify", "horseAuthIssuer", "createRemoteJWKSet", "resolveActor", "clientIp", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"],
      strings: ["WWW-Authenticate", "invalid_token", "/.well-known/oauth-protected-resource", "mcp:read", "x", "y"],
      headings: ["Verifier", "Scopes"],
      keys: ["a.b", "c"],
      tables: ["Jwks"],
    };
    const order = ["kind", "ext", "lines", "about", "exports", "imports", "headings", "keys", "tables", "calls", "strings", "local", "decls"];
    for (const signature of [rich, sig, { strings: rich.strings }, { imports: rich.imports }]) {
      for (let budget = 20; budget <= 200; budget += 3) {
        const out = fillDescriptor(BASE, signature, budget);
        expect(estimateTokens(out)).toBeLessThanOrEqual(Math.max(budget, estimateTokens(BASE)));
        const keys = Object.keys(out);
        expect(keys).toEqual(order.filter((k) => keys.includes(k)));
        expect(JSON.stringify(fillDescriptor(BASE, signature, budget))).toBe(JSON.stringify(out));
      }
    }
    const full = fillDescriptor(BASE, rich, 400);
    expect((full.exports as string[]).length).toBe(DESCRIPTOR.EXPORTS);
    expect(Object.keys(full.imports as object)).toHaveLength(DESCRIPTOR.IMPORT_PACKAGES);
    expect((full.imports as Record<string, string[]>).jose).toHaveLength(DESCRIPTOR.IMPORT_NAMES);
    expect(full.calls).toEqual(["horseAuthIssuer", "clientIp", "a1", "a2", "a3", "a4", "a5", "a6"]); // not what exports / imports already show, and no more than CALLS
    expect((full.calls as string[]).length).toBe(DESCRIPTOR.CALLS);
    expect((full.strings as string[]).length).toBe(DESCRIPTOR.STRINGS);
    expect((full.local as string[]).length).toBe(DESCRIPTOR.LOCAL);
    expect((full.about as string).length).toBeLessThanOrEqual(DESCRIPTOR.ABOUT_LONG);
  });

  it("the default budget is one full option", () => {
    const many: Signature = { calls: Array.from({ length: 24 }, (_, i) => `someRatherLongCalledName${i}`), strings: Array.from({ length: 24 }, (_, i) => `some-long-literal-${i}`), local: Array.from({ length: 24 }, (_, i) => `sibling-module-${i}`), exports: Array.from({ length: 24 }, (_, i) => `ExportedThingNumber${i}`), about: "x ".repeat(160) };
    const out = fillDescriptor(BASE, many);
    expect(estimateTokens(out)).toBeLessThanOrEqual(DESCRIPTOR.OPTION_TOKENS);
    expect(estimateTokens(out)).toBeGreaterThan(DESCRIPTOR.OPTION_TOKENS - 12); // and it is spent, not hoarded
  });

  it("gives every package a name before any package gets its second", () => {
    const imports = { alpha: ["a1", "a2", "a3"], beta: ["b1", "b2"], gamma: [] };
    expect(fillDescriptor({}, { imports }, 15).imports).toEqual({ alpha: ["a1"], beta: ["b1"], gamma: [] });
    expect(fillDescriptor({}, { imports }, 18).imports).toEqual({ alpha: ["a1", "a2"], beta: ["b1", "b2"], gamma: [] });
    expect(fillDescriptor({}, { imports }, 19).imports).toEqual(imports);
    expect(fillDescriptor({}, { imports }, 14).imports).toEqual(["alpha", "beta", "gamma", "a1", "b1", "a2"]); // not even one name each: the word list
  });

  it("the tight form: a bare package leads its names, a path trails them, a specifier its names already spell is dropped", () => {
    const out = fillDescriptor({}, { imports: { svix: ["Webhook"], "better-auth": ["betterAuth"], "@example/db": ["prisma", "Prisma"], stripe: [] } }, 25);
    expect(out.imports).toEqual(["svix", "betterAuth", "prisma", "stripe", "Webhook", "Prisma", "@example/db"]);
    // one that does not fit is passed over for a shorter one further on
    expect(fillDescriptor({}, { imports: { a: ["fetchClientMetadataResourceFromSomewhereFarAway"], b: ["jwt"], c: ["x"], d: ["y"], e: ["z"], f: ["w"] } }, 12).imports).toEqual(["a", "b", "c", "d", "e", "f", "jwt"]);
  });

  it("keys the caller already set are the caller's", () => {
    const base = { kind: "subtopic", about: "The taxonomy's own description.", exports: ["kept"] };
    const out = fillDescriptor(base, { about: "ignored ".repeat(40), exports: ["ignored"], tables: ["T"] });
    expect(out).toEqual({ ...base, tables: ["T"] });
  });

  it("a script that exports nothing shows its functions with the structural lists; one that exports shows them last", () => {
    expect(Object.keys(fillDescriptor({}, { decls: ["login", "cleanup"], calls: ["curl"], strings: ["x-a"] }))).toEqual(["decls", "calls", "strings"]);
    expect(Object.keys(fillDescriptor({}, { exports: ["run"], decls: ["login"], calls: ["curl"] }))).toEqual(["exports", "calls", "decls"]);
  });

  it("shortens the about before giving it up, and adds nothing to a base that is already over", () => {
    const about = "Shared better-auth options factory that both API servers spread into their own instance before mounting.";
    expect(fillDescriptor({}, { about }, 40).about).toBe(about);
    expect(fillDescriptor({}, { about }, 26).about).toBe("Shared better-auth options factory that both API servers spread into their own…");
    expect(fillDescriptor({}, { about }, 17).about).toBe("Shared better-auth options factory that both API…");
    expect(fillDescriptor({}, { about }, 8)).toEqual({});
    const big = { kind: "file", contains: Array.from({ length: 40 }, (_, i) => `child-${i}`) };
    expect(fillDescriptor(big, { about, exports: ["a"] }, 45)).toEqual(big);
  });

  it("does not mutate the base or the signature", () => {
    const base = { kind: "file" };
    const frozen = JSON.stringify(sig);
    fillDescriptor(base, sig, 120);
    expect(base).toEqual({ kind: "file" });
    expect(JSON.stringify(sig)).toBe(frozen);
  });
});
