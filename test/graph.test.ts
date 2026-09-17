import { describe, expect, it } from "vitest";
import { emptyFacts } from "../src/index/facts.ts";
import type { FileFacts, ImportFact } from "../src/index/facts.ts";
import { buildGraph, externalUsers, fanIn, fanOut, neighbours } from "../src/graph/build.ts";
import type { CodeGraph, GraphOptions } from "../src/graph/build.ts";
import { createResolver, parseJsonc } from "../src/graph/resolve.ts";
import type { Resolution, ResolverHost } from "../src/graph/resolve.ts";

/** A repo as path → text (objects are written as JSON); "" is enough for a file that only has to exist. */
function hostOf(tree: Record<string, string | object>): ResolverHost {
  return {
    files: new Set(Object.keys(tree)),
    readText: (p) => (p in tree ? (typeof tree[p] === "string" ? (tree[p] as string) : JSON.stringify(tree[p])) : undefined),
  };
}
const resolverOf = (tree: Record<string, string | object>) => createResolver(hostOf(tree));
const file = (path: string): Resolution => ({ kind: "file", path });
const external = (pkg: string): Resolution => ({ kind: "external", pkg });
const UNRESOLVED: Resolution = { kind: "unresolved" };

describe("resolver: relative specifiers", () => {
  const resolve = resolverOf({
    "src/a.ts": "", "src/b.tsx": "", "src/c.js": "", "src/c.ts": "", "src/d.mts": "", "src/e.js": "", "src/data.json": "",
    "src/types.d.ts": "", "src/lib/index.ts": "", "src/ui/index.tsx": "", "src/both.ts": "", "src/both/index.ts": "",
    "src/icon.svg": "", "index.ts": "", "src/deep/x.ts": "", "src/x.mjsx": "", "src/legacy.js": "", "src/legacy.d.ts": "",
  });
  it("probes extensions in order, then /index.*", () => {
    expect(resolve("src/a.ts", "./b")).toEqual(file("src/b.tsx"));
    expect(resolve("src/a.ts", "./c")).toEqual(file("src/c.ts")); // .ts before .js
    expect(resolve("src/a.ts", "./data.json")).toEqual(file("src/data.json"));
    expect(resolve("src/a.ts", "./data")).toEqual(file("src/data.json"));
    expect(resolve("src/a.ts", "./types")).toEqual(file("src/types.d.ts"));
    expect(resolve("src/a.ts", "./lib")).toEqual(file("src/lib/index.ts"));
    expect(resolve("src/a.ts", "./ui")).toEqual(file("src/ui/index.tsx"));
    expect(resolve("src/a.ts", "./both")).toEqual(file("src/both.ts")); // a file beats a directory
  });
  it('reads the NodeNext idiom "./x.js" as "./x.ts(x)", and keeps a real .js when there is no source', () => {
    expect(resolve("src/a.ts", "./a.js")).toEqual(file("src/a.ts"));
    expect(resolve("src/a.ts", "./b.js")).toEqual(file("src/b.tsx"));
    expect(resolve("src/a.ts", "./b.jsx")).toEqual(file("src/b.tsx"));
    expect(resolve("src/a.ts", "./c.js")).toEqual(file("src/c.ts")); // both exist: the source wins
    expect(resolve("src/a.ts", "./d.mjs")).toEqual(file("src/d.mts"));
    expect(resolve("src/a.ts", "./e.js")).toEqual(file("src/e.js"));
    expect(resolve("src/a.ts", "./lib/index.js")).toEqual(file("src/lib/index.ts"));
  });
  it("prefers a hand-written .js over the .d.ts beside it, whichever way the import is spelled", () => {
    expect(resolve("src/a.ts", "./legacy")).toEqual(file("src/legacy.js"));
    expect(resolve("src/a.ts", "./legacy.js")).toEqual(file("src/legacy.js"));
    expect(resolve("src/a.ts", "./legacy.d.ts")).toEqual(file("src/legacy.d.ts")); // asked for by name
  });
  it("never throws on an extension that looks built but has no source spelling", () => {
    expect(resolve("src/a.ts", "./x.mjsx")).toEqual(file("src/x.mjsx"));
    expect(resolve("src/a.ts", "./y.cjsx")).toEqual(UNRESOLVED);
    expect(resolve("src/a.ts", "./a.d.mtsx")).toEqual(UNRESOLVED);
  });
  it("walks up, resolves a bare directory, and never leaves the repo", () => {
    expect(resolve("src/deep/x.ts", "../a")).toEqual(file("src/a.ts"));
    expect(resolve("src/deep/x.ts", "..")).toEqual(UNRESOLVED); // src/ has no index
    expect(resolve("src/a.ts", "..")).toEqual(file("index.ts"));
    expect(resolve("src/deep/x.ts", "../lib")).toEqual(file("src/lib/index.ts"));
    expect(resolve("index.ts", "../outside")).toEqual(UNRESOLVED);
    expect(resolve("src/a.ts", "./missing")).toEqual(UNRESOLVED);
  });
  it('reads ".", "..", and a trailing slash as a directory only, as tsc and node do', () => {
    // src/both.ts sits beside src/both/: a bare "./both" takes the file, but these spellings name the directory
    expect(resolve("src/both/a.ts", ".")).toEqual(file("src/both/index.ts"));
    expect(resolve("src/both/a.ts", "./")).toEqual(file("src/both/index.ts"));
    expect(resolve("src/both/deep/b.ts", "..")).toEqual(file("src/both/index.ts"));
    expect(resolve("src/both/deep/b.ts", "../")).toEqual(file("src/both/index.ts"));
    expect(resolve("src/both/deep/b.ts", "../.")).toEqual(file("src/both/index.ts"));
    expect(resolve("src/a.ts", "./both/")).toEqual(file("src/both/index.ts"));
    expect(resolve("src/a.ts", "./lib/")).toEqual(file("src/lib/index.ts"));
    expect(resolve("src/a.ts", "./a/")).toEqual(UNRESOLVED); // a.ts is a file, not a directory
  });
  it("resolves assets as written, bundler query or fragment suffix or not", () => {
    expect(resolve("src/a.ts", "./icon.svg")).toEqual(file("src/icon.svg"));
    expect(resolve("src/a.ts", "./icon.svg?react")).toEqual(file("src/icon.svg"));
    expect(resolve("src/a.ts", "./a#frag")).toEqual(file("src/a.ts"));
    expect(resolve("src/a.ts", "./gone.png")).toEqual(UNRESOLVED);
  });
});

describe("parseJsonc", () => {
  it("drops comments and trailing commas but never touches strings", () => {
    const text = `\uFEFF{
      // line comment
      "a": "http://x/*not a comment*/", /* block
      comment */ "b": [1, 2, ], "c": ",}",
    }`;
    expect(parseJsonc(text)).toEqual({ a: "http://x/*not a comment*/", b: [1, 2], c: ",}" });
  });
  it("returns undefined for what is still not JSON", () => {
    expect(parseJsonc("{ nope")).toBeUndefined();
    expect(parseJsonc("")).toBeUndefined();
    expect(parseJsonc('{"a": "x')).toBeUndefined();
    expect(parseJsonc('{"a": 1 /* ')).toBeUndefined();
  });
  it("stays linear on a large manifest, strict JSON or not", () => {
    // Pretty-printed with one closer per entry: the quadratic scan took seconds at this size (JSON.parse: milliseconds).
    const entries = Object.fromEntries(Array.from({ length: 30000 }, (_, i) => [`k${i}`, { v: [i, i + 1] }]));
    const strict = JSON.stringify({ deps: entries }, null, 2);
    const jsonc = `﻿// not strict\n${strict.slice(0, -1)},\n}`; // a trailing comma forces the tolerant path
    expect(strict.length).toBeGreaterThan(1_000_000);
    let t = performance.now();
    expect(parseJsonc(strict)).toEqual({ deps: entries });
    expect(performance.now() - t).toBeLessThan(1000);
    t = performance.now();
    expect(parseJsonc(jsonc)).toEqual({ deps: entries });
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("resolver: the nearest tsconfig", () => {
  const tree = {
    // two apps, both "@/*", different roots; one written as real-world JSONC
    "apps/web/tsconfig.json": `{
      // Next.js app
      "compilerOptions": {
        "moduleResolution": "bundler", /* paths are relative to THIS file: no baseUrl */
        "paths": { "@/*": ["./src/*"], },
      },
    }`,
    "apps/web/src/lib/auth.ts": "", "apps/web/src/app/page.tsx": "", "apps/web/src/app/deep/nested/page.tsx": "",
    "apps/web/src/routes/$$.tsx": "", "apps/web/src/routes/a$&b.ts": "", "apps/web/src/routes/$id.tsx": "",
    "apps/horse/tsconfig.json": { compilerOptions: { paths: { "@/*": ["./*"] } } },
    "apps/horse/lib/auth.ts": "", "apps/horse/app/page.tsx": "",
    // no paths at all
    "packages/plain/tsconfig.json": { compilerOptions: {} },
    "packages/plain/src/x.ts": "",
    // a JavaScript app: jsconfig.json is its tsconfig
    "apps/js/jsconfig.json": { compilerOptions: { paths: { "@/*": ["./src/*"] } } },
    "apps/js/src/lib/auth.js": "", "apps/js/src/page.jsx": "",
    // baseUrl + specificity + exact patterns; "@app/*" and "lib/*" look like package names
    "apps/api/tsconfig.json": { compilerOptions: { baseUrl: "./src", paths: { "~/*": ["*"], "~/gen/*": ["../generated/*", "fallback/*"], config: ["config/index.ts"], "@app/*": ["*"], "lib/*": ["../lib/*"] } } },
    "apps/api/src/util/log.ts": "", "apps/api/src/gen/x.ts": "", "apps/api/generated/x.ts": "", "apps/api/src/fallback/y.ts": "",
    "apps/api/src/config/index.ts": "", "apps/api/src/main.ts": "", "apps/api/src/constants.ts": "", "apps/api/lib/real.ts": "",
    // the catch-all "*" maps packages too, so a miss there is still a package
    "apps/star/tsconfig.json": { compilerOptions: { paths: { "*": ["./src/*", "./node_modules/*"] } } },
    "apps/star/src/main.ts": "", "apps/star/src/local/thing.ts": "",
    // extends: relative, inherited, overridden, and a loop
    "tsconfig.base.json": { compilerOptions: { paths: { "#shared/*": ["./shared/*"] } } },
    "shared/thing.ts": "",
    "packages/kid/tsconfig.json": { extends: "../../tsconfig.base.json", compilerOptions: { outDir: "dist" } },
    "packages/kid/src/k.ts": "",
    "packages/own/tsconfig.json": { extends: ["../../tsconfig.base"], compilerOptions: { paths: { "own/*": ["./src/*"] } } },
    "packages/own/src/o.ts": "",
    "packages/loop/tsconfig.json": { extends: "./tsconfig.json", compilerOptions: { paths: { "l/*": ["./src/*"] } } },
    "packages/loop/src/l.ts": "",
    // a workspace package that ships a config
    "tooling/tsconfig/package.json": { name: "@repo/tsconfig" },
    "tooling/tsconfig/base.json": { compilerOptions: { baseUrl: "../.." } },
    "packages/viapkg/tsconfig.json": { extends: "@repo/tsconfig/base.json" },
    "packages/viapkg/src/v.ts": "",
  };
  const resolve = resolverOf(tree);

  it('gives two apps their own "@/*"', () => {
    expect(resolve("apps/web/src/app/page.tsx", "@/lib/auth")).toEqual(file("apps/web/src/lib/auth.ts"));
    expect(resolve("apps/web/src/app/deep/nested/page.tsx", "@/lib/auth")).toEqual(file("apps/web/src/lib/auth.ts"));
    expect(resolve("apps/horse/app/page.tsx", "@/lib/auth")).toEqual(file("apps/horse/lib/auth.ts"));
    expect(resolve("apps/horse/app/page.tsx", "@/lib/auth.js")).toEqual(file("apps/horse/lib/auth.ts"));
  });
  it("leaves an alias nothing maps unresolved instead of calling it a package", () => {
    expect(resolve("packages/plain/src/x.ts", "@/lib/auth")).toEqual(UNRESOLVED);
    expect(resolve("apps/web/src/app/page.tsx", "@/lib/missing")).toEqual(UNRESOLVED);
    expect(resolve("packages/plain/src/x.ts", "~/x")).toEqual(UNRESOLVED);
  });
  it("leaves a mapped-but-missing target unresolved even when the alias looks like a package; the catch-all still falls through", () => {
    expect(resolve("apps/api/src/main.ts", "@app/util/log")).toEqual(file("apps/api/src/util/log.ts"));
    expect(resolve("apps/api/src/main.ts", "lib/real")).toEqual(file("apps/api/lib/real.ts"));
    expect(resolve("apps/api/src/main.ts", "@app/generated/client")).toEqual(UNRESOLVED); // gitignored output, not an npm package
    expect(resolve("apps/api/src/main.ts", "lib/missing")).toEqual(UNRESOLVED);
    expect(resolve("apps/api/src/main.ts", "zod")).toEqual(external("zod")); // no rule matched: a package
    expect(resolve("apps/star/src/main.ts", "local/thing")).toEqual(file("apps/star/src/local/thing.ts"));
    expect(resolve("apps/star/src/main.ts", "react")).toEqual(external("react"));
  });
  it("substitutes a star capture containing $ literally", () => {
    expect(resolve("apps/web/src/app/page.tsx", "@/routes/$id")).toEqual(file("apps/web/src/routes/$id.tsx"));
    expect(resolve("apps/web/src/app/page.tsx", "@/routes/$$")).toEqual(file("apps/web/src/routes/$$.tsx"));
    expect(resolve("apps/web/src/app/page.tsx", "@/routes/a$&b")).toEqual(file("apps/web/src/routes/a$&b.ts"));
  });
  it("falls back to jsconfig.json for a JavaScript app", () => {
    expect(resolve("apps/js/src/page.jsx", "@/lib/auth")).toEqual(file("apps/js/src/lib/auth.js"));
  });
  it("resolves paths against baseUrl, most specific pattern first, then baseUrl itself", () => {
    expect(resolve("apps/api/src/main.ts", "~/util/log")).toEqual(file("apps/api/src/util/log.ts"));
    expect(resolve("apps/api/src/main.ts", "~/gen/x")).toEqual(file("apps/api/generated/x.ts")); // "~/gen/*" beats "~/*"
    expect(resolve("apps/api/src/main.ts", "~/gen/y")).toEqual(file("apps/api/src/fallback/y.ts")); // second target
    expect(resolve("apps/api/src/main.ts", "config")).toEqual(file("apps/api/src/config/index.ts"));
    expect(resolve("apps/api/src/main.ts", "util/log")).toEqual(file("apps/api/src/util/log.ts"));
    expect(resolve("apps/api/src/main.ts", "constants")).toEqual(file("apps/api/src/constants.ts")); // not node:constants
  });
  it("follows extends (relative, array, workspace package); a child's paths replace the parent's; a loop ends", () => {
    expect(resolve("packages/kid/src/k.ts", "#shared/thing")).toEqual(file("shared/thing.ts"));
    expect(resolve("packages/own/src/o.ts", "own/o")).toEqual(file("packages/own/src/o.ts"));
    expect(resolve("packages/own/src/o.ts", "#shared/thing")).toEqual(UNRESOLVED);
    expect(resolve("packages/loop/src/l.ts", "l/l")).toEqual(file("packages/loop/src/l.ts"));
    expect(resolve("packages/viapkg/src/v.ts", "shared/thing")).toEqual(file("shared/thing.ts"));
  });
  it("caches bare specifiers per nearest config, not per directory and not globally", () => {
    const a = resolve("apps/web/src/app/page.tsx", "@/lib/auth");
    expect(resolve("apps/web/src/app/deep/nested/page.tsx", "@/lib/auth")).toBe(a);
    expect(resolve("apps/horse/app/page.tsx", "@/lib/auth")).not.toBe(a);
  });
});

describe("resolver: workspace packages", () => {
  const resolve = resolverOf({
    "apps/web/src/page.ts": "",
    // exports as a string, straight at source
    "packages/api/package.json": { name: "@acme/api", exports: { ".": "./src/index.ts" } },
    "packages/api/src/index.ts": "",
    // conditions + subpaths + patterns + a blocked subpath
    "packages/ai/package.json": {
      name: "@acme/ai",
      exports: {
        ".": { types: "./src/index.ts", production: "./dist/index.js", default: "./src/index.ts" },
        "./pricing": { production: "./dist/pricing.js", import: { types: "./src/pricing.ts" } },
        "./providers/*": "./src/providers/*.ts",
        "./features/*.js": { default: "./src/features/*.ts" },
        "./internal/*": null,
      },
    },
    "packages/ai/src/index.ts": "", "packages/ai/src/pricing.ts": "", "packages/ai/src/providers/openai.ts": "",
    "packages/ai/src/features/chat.ts": "", "packages/ai/src/internal/secret.ts": "", "packages/ai/scripts/tool.ts": "",
    // dist exports, inverted through the package's own tsconfig (rootDir "." keeps the src/ segment in dist)
    "packages/db/package.json": {
      name: "@acme/db",
      exports: {
        ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" },
        "./content-scope": { types: "./dist/src/access/content-scope.d.ts", default: "./dist/src/access/content-scope.js" },
      },
    },
    "packages/db/tsconfig.json": `{ "compilerOptions": { "outDir": "./dist", "rootDir": ".", }, }`,
    "packages/db/src/index.ts": "", "packages/db/src/access/content-scope.ts": "",
    "apps/backend/package.json": { name: "@acme/backend", main: "./dist/index.js", exports: { ".": { types: "./dist/exports.d.ts", default: "./dist/exports.js" } } },
    "apps/backend/tsconfig.json": { compilerOptions: { outDir: "./dist", rootDir: "." } },
    "apps/backend/index.ts": "", "apps/backend/exports.ts": "",
    // dist main/types with no exports and no tsconfig: dist → src by convention, .tsx included
    "packages/shared/package.json": { name: "@acme/shared", main: "./dist/entry.js", types: "./dist/entry.d.ts" },
    "packages/shared/src/entry.tsx": "", "packages/shared/src/index.ts": "", "packages/shared/src/deep/thing.ts": "",
    // types points at a .d.ts that is generated beside its source
    "packages/redis/package.json": { name: "@acme/redis", exports: { ".": { types: "./src/index.d.ts", default: "./dist/index.js" } } },
    "packages/redis/src/index.ts": "",
    // dist is checked in: take it as written
    "packages/built/package.json": { name: "built", main: "dist/index.js" },
    "packages/built/dist/index.js": "", "packages/built/src/index.ts": "",
    // the entry names the output DIRECTORY
    "packages/dir1/package.json": { name: "dir1", main: "dist" }, "packages/dir1/src/index.ts": "",
    "packages/dir2/package.json": { name: "dir2", main: "./dist/" }, "packages/dir2/src/index.tsx": "",
    "packages/dir3/package.json": { name: "dir3", exports: { ".": "./dist" } }, "packages/dir3/src/index.ts": "",
    "packages/dir4/package.json": { name: "dir4", main: "./out" }, "packages/dir4/out/index.js": "", "packages/dir4/src/index.ts": "", // checked in: as written
    // outDir / rootDir that no convention would guess, read from the package's own tsconfig
    "packages/custom/package.json": { name: "custom", exports: { ".": "./compiled/main.js", "./sub/*": "./compiled/sub/*.js" } },
    "packages/custom/tsconfig.json": { compilerOptions: { outDir: "./compiled", rootDir: "./lib" } },
    "packages/custom/lib/main.ts": "", "packages/custom/lib/sub/x.tsx": "", "packages/custom/src/main.ts": "",
    // every condition target exists as written: the order we trust decides
    "packages/cond/package.json": { name: "cond", exports: { ".": { require: "./cjs/index.cjs", default: "./esm/index.js", import: "./src/index.ts" } } },
    "packages/cond/cjs/index.cjs": "", "packages/cond/esm/index.js": "", "packages/cond/src/index.ts": "",
    // types and main both exist and differ; typings-only and module-only packages
    "packages/typed/package.json": { name: "typed", main: "./main.js", types: "./types/index.d.ts" },
    "packages/typed/main.js": "", "packages/typed/types/index.d.ts": "",
    "packages/typings/package.json": { name: "typings", typings: "./api.d.ts" }, "packages/typings/api.ts": "",
    "packages/esm/package.json": { name: "esm", module: "./esm/index.js" }, "packages/esm/esm/index.js": "",
    // a "$" in the star capture of an exports pattern
    "packages/dollar/package.json": { name: "dollar", exports: { "./*": "./src/*.ts" } }, "packages/dollar/src/$$x.ts": "",
    // exports as a bare string; no entry at all
    "packages/str/package.json": { name: "str", exports: "./main.ts" },
    "packages/str/main.ts": "",
    "packages/bare/package.json": { name: "bare" },
    "packages/bare/index.ts": "", "packages/bare/lib/util.ts": "",
    // the shallowest manifest owns a duplicated name
    "packages/dup/package.json": { name: "dup", exports: "./a.ts" },
    "packages/dup/a.ts": "",
    "packages/dup/examples/copy/package.json": { name: "dup", exports: "./b.ts" },
    "packages/dup/examples/copy/b.ts": "",
    "package.json": { name: "root", private: true },
  });
  const from = "apps/web/src/page.ts";

  it("honours exports: string, conditions, subpaths and patterns", () => {
    expect(resolve(from, "@acme/api")).toEqual(file("packages/api/src/index.ts"));
    expect(resolve(from, "@acme/ai")).toEqual(file("packages/ai/src/index.ts"));
    expect(resolve(from, "@acme/ai/pricing")).toEqual(file("packages/ai/src/pricing.ts")); // nested condition; dist/pricing.js is not there
    expect(resolve(from, "@acme/ai/providers/openai")).toEqual(file("packages/ai/src/providers/openai.ts"));
    expect(resolve(from, "@acme/ai/features/chat.js")).toEqual(file("packages/ai/src/features/chat.ts"));
    expect(resolve(from, "str")).toEqual(file("packages/str/main.ts"));
  });
  it("takes an unlisted subpath as written, never guesses, and never calls a workspace package external", () => {
    expect(resolve(from, "@acme/ai/scripts/tool")).toEqual(file("packages/ai/scripts/tool.ts"));
    expect(resolve(from, "@acme/ai/internal/secret")).toEqual(UNRESOLVED); // blocked with null, and not at that path either
    expect(resolve(from, "@acme/ai/nowhere")).toEqual(UNRESOLVED);
  });
  it("inverts dist → src: by the package's outDir/rootDir, by convention, and for a .d.ts beside its source", () => {
    expect(resolve(from, "@acme/db")).toEqual(file("packages/db/src/index.ts"));
    expect(resolve(from, "@acme/db/content-scope")).toEqual(file("packages/db/src/access/content-scope.ts"));
    expect(resolve(from, "@acme/backend")).toEqual(file("apps/backend/exports.ts")); // rootDir ".": not src/, and not index.ts
    expect(resolve(from, "@acme/shared")).toEqual(file("packages/shared/src/entry.tsx"));
    expect(resolve(from, "@acme/shared/dist/deep/thing")).toEqual(file("packages/shared/src/deep/thing.ts"));
    expect(resolve(from, "@acme/shared/dist/deep/thing.js")).toEqual(file("packages/shared/src/deep/thing.ts"));
    expect(resolve(from, "@acme/redis")).toEqual(file("packages/redis/src/index.ts"));
    expect(resolve(from, "built")).toEqual(file("packages/built/dist/index.js"));
    expect(resolve(from, "custom")).toEqual(file("packages/custom/lib/main.ts")); // not src/main.ts: the tsconfig says lib/
    expect(resolve(from, "custom/sub/x")).toEqual(file("packages/custom/lib/sub/x.tsx"));
  });
  it("inverts an entry that names the output directory itself", () => {
    expect(resolve(from, "dir1")).toEqual(file("packages/dir1/src/index.ts"));
    expect(resolve(from, "dir2")).toEqual(file("packages/dir2/src/index.tsx"));
    expect(resolve(from, "dir3")).toEqual(file("packages/dir3/src/index.ts"));
    expect(resolve(from, "dir4")).toEqual(file("packages/dir4/out/index.js"));
  });
  it("trusts conditions import > types > default > require, and types > typings > module > main", () => {
    expect(resolve(from, "cond")).toEqual(file("packages/cond/src/index.ts"));
    expect(resolve(from, "typed")).toEqual(file("packages/typed/types/index.d.ts"));
    expect(resolve(from, "typings")).toEqual(file("packages/typings/api.ts"));
    expect(resolve(from, "esm")).toEqual(file("packages/esm/esm/index.js"));
  });
  it("substitutes a star capture containing $ literally", () => {
    expect(resolve(from, "dollar/$$x")).toEqual(file("packages/dollar/src/$$x.ts"));
  });
  it("falls back to main-less packages and plain subpaths", () => {
    expect(resolve(from, "bare")).toEqual(file("packages/bare/index.ts"));
    expect(resolve(from, "bare/lib/util")).toEqual(file("packages/bare/lib/util.ts"));
    expect(resolve(from, "dup")).toEqual(file("packages/dup/a.ts"));
  });
  it('resolves "#imports" through the package.json that scopes the importing file', () => {
    const r = resolverOf({
      "pkg/package.json": { name: "pkg", imports: { "#db": "./src/db.ts", "#util/*": { default: "./dist/util/*.js" }, "#dep": "lodash" } },
      "pkg/src/db.ts": "", "pkg/src/util/time.ts": "", "pkg/src/deep/x.ts": "", "other/y.ts": "",
    });
    expect(r("pkg/src/deep/x.ts", "#db")).toEqual(file("pkg/src/db.ts"));
    expect(r("pkg/src/deep/x.ts", "#util/time")).toEqual(file("pkg/src/util/time.ts")); // pattern + dist → src
    expect(r("pkg/src/deep/x.ts", "#dep")).toEqual(external("lodash"));
    expect(r("pkg/src/deep/x.ts", "#nope")).toEqual(UNRESOLVED);
    expect(r("other/y.ts", "#db")).toEqual(UNRESOLVED);
  });
});

describe("resolver: externals and python", () => {
  const resolve = resolverOf({
    "src/a.ts": "",
    "svc/src/main.py": "", "svc/src/gcs.py": "", "svc/src/lib/__init__.py": "", "svc/src/lib/io.py": "", "svc/src/lib/deep/x.py": "",
    "svc/tests/test_gcs.py": "", "tools/__init__.py": "", "tools/fmt.py": "",
  });
  it("names the package, scope included, and folds builtins under node:", () => {
    expect(resolve("src/a.ts", "react")).toEqual(external("react"));
    expect(resolve("src/a.ts", "better-auth/plugins")).toEqual(external("better-auth"));
    expect(resolve("src/a.ts", "@better-auth/cimd/node")).toEqual(external("@better-auth/cimd"));
    expect(resolve("src/a.ts", "lodash.debounce")).toEqual(external("lodash.debounce"));
    expect(resolve("src/a.ts", "node:fs/promises")).toEqual(external("node:fs"));
    expect(resolve("src/a.ts", "fs/promises")).toEqual(external("node:fs"));
    expect(resolve("src/a.ts", "path")).toEqual(external("node:path"));
    expect(resolve("src/a.ts", "bun:test")).toEqual(external("bun:test"));
    expect(resolve("src/a.ts", "/abs/path")).toEqual(UNRESOLVED);
    expect(resolve("src/a.ts", "")).toEqual(UNRESOLVED);
  });
  it("resolves python dotted specs best-effort: importing dir upward, src/ on the way, relative dots", () => {
    expect(resolve("svc/src/main.py", "gcs")).toEqual(file("svc/src/gcs.py"));
    expect(resolve("svc/src/main.py", "lib.io")).toEqual(file("svc/src/lib/io.py"));
    expect(resolve("svc/src/main.py", "lib")).toEqual(file("svc/src/lib/__init__.py"));
    expect(resolve("svc/tests/test_gcs.py", "gcs")).toEqual(file("svc/src/gcs.py")); // sys.path hack: <pkg>/src
    expect(resolve("svc/src/main.py", "tools.fmt")).toEqual(file("tools/fmt.py")); // repo root
    expect(resolve("svc/src/lib/deep/x.py", "..io")).toEqual(file("svc/src/lib/io.py"));
    expect(resolve("svc/src/lib/io.py", ".")).toEqual(file("svc/src/lib/__init__.py"));
    expect(resolve("svc/src/lib/io.py", ".missing")).toEqual(UNRESOLVED);
    expect(resolve("svc/src/main.py", "google.cloud.storage")).toEqual(external("google"));
  });
});

// ---- graph ---------------------------------------------------------------------

const imp = (spec: string, names: string[] = [], more: Partial<ImportFact> = {}): ImportFact => ({ spec, names, how: "import", typeOnly: false, line: 1, ...more });
const reexport = (spec: string, names: string[] = ["*"], as?: string[]): ImportFact => ({ ...imp(spec, names, { how: "reexport" }), ...(as ? { as } : {}) });
const facts = (imports: ImportFact[], exported: string[] = []): FileFacts => ({
  ...emptyFacts(),
  imports,
  decls: exported.map((name, i) => ({ name, kind: "const", exported: true, line: i + 1 })),
});
/** Facts keyed by path; every path exists for the resolver, plus whatever `extra` adds (manifests, assets). */
function graphOf(tree: Record<string, FileFacts>, extra: Record<string, string | object> = {}, options?: GraphOptions): CodeGraph {
  const host = hostOf({ ...Object.fromEntries(Object.keys(tree).map((p) => [p, ""])), ...extra });
  return buildGraph(new Map(Object.entries(tree)), createResolver(host), options);
}
const edge = (g: CodeGraph, from: string, to: string) => g.out.get(from)?.find((e) => e.to === to);
const targets = (g: CodeGraph, from: string) => (g.out.get(from) ?? []).map((e) => e.to);

describe("buildGraph", () => {
  it("builds out/in edges, the file list, externals and unresolved from facts alone", () => {
    const g = graphOf(
      {
        "src/a.ts": facts([imp("./b", ["b"], { line: 3 }), imp("./styles.css", [], { line: 1 }), imp("zod", ["z"], { line: 2 }), imp("./gone", ["x"], { line: 4 })]),
        "src/b.ts": facts([imp("./a", [], { how: "dynamic" })], ["b"]),
        "README.md": facts([]),
      },
      { "src/styles.css": "" },
    );
    expect(g.files).toEqual(["README.md", "src/a.ts", "src/b.ts", "src/styles.css"]);
    expect(g.out.get("src/a.ts")).toEqual([
      { from: "src/a.ts", to: "src/styles.css", names: [], typeOnly: false, how: "import", line: 1 },
      { from: "src/a.ts", to: "src/b.ts", names: ["b"], typeOnly: false, how: "import", line: 3 },
    ]);
    expect(g.in.get("src/a.ts")).toEqual([{ from: "src/b.ts", to: "src/a.ts", names: [], typeOnly: false, how: "dynamic", line: 1 }]);
    expect(g.external.get("src/a.ts")).toEqual([{ pkg: "zod", spec: "zod", names: ["z"], line: 2 }]);
    expect(g.unresolved).toEqual([{ from: "src/a.ts", spec: "./gone" }]);
    expect(g.out.has("README.md")).toBe(false);
    expect(g.buildMs).toBeGreaterThanOrEqual(0);
  });

  it("lists an unresolved specifier once per file, and survives any specifier the extractor emits", () => {
    const g = graphOf({
      "src/a.ts": facts([imp("./gone", ["x"]), imp("./gone", ["y"], { line: 2 }), imp("./gone", [], { how: "dynamic", line: 3 }), imp("./x.cjsx", [], { line: 4 }), imp('", "', [], { line: 5 }), imp("./b", ["b"], { line: 6 })]),
      "src/b.ts": facts([], ["b"]),
    });
    expect(g.unresolved).toEqual([{ from: "src/a.ts", spec: "./gone" }, { from: "src/a.ts", spec: "./x.cjsx" }, { from: "src/a.ts", spec: '", "' }]);
    expect(targets(g, "src/a.ts")).toEqual(["src/b.ts"]);
  });

  it("lands a named import on the defining file: star, named and renamed re-exports", () => {
    const g = graphOf({
      "app.ts": facts([imp("./barrel", ["prisma", "hasAccess", "b", "ns"], { line: 7 })]),
      "barrel/index.ts": facts([reexport("./client", ["prisma"]), reexport("./access"), reexport("./x", ["a"], ["b"]), reexport("./space", ["*"], ["ns"])]),
      "barrel/client.ts": facts([], ["prisma"]),
      "barrel/access.ts": facts([], ["hasAccess"]),
      "barrel/x.ts": facts([], ["a"]),
      "barrel/space.ts": facts([], ["s"]),
    });
    const via = "barrel/index.ts";
    expect(edge(g, "app.ts", "barrel/client.ts")).toEqual({ from: "app.ts", to: "barrel/client.ts", names: ["prisma"], typeOnly: false, how: "import", line: 7, via });
    expect(edge(g, "app.ts", "barrel/access.ts")).toMatchObject({ names: ["hasAccess"], via });
    expect(edge(g, "app.ts", "barrel/x.ts")).toMatchObject({ names: ["a"], via }); // as x.ts exports it, not as the barrel renamed it
    expect(edge(g, "app.ts", "barrel/space.ts")).toMatchObject({ names: ["*"], via });
    expect(edge(g, "app.ts", "barrel/index.ts")).toBeUndefined();
    expect(fanIn(g, "barrel/index.ts")).toBe(0);
    // the barrel's own pass-through edges are still there
    expect(targets(g, "barrel/index.ts")).toEqual(["barrel/access.ts", "barrel/client.ts", "barrel/space.ts", "barrel/x.ts"]);
    expect(edge(g, "barrel/index.ts", "barrel/access.ts")).toMatchObject({ how: "reexport", names: ["*"] });
  });

  it("keeps what cannot be chased on the barrel: default, namespace, unknown names, names the barrel declares or takes from a package", () => {
    const g = graphOf({
      "app.ts": facts([imp("./barrel", ["default", "mystery", "own", "z", "found"]), imp("./barrel", ["*"], { line: 2 })]),
      "barrel.ts": facts([reexport("./x"), reexport("zod", ["z"])], ["own"]),
      "x.ts": facts([], ["found", "default"]),
    });
    expect(edge(g, "app.ts", "barrel.ts")).toMatchObject({ names: ["default", "mystery", "own", "z", "*"] });
    expect(edge(g, "app.ts", "barrel.ts")?.via).toBeUndefined();
    expect(edge(g, "app.ts", "x.ts")).toMatchObject({ names: ["found"], via: "barrel.ts" });
  });

  it("chases only a plain `export *`: a namespace re-export carries its own name, not its members", () => {
    const g = graphOf({
      "app.ts": facts([imp("./barrel", ["s", "ns"])]),
      "barrel.ts": facts([reexport("./space", ["*"], ["ns"]), reexport("./real")]),
      "space.ts": facts([], ["s"]),
      "real.ts": facts([], ["s"]),
    });
    expect(edge(g, "app.ts", "real.ts")).toMatchObject({ names: ["s"], via: "barrel.ts" });
    expect(edge(g, "app.ts", "space.ts")).toMatchObject({ names: ["*"], via: "barrel.ts" });
  });

  it("lets an explicit `export { x } from` outrank a decl of the same name, which a regex extractor may invent", () => {
    const g = graphOf({
      "app.ts": facts([imp("./barrel", ["x", "y"])]),
      "barrel.ts": facts([reexport("./impl", ["x"])], ["x", "y"]),
      "impl.ts": facts([], ["x"]),
    });
    expect(edge(g, "app.ts", "impl.ts")).toMatchObject({ names: ["x"], via: "barrel.ts" });
    expect(edge(g, "app.ts", "barrel.ts")).toMatchObject({ names: ["y"] });
  });

  it("follows an explicit default re-export, and import-then-export", () => {
    const g = graphOf({
      "app.tsx": facts([imp("./components", ["Button", "theme"]), imp("./components", ["default"], { line: 2 })]),
      "components/index.ts": facts([reexport("./Button", ["default"], ["Button"]), reexport("./Main", ["default"]), imp("./theme", ["theme"]), imp("react", ["useState"])]),
      "components/Button.tsx": facts([], ["Button"]),
      "components/Main.tsx": facts([], ["Main"]),
      "components/theme.ts": facts([], ["theme"]),
    });
    expect(edge(g, "app.tsx", "components/Button.tsx")).toMatchObject({ names: ["default"], via: "components/index.ts" });
    expect(edge(g, "app.tsx", "components/Main.tsx")).toMatchObject({ names: ["default"], via: "components/index.ts" });
    expect(edge(g, "app.tsx", "components/theme.ts")).toMatchObject({ names: ["theme"], via: "components/index.ts" });
  });

  it("takes an import as the lead only when no `export *` also carries the name (the import may be private)", () => {
    // facts carry no local export list, so `import { x } from "./helper"` + `export * from "./real"` is read as the star
    const g = graphOf({
      "app.ts": facts([imp("./barrel", ["x", "y"])]),
      "barrel.ts": facts([imp("./helper", ["x", "y"]), reexport("./real")]),
      "helper.ts": facts([], ["x", "y"]),
      "real.ts": facts([], ["x"]),
    });
    expect(edge(g, "app.ts", "real.ts")).toMatchObject({ names: ["x"], via: "barrel.ts" });
    expect(edge(g, "app.ts", "helper.ts")).toMatchObject({ names: ["y"], via: "barrel.ts" }); // no star carries y: the import is the lead
  });

  it("chases nested barrels to the end and reports the barrel the statement named", () => {
    const g = graphOf({
      "app.ts": facts([imp("./a", ["deep", "renamed"])]),
      "a/index.ts": facts([reexport("./b")]),
      "a/b/index.ts": facts([reexport("./c", ["deep"]), reexport("./c", ["inner"], ["renamed"])]),
      "a/b/c/index.ts": facts([reexport("./impl")]),
      "a/b/c/impl.ts": facts([], ["deep", "inner"]),
    });
    expect(g.out.get("app.ts")).toEqual([{ from: "app.ts", to: "a/b/c/impl.ts", names: ["deep", "inner"], typeOnly: false, how: "import", line: 1, via: "a/index.ts" }]);
    // a barrel's own named re-exports are chased too
    expect(g.out.get("a/b/index.ts")).toEqual([{ from: "a/b/index.ts", to: "a/b/c/impl.ts", names: ["deep", "inner"], typeOnly: false, how: "reexport", line: 1, via: "a/b/c/index.ts" }]);
  });

  it("gives every importer the same answer whatever the facts order, when a cycle or the depth limit cuts a chase", () => {
    const both = (tree: Record<string, FileFacts>, first: string, second: string) =>
      [[first, second], [second, first]].map(([a, b]) => {
        const g = graphOf({ [a]: tree[a], [b]: tree[b], ...tree });
        return [first, second].map((f) => (g.out.get(f) ?? []).map((e) => `${e.to}{${e.names}}${e.via ? ` via ${e.via}` : ""}`).join(" "));
      });
    // a → b (explicit), b → a | c (stars): x lives in c.ts whichever barrel is asked first
    const cycle: Record<string, FileFacts> = {
      "one.ts": facts([imp("./a", ["x"])]),
      "two.ts": facts([imp("./b", ["x"])]),
      "a.ts": facts([reexport("./b", ["x"])]),
      "b.ts": facts([reexport("./a"), reexport("./c")]),
      "c.ts": facts([], ["x"]),
    };
    expect(both(cycle, "one.ts", "two.ts")).toEqual([["c.ts{x} via a.ts", "c.ts{x} via b.ts"], ["c.ts{x} via a.ts", "c.ts{x} via b.ts"]]);
    // a 12-hop named chain: app.ts is cut at the depth limit and stays on its barrel; mid.ts is 6 hops away and must not inherit the cut
    const chain: Record<string, FileFacts> = { "app.ts": facts([imp("./c0", ["x"])]), "mid.ts": facts([imp("./c6", ["x"])]), "c12.ts": facts([], ["x"]) };
    for (let i = 0; i < 12; i++) chain[`c${i}.ts`] = facts([reexport(`./c${i + 1}`, ["x"])]);
    expect(both(chain, "app.ts", "mid.ts")).toEqual([["c0.ts{x}", "c12.ts{x} via c6.ts"], ["c0.ts{x}", "c12.ts{x} via c6.ts"]]);
    // f is one hop below both X and Y; asked through X it runs into X again and finds nothing, asked through
    // Y it reaches X's other star and finds h: the first answer must not be remembered for the second asker
    const lattice: Record<string, FileFacts> = {
      "one.ts": facts([imp("./X", ["x"])]),
      "two.ts": facts([imp("./Y", ["x"])]),
      "X.ts": facts([reexport("./f"), reexport("./h")]),
      "Y.ts": facts([reexport("./f")]),
      "f.ts": facts([reexport("./g")]),
      "g.ts": facts([reexport("./X")]),
      "h.ts": facts([], ["x"]),
    };
    expect(both(lattice, "one.ts", "two.ts")).toEqual([["h.ts{x} via X.ts", "h.ts{x} via Y.ts"], ["h.ts{x} via X.ts", "h.ts{x} via Y.ts"]]);
  });

  it("survives re-export cycles, and a cut cycle does not poison a later lookup", () => {
    const g = graphOf({
      "one.ts": facts([imp("./a", ["x", "ghost"])]),
      "two.ts": facts([imp("./b", ["x", "ghost"])]),
      "a.ts": facts([reexport("./b"), reexport("./c")]),
      "b.ts": facts([reexport("./a")]),
      "c.ts": facts([], ["x"]),
      "p.ts": facts([imp("./q", ["loop"])]),
      "q.ts": facts([reexport("./r", ["loop"])]),
      "r.ts": facts([reexport("./q", ["loop"])]),
    });
    expect(edge(g, "one.ts", "c.ts")).toMatchObject({ names: ["x"], via: "a.ts" });
    expect(edge(g, "two.ts", "c.ts")).toMatchObject({ names: ["x"], via: "b.ts" }); // b → a → (b cut) → c
    expect(edge(g, "one.ts", "a.ts")).toMatchObject({ names: ["ghost"] });
    expect(edge(g, "two.ts", "b.ts")).toMatchObject({ names: ["ghost"] });
    expect(targets(g, "p.ts")).toHaveLength(1); // wherever it lands, it lands once and returns
  });

  it("stops at the depth limit and leaves the edge on the barrel", () => {
    const chain: Record<string, FileFacts> = { "app.ts": facts([imp("./b0", ["far", "near"])]), "b10.ts": facts([], ["far"]) };
    for (let i = 0; i < 10; i++) chain[`b${i}.ts`] = facts([reexport(`./b${i + 1}`)], i === 3 ? ["near"] : []);
    const g = graphOf(chain);
    expect(edge(g, "app.ts", "b0.ts")).toMatchObject({ names: ["far"] });
    expect(edge(g, "app.ts", "b3.ts")).toMatchObject({ names: ["near"], via: "b0.ts" });
  });

  it("merges duplicate (from, to) edges: names unioned, type-only only if all are, strongest how, first line, via only if every route had one", () => {
    const g = graphOf({
      "a.ts": facts([
        imp("./types", ["T"], { typeOnly: true, line: 9 }),
        imp("./types", ["U", "T"], { typeOnly: true, line: 4 }),
        imp("./b", ["B"], { typeOnly: true, line: 5 }),
        imp("./b", [], { how: "dynamic", line: 2 }),
        reexport("./b", ["b"]),
        imp("./barrel", ["c1"], { line: 6 }),
        imp("./c", ["c2"], { line: 7 }),
        imp("./barrel", ["d1"], { line: 8 }),
        imp("./barrel2", ["d2"], { line: 3 }),
      ]),
      "types.ts": facts([], ["T", "U"]),
      "b.ts": facts([], ["b", "B"]),
      "barrel.ts": facts([reexport("./c"), reexport("./d")]),
      "barrel2.ts": facts([reexport("./d")]),
      "c.ts": facts([], ["c1", "c2"]),
      "d.ts": facts([], ["d1", "d2"]),
    });
    expect(edge(g, "a.ts", "types.ts")).toEqual({ from: "a.ts", to: "types.ts", names: ["T", "U"], typeOnly: true, how: "import", line: 4 });
    expect(edge(g, "a.ts", "b.ts")).toEqual({ from: "a.ts", to: "b.ts", names: ["B", "b"], typeOnly: false, how: "import", line: 1 });
    expect(edge(g, "a.ts", "c.ts")).toEqual({ from: "a.ts", to: "c.ts", names: ["c1", "c2"], typeOnly: false, how: "import", line: 6 });
    expect(edge(g, "a.ts", "d.ts")).toEqual({ from: "a.ts", to: "d.ts", names: ["d1", "d2"], typeOnly: false, how: "import", line: 3, via: "barrel.ts" });
    expect(fanOut(g, "a.ts")).toBe(4);
    expect(fanIn(g, "b.ts")).toBe(1);
  });

  it("chases across workspace packages through dist → src", () => {
    const g = graphOf(
      {
        "apps/api/src/route.ts": facts([imp("@acme/db", ["prisma", "hasMemberAccess", "Prisma"]), imp("@acme/db/auth", ["auth"], { line: 2 })]),
        "packages/db/src/index.ts": facts([reexport("../generated/client"), reexport("./access")], ["prisma"]),
        "packages/db/src/access/index.ts": facts([reexport("./member.js", ["hasMemberAccess"])]),
        "packages/db/src/access/member.ts": facts([imp("../index.js", ["prisma"])], ["hasMemberAccess"]),
        "packages/db/src/auth.ts": facts([], ["auth"]),
      },
      {
        "packages/db/package.json": { name: "@acme/db", exports: { ".": { types: "./dist/src/index.d.ts" }, "./auth": { types: "./dist/src/auth.d.ts" } } },
        "packages/db/tsconfig.json": { compilerOptions: { outDir: "./dist", rootDir: "." } },
      },
    );
    expect(g.out.get("apps/api/src/route.ts")).toEqual([
      { from: "apps/api/src/route.ts", to: "packages/db/src/access/member.ts", names: ["hasMemberAccess"], typeOnly: false, how: "import", line: 1, via: "packages/db/src/index.ts" },
      { from: "apps/api/src/route.ts", to: "packages/db/src/index.ts", names: ["prisma", "Prisma"], typeOnly: false, how: "import", line: 1 }, // prisma is declared there; Prisma comes from untracked generated code
      { from: "apps/api/src/route.ts", to: "packages/db/src/auth.ts", names: ["auth"], typeOnly: false, how: "import", line: 2 },
    ]);
    expect(g.unresolved).toEqual([{ from: "packages/db/src/index.ts", spec: "../generated/client" }]);
    expect(neighbours(g, "packages/db/src/index.ts", "in")).toEqual(["apps/api/src/route.ts", "packages/db/src/access/member.ts"]);
  });

  it("never draws a self-edge, and can leave barrels alone", () => {
    const tree = {
      "lib/index.ts": facts([reexport("./impl")]),
      "lib/impl.ts": facts([imp("./index", ["helper", "other"])], ["helper"]),
      "lib/other.ts": facts([], ["other"]),
    };
    const g = graphOf(tree);
    expect(edge(g, "lib/impl.ts", "lib/impl.ts")).toBeUndefined();
    expect(edge(g, "lib/impl.ts", "lib/index.ts")).toMatchObject({ names: ["helper", "other"] });
    const flat = graphOf({ ...tree, "app.ts": facts([imp("./lib", ["helper"])]) }, {}, { chaseBarrels: false });
    expect(edge(flat, "app.ts", "lib/index.ts")).toMatchObject({ names: ["helper"] });
    expect(edge(graphOf({ ...tree, "app.ts": facts([imp("./lib", ["helper"])]) }), "app.ts", "lib/impl.ts")).toMatchObject({ via: "lib/index.ts" });
  });
});

describe("graph helpers", () => {
  const g = graphOf({
    "packages/db/src/auth-horse.ts": facts(
      [
        imp("better-auth", ["betterAuth"], { line: 18 }),
        imp("better-auth/plugins", ["admin", "bearer", "jwt"], { line: 20 }),
        imp("better-auth/plugins", ["Plugin"], { line: 21, typeOnly: true }),
        imp("node:crypto", ["randomUUID"], { line: 22 }),
        imp("./auth-base", ["baseAuthOptions"], { line: 25 }),
        imp("./horse-urls", ["horseApiOrigin"], { line: 26 }),
      ],
      ["horseAuth"],
    ),
    "packages/db/src/auth-base.ts": facts([imp("better-auth/plugins/organization", ["organization"])], ["baseAuthOptions"]),
    "packages/db/src/horse-urls.ts": facts([imp("crypto", ["createHash"])], ["horseApiOrigin"]),
    "apps/horse-api/src/index.ts": facts([imp("../../../packages/db/src/auth-horse", ["horseAuth"]), imp("jose", ["jwtVerify"])]),
    "apps/horse-api/src/sse.ts": facts([imp("../../../packages/db/src/auth-horse.js", ["horseAuth"])]),
  });
  const A = "packages/db/src/auth-horse.ts";

  it("neighbours: out, in, both (imports first, deduplicated)", () => {
    expect(neighbours(g, A, "out")).toEqual(["packages/db/src/auth-base.ts", "packages/db/src/horse-urls.ts"]);
    expect(neighbours(g, A, "in")).toEqual(["apps/horse-api/src/index.ts", "apps/horse-api/src/sse.ts"]);
    expect(neighbours(g, A, "both")).toEqual([...neighbours(g, A, "out"), ...neighbours(g, A, "in")]);
    expect(neighbours(g, "nope.ts", "both")).toEqual([]);
  });
  it("fanIn / fanOut count files, not statements", () => {
    expect([fanIn(g, A), fanOut(g, A)]).toEqual([2, 2]);
    expect([fanIn(g, "nope.ts"), fanOut(g, "nope.ts")]).toEqual([0, 0]);
  });
  it("externalUsers: by package, by specifier (deeper subpaths included), by imported name", () => {
    expect(externalUsers(g, "better-auth").map((u) => `${u.file}:${u.line} ${u.spec}`)).toEqual([
      "packages/db/src/auth-base.ts:1 better-auth/plugins/organization",
      `${A}:18 better-auth`,
      `${A}:20 better-auth/plugins`,
    ]);
    expect(externalUsers(g, "better-auth/plugins").map((u) => u.file)).toEqual(["packages/db/src/auth-base.ts", A]);
    expect(externalUsers(g, "better-auth/plugins", "jwt")).toEqual([{ file: A, pkg: "better-auth", spec: "better-auth/plugins", names: ["admin", "bearer", "jwt", "Plugin"], line: 20 }]);
    expect(externalUsers(g, "jose", "SignJWT")).toEqual([]);
    expect(externalUsers(g, "node:crypto").map((u) => u.file)).toEqual(["packages/db/src/auth-horse.ts", "packages/db/src/horse-urls.ts"]);
  });
});
