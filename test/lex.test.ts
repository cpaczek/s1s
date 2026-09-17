import { describe, expect, it } from "vitest";
import {
  anchors,
  buildLex,
  docCount,
  evidenceLines,
  MAX_BODY,
  MAX_LINE,
  parseQuery,
  pool,
  rarity,
  search,
  splitIdent,
  stem,
  tokenize,
  variants,
  vocabularySize,
  type LexDoc,
  type LexHit,
  type QueryTerm,
} from "../src/index/lex.ts";

const doc = (path: string, body = "", sig = ""): LexDoc => ({ path, sig, body });
const paths = (hits: LexHit[]) => hits.map((h) => h.path);
const term = (label: string, df: number, weight = 1, group = [label]): QueryTerm => ({ label, group, weight, df });

describe("tokens", () => {
  it("splitIdent splits camelCase, acronym boundaries, snake, kebab, dots and slashes", () => {
    const table: Array<[string, string[]]> = [
      ["getSessionFromCtx", ["get", "session", "from", "ctx"]],
      ["HTTPServer2", ["http", "server2"]],
      ["stripe-webhook_handler", ["stripe", "webhook", "handler"]],
      ["parseJSONBody", ["parse", "json", "body"]],
      ["JWTs and userIDsByName", ["jwts", "and", "user", "ids", "by", "name"]], // a plural acronym is one word
      ["CSSStyle", ["css", "style"]],
      ["X509Certificate", ["x509", "certificate"]],
      ["packages/db/src/auth-horse.test.ts", ["packages", "db", "src", "auth", "horse", "test", "ts"]],
      ["e2e/v2 sha256", ["e2e", "v2", "sha256"]], // digits stay attached
      ["naïve café", ["na", "ve", "caf"]], // non-ASCII separates
      ["", []],
    ];
    for (const [input, want] of table) expect(splitIdent(input), input).toEqual(want);
  });

  it("stem strips plurals and nothing else", () => {
    const table: Array<[string, string]> = [
      ["classes", "class"],
      ["policies", "policy"],
      ["status", "status"],
      ["jwts", "jwt"],
      ["boxes", "box"],
      ["matches", "match"],
      ["pushes", "push"],
      ["files", "file"],
      ["databases", "database"],
      ["access", "access"],
      ["analysis", "analysis"],
      ["corpus", "corpus"],
      ["ties", "tie"],
      ["ids", "ids"], // too short to risk: aws, dns, tls
      ["is", "is"],
      ["minting", "minting"],
      ["cookies", "cooky"], // the S-stemmer's known miss; `variants` bridges it
    ];
    for (const [input, want] of table) expect(stem(input), input).toBe(want);
  });

  it("tokenize lower-cases, stems, and drops 1-char tokens, 33+ char tokens and pure numbers", () => {
    expect(tokenize(`A getUserPolicies(x, 42) v2 2024 ${"a".repeat(32)} ${"b".repeat(33)}`)).toEqual(["get", "user", "policy", "v2", "a".repeat(32)]);
  });
});

describe("variants", () => {
  it("covers inflection, the agent noun and -ion → verb, both ways", () => {
    expect(variants("mint")).toEqual(["mint", "minted", "minting", "minter"]);
    expect(variants("mints")).toEqual(expect.arrayContaining(["mint", "minted", "minting", "minter"]));
    expect(variants("dropping")).toEqual(expect.arrayContaining(["drop", "dropped"]));
    expect(variants("drop")).toEqual(["drop", "dropped", "dropping", "dropper"]);
    expect(variants("verified")).toEqual(expect.arrayContaining(["verify", "verifying", "verifier"]));
    expect(variants("controlled")).toEqual(expect.arrayContaining(["control", "controlling", "controller"]));
    expect(variants("migrations")).toEqual(expect.arrayContaining(["migration", "migrate", "migrated"]));
    expect(variants("handler")).toEqual(expect.arrayContaining(["handle", "handled", "handling"]));
  });

  it("bridges the plurals the stemmer gets wrong", () => {
    expect(variants("cookie")).toContain("cooky");
    expect(variants("cookies")).toContain("cookie");
    expect(variants("cache")).toContain("cach");
    expect(variants("statuses")).toContain("status");
  });

  it("guards the misreads of a short stem, but not a lexicalised noun's commoner base", () => {
    expect(variants("hoping")).not.toContain("hop");
    expect(variants("hops")).not.toContain("hoped");
    expect(variants("timing")).toContain("time");
    expect(variants("timing")).not.toContain("tim");
    expect(variants("calling")).toContain("call");
    expect(variants("calling")).not.toContain("cal");
    expect(variants("notion")).not.toContain("not");
    expect(variants("mission")).not.toContain("miss");
    expect(variants("sees")).not.toContain("seed");
    expect(variants("user")).not.toContain("use");
    expect(variants("better")).not.toContain("bet");
    expect(variants("processor")).not.toContain("process");
    // the known false friends, stated so nobody reads more into the guards than they give (see the doc comment for the measured why)
    expect(variants("better")).toEqual(expect.arrayContaining(["betted", "betting"]));
    expect(variants("settings")).toContain("set");
    expect(variants("owner")).toContain("own");
    expect(variants("header")).toContain("head");
    expect(variants("production")).toContain("product");
  });
});

const CORPUS: LexDoc[] = [
  doc("src/billing/stripe-webhook.ts", "checks the signature, then records the event", "handleStripeWebhook constructEvent"),
  doc("docs/billing-notes.md", "stripe webhook stripe webhook stripe webhook: what the handler does when stripe retries a webhook", "Billing notes"),
  doc("src/auth/session.ts", "reads the cookie and loads the session; nothing here mints a token", "getSession"),
  doc("src/auth/token.ts", "minting access tokens: the minter signs a jwt", "mintToken"),
  doc("src/auth/token.test.ts", "minted tokens verify", "describe"),
  doc("src/util/log.ts", "log the event", "log"),
  doc("assets/logo.png"),
];

describe("buildLex", () => {
  const lex = buildLex(CORPUS);

  it("packs the index into typed arrays", () => {
    expect(docCount(lex)).toBe(CORPUS.length);
    expect(vocabularySize(lex)).toBe(lex.vocab.size);
    expect(lex.postDoc).toBeInstanceOf(Uint32Array);
    expect(lex.postTf).toBeInstanceOf(Uint16Array);
    expect(lex.postTf.length).toBe(3 * lex.postDoc.length);
    expect(lex.start.length).toBe(lex.vocab.size + 1);
    expect(lex.start[lex.vocab.size]).toBe(lex.postDoc.length);
    expect(lex.lengths.length).toBe(3 * CORPUS.length);
    for (let t = 0; t < lex.vocab.size; t++) for (let p = lex.start[t] + 1; p < lex.start[t + 1]; p++) expect(lex.postDoc[p]).toBeGreaterThan(lex.postDoc[p - 1]);
  });

  it("counts the basename twice in the path field", () => {
    // path: src billing stripe webhook ts + stripe webhook ts; sig: handle stripe webhook construct event
    expect([...lex.lengths.slice(0, 3)]).toEqual([8, 5, 7]);
    const t = lex.vocab.get("stripe")!;
    expect(lex.postDoc[lex.start[t]]).toBe(0);
    expect([...lex.postTf.slice(3 * lex.start[t], 3 * lex.start[t] + 3)]).toEqual([2, 1, 0]);
    expect(lex.avg[0]).toBeCloseTo(lex.lengths.filter((_, i) => i % 3 === 0).reduce((a, b) => a + b, 0) / CORPUS.length);
  });

  it("streams from a generator and tolerates an empty tree", () => {
    const streamed = buildLex(
      (function* () {
        yield* CORPUS;
      })(),
    );
    expect(paths(search(streamed, parseQuery(streamed, "stripe webhook")))).toEqual(paths(search(lex, parseQuery(lex, "stripe webhook"))));
    const empty = buildLex([]);
    expect(search(empty, parseQuery(empty, "anything"))).toEqual([]);
    expect(pool(empty, parseQuery(empty, "anything"))).toEqual([]);
  });

  it("skips over-long lines, caps the body, and saturates tf instead of overflowing", () => {
    const big = buildLex([
      doc("min.js", `${"x".repeat(MAX_LINE - 5)} needle\nhaystack`),
      doc("ok.js", `${"x".repeat(MAX_LINE - 7)} needle`),
      doc("long.txt", `${"pad\n".repeat(MAX_BODY / 4)}needle`),
      doc("rep.txt", "foo\n".repeat(70_000)),
    ]);
    expect(paths(search(big, parseQuery(big, "needle")))).toEqual(["ok.js"]);
    expect(paths(search(big, parseQuery(big, "haystack")))).toEqual(["min.js"]);
    expect(big.lengths[3 * 3 + 2]).toBe(MAX_BODY / 4);
    const foo = big.vocab.get("foo")!;
    expect(big.postTf[3 * big.start[foo] + 2]).toBe(0xffff);
  });

  it("holds only split, lower-cased 2–32 char tokens", () => {
    for (const key of lex.vocab.keys()) expect(key).toMatch(/^[a-z0-9]{2,32}$/);
    expect(lex.vocab.has("constructevent")).toBe(false);
    expect(lex.vocab.has("construct")).toBe(true);
  });

  it("rarity is the idf of a name's rarest word", () => {
    expect(rarity(lex, "jwt")).toBeGreaterThan(rarity(lex, "token"));
    expect(rarity(lex, "getJwtToken")).toBe(rarity(lex, "jwt"));
    expect(rarity(lex, "tokens")).toBe(rarity(lex, "token"));
    expect(rarity(lex, "x 42")).toBe(0);
  });
});

describe("parseQuery", () => {
  const lex = buildLex(CORPUS);

  it("drops stop-words, keeps the typed word as the label, groups the variants the vocabulary holds", () => {
    const terms = parseQuery(lex, "where do we mint the JWTs?");
    expect(terms).toEqual([
      { label: "mint", group: ["mint", "minted", "minting", "minter"], weight: 1, df: 3 },
      { label: "jwts", group: ["jwt"], weight: 1, df: 1 },
    ]);
  });

  it("keeps a word the tree never uses, with df 0", () => {
    expect(parseQuery(lex, "kubernetes webhook")).toEqual([
      { label: "kubernetes", group: [], weight: 1, df: 0 },
      { label: "webhook", group: ["webhook"], weight: 1, df: 2 },
    ]);
  });

  it("makes one term of two forms of the same word", () => {
    expect(parseQuery(lex, "token tokens minting mint").map((t) => t.label)).toEqual(["token", "minting"]);
    expect(parseQuery(lex, "getSession").map((t) => t.label)).toEqual(["get", "session"]);
    expect(parseQuery(lex, "the 2024 a")).toEqual([]);
  });

  it("drops a stop-word that only the stemmer reveals (uses → use, things → thing)", () => {
    expect(parseQuery(lex, "uses things token").map((t) => t.label)).toEqual(["token"]);
  });

  it("reads a CamelCase word split AND joined, the vocabulary deciding which the tree uses", () => {
    const camel = buildLex([
      doc("src/providers/trpc-provider.tsx", "creates the trpc react client", "createTRPCReact"),
      doc("src/rpc/call.ts", "one rpc call after another", "callRpc"),
      doc("src/auth/oauth.ts", "the oauth server", "oauthServer"),
      doc("src/auth/session.ts", "getSession reads the cookie", "getSession"),
      doc("src/lib/posthog.ts", "analytics", "capture"),
    ]);
    // tRPC → the tree writes it joined (trpc-provider); its parts (t, rpc) alone would rank the rpc file
    const trpc = parseQuery(camel, "the tRPC provider");
    expect(trpc.map((t) => [t.label, t.group])).toEqual([["trpc", ["trpc"]], ["rpc", ["rpc"]], ["provider", ["provider"]]]);
    expect(paths(search(camel, trpc))).toEqual(["src/providers/trpc-provider.tsx", "src/rpc/call.ts"]); // the parts still reach
    expect(paths(search(camel, parseQuery(camel, "the trpc provider")))).toEqual(["src/providers/trpc-provider.tsx"]);
    // a joined form the tree never uses is not a term: getSession stays get + session
    expect(parseQuery(camel, "getSession").map((t) => t.label)).toEqual(["get", "session"]);
    // once the joined form is in the tree, a part the tree never uses is not reported as missing (hog)
    expect(parseQuery(camel, "OAuth PostHog").map((t) => [t.label, t.df])).toEqual([["oauth", 1], ["auth", 2], ["posthog", 1]]);
    // …but with no joined form, unknown parts are still kept, so the caller can say "not in this tree"
    expect(parseQuery(camel, "GitHub").map((t) => [t.label, t.df])).toEqual([["git", 0], ["hub", 0]]);
    // extras get the same reading
    expect(parseQuery(camel, "session", [{ term: "tRPC", weight: 0.5 }]).map((t) => [t.label, t.weight])).toEqual([["session", 1], ["trpc", 0.5], ["rpc", 0.5]]);
  });

  it("adds extra terms at their weight only when the tree uses them and the query does not", () => {
    const terms = parseQuery(lex, "mint jwts", [
      { term: "jsonwebtoken", weight: 0.5 }, // not in this tree
      { term: "minting", weight: 0.5 }, // already covered by "mint"
      { term: "access token", weight: 0.5 },
      { term: "cookie", weight: 0 },
    ]);
    expect(terms.map((t) => [t.label, t.weight])).toEqual([["mint", 1], ["jwts", 1], ["access", 0.5], ["token", 0.5]]);
    expect(terms[3].df).toBe(3);
  });
});

describe("search", () => {
  const lex = buildLex(CORPUS);

  it("ranks a path match above a body that repeats the words", () => {
    const hits = search(lex, parseQuery(lex, "stripe webhook"));
    expect(paths(hits)).toEqual(["src/billing/stripe-webhook.ts", "docs/billing-notes.md"]);
    expect(hits.map((h) => h.rank)).toEqual([1, 2]);
    expect(hits[0].matched).toEqual(["stripe", "webhook"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("weighs the fields path > facts > body at equal tf and equal lengths", () => {
    // one "needle" each: in a path segment, in the facts, in the body; every field the same length in every doc
    const even = buildLex([
      doc("xx/xx/aa.ts", "needle gg hh ii jj", "aa bb cc dd ee"),
      doc("yy/yy/aa.ts", "ff gg hh ii jj", "needle bb cc dd ee"),
      doc("zz/needle/aa.ts", "ff gg hh ii jj", "aa bb cc dd ee"),
    ]);
    expect([...even.lengths]).toEqual([6, 5, 5, 6, 5, 5, 6, 5, 5]);
    // flat weights would tie and fall back to path order, which is the reverse
    expect(paths(search(even, parseQuery(even, "needle")))).toEqual(["zz/needle/aa.ts", "yy/yy/aa.ts", "xx/xx/aa.ts"]);
  });

  it("saturates tf: repeating a word does not outrank a second query term", () => {
    const rep = buildLex([doc("a/loud.ts", "beta beta beta beta beta beta beta beta filler"), doc("a/both.ts", "beta gamma filler"), ...Array.from({ length: 10 }, (_, i) => doc(`f/f${i}.ts`, "filler only"))]);
    expect(paths(search(rep, parseQuery(rep, "beta gamma")))).toEqual(["a/both.ts", "a/loud.ts"]);
  });

  it("ranks the rare term above the common one", () => {
    const many = buildLex([...Array.from({ length: 12 }, (_, i) => doc(`lib/m${i}.ts`, "common filler text")), doc("lib/one.ts", "rare filler text"), doc("lib/two.ts", "common rare")]);
    const hits = search(many, parseQuery(many, "common rare"));
    expect(paths(hits).slice(0, 3)).toEqual(["lib/two.ts", "lib/one.ts", "lib/m0.ts"]);
    expect(hits[1].matched).toEqual(["rare"]);
  });

  it("scores a group as one term: every variant reaches the doc", () => {
    const hits = search(lex, parseQuery(lex, "mint"));
    expect(paths(hits).sort()).toEqual(["src/auth/session.ts", "src/auth/token.test.ts", "src/auth/token.ts"]);
    expect(hits[0].path).toBe("src/auth/token.ts"); // minting + minter + mintToken
  });

  it("restricts the fields", () => {
    const q = parseQuery(lex, "signature");
    expect(paths(search(lex, q))).toEqual(["src/billing/stripe-webhook.ts"]);
    expect(search(lex, q, { fields: "path+sig" })).toEqual([]);
    const sig = parseQuery(lex, "constructEvent");
    expect(paths(search(lex, sig, { fields: "path+sig" }))).toEqual(["src/billing/stripe-webhook.ts"]);
    expect(search(lex, sig, { fields: "path" })).toEqual([]);
    expect(paths(search(lex, parseQuery(lex, "billing"), { fields: "path" }))).toEqual(["docs/billing-notes.md", "src/billing/stripe-webhook.ts"]);
  });

  it("restricts to a scope directory and re-ranks from 1", () => {
    const q = parseQuery(lex, "token event");
    expect(paths(search(lex, q, { scope: "src/auth" }))).toEqual(["src/auth/token.ts", "src/auth/token.test.ts", "src/auth/session.ts"]);
    expect(search(lex, q, { scope: "src/auth/" }).map((h) => h.rank)).toEqual([1, 2, 3]);
    expect(search(lex, q, { scope: "src/au" })).toEqual([]);
    expect(paths(search(lex, q, { scope: "src/util/log.ts" }))).toEqual(["src/util/log.ts"]);
    expect(search(lex, q, { scope: "" })).toHaveLength(5);
    expect(search(lex, q, { limit: 2 })).toHaveLength(2);
  });

  it("clamps a fractional, NaN or negative count instead of throwing or leaking", () => {
    const q = parseQuery(lex, "token event");
    const all = search(lex, q);
    expect(all).toHaveLength(5);
    expect(search(lex, q, { limit: 2.5 })).toEqual(all.slice(0, 2));
    expect(search(lex, q, { limit: NaN })).toEqual([]);
    expect(search(lex, q, { limit: -3 })).toEqual([]);
    expect(search(lex, q, { limit: Infinity })).toEqual(all);
    expect(pool(lex, q, { all: -1, path: 0, sig: 0 })).toEqual([]);
    expect(pool(lex, q, { all: NaN, path: NaN, sig: NaN })).toEqual([]);
    expect(pool(lex, q, { all: 1, path: 1.5, sig: 0 })).toEqual(pool(lex, q, { all: 1, path: 1, sig: 0 }));
    expect(pool(lex, q, { all: 1.9, path: 0, sig: 0 })).toEqual(pool(lex, q, { all: 1, path: 0, sig: 0 }));
    const h = all.map((x, i) => ({ ...x, path: `d${i % 2}/${x.path}` }));
    expect(anchors(h, { top: -1 })).toEqual([]);
    expect(anchors(h, { max: -1 })).toEqual([]);
    expect(anchors(h, { top: 2.5 })).toEqual(anchors(h, { top: 2 }));
  });

  it("ignores terms the tree never uses", () => {
    const base = search(lex, parseQuery(lex, "stripe webhook"));
    expect(search(lex, parseQuery(lex, "stripe webhook kubernetes"))).toEqual(base);
    expect(search(lex, parseQuery(lex, "stripe webhook", [{ term: "jsonwebtoken", weight: 0.5 }]))).toEqual(base);
    expect(search(lex, parseQuery(lex, "kubernetes"))).toEqual([]);
  });

  it("applies a term's weight", () => {
    const [full] = search(lex, [term("jwt", 1)]);
    const [half] = search(lex, [term("jwt", 1, 0.5)]);
    expect(half.score).toBeCloseTo(full.score / 2);
    expect(search(lex, [term("jwt", 1, 0)])).toEqual([]);
  });

  it("is deterministic: ties break by path, rebuilds agree", () => {
    const twins = buildLex([doc("b/x.ts", "same words"), doc("a/x.ts", "same words"), doc("c/x.ts", "same words")]);
    expect(paths(search(twins, parseQuery(twins, "same")))).toEqual(["a/x.ts", "b/x.ts", "c/x.ts"]);
    const again = buildLex(CORPUS);
    for (const q of ["stripe webhook", "mint jwts", "token event log"]) {
      expect(search(again, parseQuery(again, q))).toEqual(search(lex, parseQuery(lex, q)));
      expect(pool(again, parseQuery(again, q))).toEqual(pool(lex, parseQuery(lex, q)));
    }
  });
});

describe("pool", () => {
  // "beta" is rare and lives in bodies; "alpha" is common. p/alpha.ts is named for the query but says
  // nothing else, s/sig.ts only declares it: neither makes the all-field top 2.
  const lex = buildLex([
    doc("x/one.ts", "alpha beta beta"),
    doc("x/two.ts", "alpha beta"),
    doc("p/alpha.ts", "unrelated"),
    doc("s/sig.ts", "unrelated", "beta"),
    ...Array.from({ length: 8 }, (_, i) => doc(`y/f${i}.ts`, "alpha filler")),
  ]);
  const q = parseQuery(lex, "alpha beta");

  it("is the all-field top ∪ the path top ∪ the path+sig top, all-field order first, deduplicated", () => {
    const all = search(lex, q);
    expect(paths(all).slice(0, 2)).toEqual(["x/one.ts", "x/two.ts"]);
    expect(paths(pool(lex, q, { all: 2, path: 0, sig: 0 }))).toEqual(["x/one.ts", "x/two.ts"]);
    expect(paths(pool(lex, q, { all: 2, path: 1, sig: 0 }))).toEqual(["x/one.ts", "x/two.ts", "p/alpha.ts"]);
    expect(paths(pool(lex, q, { all: 2, path: 0, sig: 2 }))).toEqual(["x/one.ts", "x/two.ts", "p/alpha.ts", "s/sig.ts"]);
    expect(paths(pool(lex, q, { all: 2, path: 1, sig: 2 }))).toEqual(["x/one.ts", "x/two.ts", "p/alpha.ts", "s/sig.ts"]);
    const wide = pool(lex, q, { all: 3, path: 5, sig: 5 });
    expect(new Set(paths(wide)).size).toBe(wide.length);
    expect(paths(wide).slice(0, 3)).toEqual(paths(all).slice(0, 3));
  });

  it("numbers the pool and keeps every hit's all-field score", () => {
    const p = pool(lex, q, { all: 2, path: 1, sig: 2 });
    expect(p.map((h) => h.rank)).toEqual([1, 2, 3, 4]);
    const all = new Map(search(lex, q).map((h) => [h.path, h]));
    for (const h of p) expect(h.score).toBe(all.get(h.path)!.score);
    expect(p[2].matched).toEqual(["alpha"]);
  });

  it("defaults to 32 ∪ 10 with the facts view off, and honours the scope", () => {
    expect(paths(pool(lex, q)).sort()).toEqual(paths(search(lex, q)).sort());
    expect(paths(pool(lex, q, { scope: "x" }))).toEqual(["x/one.ts", "x/two.ts"]);
    expect(paths(pool(lex, q, { all: 2 }))).toEqual(["x/one.ts", "x/two.ts", "p/alpha.ts"]); // the path view is on, the facts view off
    expect(paths(pool(lex, q, { all: 2, path: 0 }))).toEqual(["x/one.ts", "x/two.ts"]);
    const lots = buildLex(Array.from({ length: 60 }, (_, i) => doc(`d${i}/f.ts`, "alpha")));
    expect(pool(lots, parseQuery(lots, "alpha"))).toHaveLength(32);
    expect(pool(lots, parseQuery(lots, "alpha"), { all: 30 })).toHaveLength(30);
  });
});

describe("anchors", () => {
  const hits = (...ps: string[]): LexHit[] => ps.map((path, i) => ({ path, score: 10 - i, rank: i + 1, matched: [] }));

  it("returns the deepest directories holding at least two of the top hits, deepest first", () => {
    const h = hits(
      "apps/horse-api/src/mcp/verifier.test.ts",
      "apps/horse-api/src/mcp/verifier.ts",
      "apps/horse-api/scripts/mcp-oauth-e2e.ts",
      "packages/db/src/auth-horse.ts",
      "packages/db/prisma/oauth.prisma",
      "apps/horse/app/docs/page.tsx",
      "packages/db/src/adopt-profile.ts",
      "README.md",
    );
    expect(anchors(h)).toEqual(["apps/horse-api/src/mcp", "packages/db/src"]);
  });

  it("falls back to a parent only when no child qualifies, and never to the root", () => {
    expect(anchors(hits("apps/x/1.ts", "apps/y/2.ts", "README.md", "LICENSE"))).toEqual(["apps"]);
    expect(anchors(hits("a.ts", "b.ts"))).toEqual([]);
    expect(anchors([])).toEqual([]);
  });

  it("honours top, min and max; equal depth orders by hits, then path", () => {
    // b/x holds three of the hits and sorts after a/y by name: only the hit count can put it first
    const h = hits("b/x/1.ts", "b/x/2.ts", "a/y/1.ts", "b/x/3.ts", "a/y/2.ts", "c/z/1.ts", "c/z/2.ts", "d/w/1.ts", "d/w/2.ts");
    expect(anchors(h)).toEqual(["b/x", "a/y", "c/z"]);
    expect(anchors(h, { max: 1 })).toEqual(["b/x"]);
    expect(anchors(h, { min: 3 })).toEqual(["b/x"]);
    expect(anchors(h, { top: 2 })).toEqual(["b/x"]);
    expect(anchors(h, { top: 20, max: 9 })).toEqual(["b/x", "a/y", "c/z", "d/w"]);
  });
});

describe("evidenceLines", () => {
  // Shaped like packages/db/src/auth-horse.ts: the answer is an import and one call, far below the head.
  const file = [
    "// horse-api's auth instance: the same behaviour as law-api's",
    "// plus the OAuth 2.1 authorization server the admin MCP needs.",
    "//",
    "",
    "import { betterAuth } from 'better-auth';",
    "import { admin, bearer, jwt } from 'better-auth/plugins';",
    "import { mcp } from '@better-auth/mcp';",
    ...Array.from({ length: 20 }, (_, i) => `const filler${i} = ${i};`),
    "export const horseAuth = betterAuth({",
    "\tplugins: [",
    "\t\tadmin(),",
    "\t\tbearer(),",
    "\t\tjwt(),",
    "\t\tmcp({",
    "\t\t\tloginPage: '/sign-in',",
    ...Array.from({ length: 20 }, (_, i) => `\t\t\toption${i}: ${i},`),
    "\t\t\t// nothing mints a token for a non-grantee",
    "\t\t}),",
    "\t],",
    "});",
  ].join("\n");
  const terms = [term("mint", 338, 1, ["mint", "minted", "minting", "minter"]), term("jwts", 20, 1, ["jwt"])];

  it("shows the head, then numbered windows around the rarest query terms", () => {
    const out = evidenceLines(file, terms, { head: 4 });
    expect(out.slice(0, 4)).toEqual([
      "1: // horse-api's auth instance: the same behaviour as law-api's",
      "2: // plus the OAuth 2.1 authorization server the admin MCP needs.",
      "3: //",
      "5: import { betterAuth } from 'better-auth';",
    ]);
    expect(out).toContain("6: import { admin, bearer, jwt } from 'better-auth/plugins';");
    expect(out).toContain("32: \t\tjwt(),");
    expect(out).toContain("55: \t\t\t// nothing mints a token for a non-grantee");
    // the import window touches the head: one block, no separator; the others stand apart
    expect(out.slice(4, 8)).toEqual([
      "6: import { admin, bearer, jwt } from 'better-auth/plugins';",
      "7: import { mcp } from '@better-auth/mcp';",
      "8: const filler0 = 0;",
      "…",
    ]);
    expect(out.filter((l) => l === "…")).toHaveLength(2);
    expect(out.at(-1)).toBe("57: \t],");
  });

  it("spends windows on the rarest term first, and none on lines already shown", () => {
    const one = evidenceLines(file, terms, { head: 8, windows: 1 });
    // line 6 (jwt) is inside the 8-line head, so the single window goes to the next jwt line, not to "mints"
    expect(one).toContain("32: \t\tjwt(),");
    expect(one.some((l) => l.startsWith("55:"))).toBe(false);
    const common = evidenceLines(file, [terms[0]], { head: 2, windows: 1 });
    expect(common).toContain("55: \t\t\t// nothing mints a token for a non-grantee");
  });

  const pad = (n: number) => Array.from({ length: n }, () => "pad");

  it("prefers a line with more distinct terms, then the rarer term, and weighs an extra term down", () => {
    const text = ["head", ...pad(10), "alpha here", ...pad(10), "alpha and beta here", ...pad(10), "beta here"].join("\n");
    const both = evidenceLines(text, [term("alpha", 50), term("beta", 50)], { head: 1, windows: 1, radius: 0 });
    expect(both).toEqual(["1: head", "…", "23: alpha and beta here"]);
    // equal weight: the rarer term's own line takes the second window
    const rare = evidenceLines(text, [term("alpha", 5000), term("beta", 2)], { head: 1, windows: 2, radius: 0 });
    expect(rare).toEqual(["1: head", "…", "23: alpha and beta here", "…", "34: beta here"]);
    // alpha is far rarer but weighed down to 0.2 (an LLM extra): the common full-weight term's line wins instead
    const weighed = evidenceLines(text, [term("alpha", 50, 0.2), term("beta", 5000)], { head: 1, windows: 2, radius: 0 });
    expect(weighed).toEqual(["1: head", "…", "23: alpha and beta here", "…", "34: beta here"]);
  });

  it("breaks an equal score by distinct terms, then by the earlier line", () => {
    // aa alone at weight 1 scores exactly what bb and cc score together at 0.5 each (same df)
    const text = ["head", ...pad(10), "aa here", ...pad(10), "bb and cc here"].join("\n");
    expect(evidenceLines(text, [term("aa", 5), term("bb", 5, 0.5), term("cc", 5, 0.5)], { head: 1, windows: 1, radius: 0 })).toEqual(["1: head", "…", "23: bb and cc here"]);
    const twice = ["top", "gap", "", "needle one", "between", "", "needle two", "after"].join("\n");
    expect(evidenceLines(twice, [term("needle", 3)], { head: 1, windows: 1, radius: 0 })).toEqual(["1: top", "…", "4: needle one"]);
  });

  it("never spends a window on a minified line or past the body cap", () => {
    const long = ["head", ...pad(5), `${"x".repeat(MAX_LINE)} needle`, ...pad(5), "needle here"].join("\n");
    expect(evidenceLines(long, [term("needle", 3)], { head: 1, windows: 1, radius: 0 })).toEqual(["1: head", "…", "13: needle here"]);
    const far = `head\n${"pad\n".repeat(MAX_BODY / 4)}needle here`;
    expect(evidenceLines(far, [term("needle", 3)], { head: 1, windows: 1, radius: 0 })).toEqual(["1: head"]);
  });

  it("merges overlapping windows and does not count blank lines as a gap", () => {
    const text = ["top", "", "", "needle one", "between", "", "needle two", "after", "", "tail a", "tail b", "tail c"].join("\n");
    expect(evidenceLines(text, [term("needle", 3)], { head: 1, windows: 2, radius: 1 })).toEqual(["1: top", "4: needle one", "5: between", "7: needle two", "8: after"]);
  });

  it("trims long lines, matches through the stemmer, and falls back to the head alone", () => {
    const text = ["short", `${"x".repeat(200)} policies`, "z"].join("\n");
    const out = evidenceLines(text, [term("policy", 4)], { head: 1, windows: 1, radius: 0, width: 20 });
    expect(out).toEqual(["1: short", `2: ${"x".repeat(19)}…`]);
    expect(evidenceLines(file, [], { head: 2 })).toEqual(["1: // horse-api's auth instance: the same behaviour as law-api's", "2: // plus the OAuth 2.1 authorization server the admin MCP needs."]);
    expect(evidenceLines(file, [term("kubernetes", 0, 1, [])], { head: 1 })).toHaveLength(1);
    expect(evidenceLines("", terms)).toEqual([]);
  });

  it("surfaces the evidence end to end from a parsed query", () => {
    const lex = buildLex([doc("packages/db/src/auth-horse.ts", file), ...CORPUS]);
    const out = evidenceLines(file, parseQuery(lex, "where do we mint jwts"));
    expect(out).toContain("6: import { admin, bearer, jwt } from 'better-auth/plugins';");
    expect(out).toContain("32: \t\tjwt(),");
  });
});
