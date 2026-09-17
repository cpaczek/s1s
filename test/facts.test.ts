import { describe, expect, it } from "vitest";
import { ABOUT_CAP, clip, emptyFacts, extractFacts, factsText } from "../src/index/facts.ts";
import type { FileFacts } from "../src/index/facts.ts";

const decls = (f: FileFacts) => f.decls.map((d) => `${d.exported ? "+" : "-"}${d.kind} ${d.name}@${d.line}`);
const imports = (f: FileFacts) => f.imports.map((i) => `${i.how}${i.typeOnly ? ":type" : ""} ${i.spec} [${i.names}]${i.as ? ` as [${i.as}]` : ""} @${i.line}`);
const ts = (src: string) => extractFacts(src, "ts");

describe("code: the header comment", () => {
  const cases: Array<[string, string, string | undefined]> = [
    [
      "a multi-line block is flattened; pragmas and directives are skipped",
      `"use client";\n// eslint-disable no-console\n// @ts-nocheck\n\n// horse-api's auth instance — the same behaviour as law-api's plus the\n// OAuth server: jwt() signs the access tokens.\n//\n// Only horse-api mounts this.\nimport { a } from "a";\n`,
      "horse-api's auth instance — the same behaviour as law-api's plus the OAuth server: jwt() signs the access tokens. Only horse-api mounts this.",
    ],
    [
      "a header that follows the imports still counts, multi-line imports included",
      `import {\n  a,\n  b,\n} from "x";\nimport y from "y";\nconst z = require("z");\n\n/**\n * Bearer verification for /mcp.\n * The resource-server half.\n */\nexport function f() {}\n`,
      "Bearer verification for /mcp. The resource-server half.",
    ],
    [
      "a doc comment further down documents a member, not the file (the stripe-webhook-handler case)",
      `import type Stripe from "stripe";\n\nexport interface Deps {\n  /** E.164 when the buyer gave one before paying, else null. */\n  phone: string | null;\n}\n\n/** Handles one event. */\nexport function handle() {}\n`,
      undefined,
    ],
    [
      "licence paragraphs are dropped, the description after them is kept",
      `/*\n * Copyright (c) 2024 Example Corp. All rights reserved.\n * Licensed under the Apache License, Version 2.0.\n *\n * Rate limiter shared by every webhook.\n */\nexport {};\n`,
      "Rate limiter shared by every webhook.",
    ],
    [
      "a licence-only block is skipped and the next block is the header",
      `// SPDX-License-Identifier: MIT\n\n// Parses the syllabus upload.\nexport {};\n`,
      "Parses the syllabus upload.",
    ],
    [
      "JSDoc: @fileoverview text is kept, @param paragraphs are not, and a scoped package is not a tag",
      `/**\n * @fileoverview OAuth tables —\n * @better-auth/mcp on top of the provider.\n *\n * @param x ignored\n *   continuation ignored\n */\nexport {};\n`,
      "OAuth tables — @better-auth/mcp on top of the provider.",
    ],
    ["rulers are decoration", `// ---- helpers ----\n// =================\nexport {};\n`, "helpers"],
    ["no comment → no about", `export const x = 1;\n`, undefined],
    [
      "an import that ends in a block comment ends there; the statement after it stops the search",
      `import { a } from './a'; /* keep */\nconst x = 1;\n/** Doc of fn. */\nexport function fn() {\n  return a(x);\n}\n/** Doc of later. */\nexport function later() {}\n`,
      undefined,
    ],
    [
      "an export list without `from` ends on its own line too",
      `export { a, b };\nconst x = 1;\n/** Doc of fn. */\nexport function fn() {\n  return 1;\n}\n/** Doc of later. */\nexport function later() {}\n`,
      undefined,
    ],
  ];
  it.each(cases)("%s", (_name, src, about) => {
    expect(ts(src).about).toBe(about);
  });

  it("caps at ABOUT_CAP (900) on a word boundary", () => {
    expect(ABOUT_CAP).toBe(900);
    const about = ts(`// ${"lorem ipsum ".repeat(200)}\nexport {};\n`).about!;
    expect(about.length).toBeLessThanOrEqual(ABOUT_CAP);
    expect(about.endsWith("ipsum…") || about.endsWith("lorem…")).toBe(true);
  });
});

describe("code: declarations", () => {
  it("reads kind, exported flag and 1-based line; top level only; overloads once", () => {
    const f = ts(
      [
        "export const foo = 1;", // 1
        "export default function Bar() {}", // 2
        "export async function baz() {}", // 3
        "export type Q = string;", // 4
        "export interface I {}", // 5
        "export abstract class K {}", // 6
        "export const enum E { A }", // 7
        "export declare function ambient(): void;", // 8
        "function over(a: string): void;", // 9
        "function over(a: number): void;", // 10
        "function* gen() {}", // 11
        "let hidden = 2;", // 12
        "class Local {", // 13
        "  method() { const nested = 1; }", // 14
        "}", // 15
        "namespace NS {}", // 16
      ].join("\n"),
    );
    expect(decls(f)).toEqual([
      "+const foo@1", "+function Bar@2", "+function baz@3", "+type Q@4", "+interface I@5", "+class K@6", "+enum E@7", "+function ambient@8",
      "-function over@9", "-function gen@11", "-let hidden@12", "-class Local@13", "-namespace NS@16",
    ]);
  });

  it("export lists mark a declaration, declare an alias, and leave an imported binding to the import", () => {
    const f = ts(
      [
        'import { given } from "./given";', // 1
        "const a = 1;", // 2
        "function c() {}", // 3
        "type T = string;", // 4
        "const { d } = obj;", // 5
        "export { a as b, type T, c, d, given };", // 6
      ].join("\n"),
    );
    // a stays private (nobody can import "a"); b is the public name and keeps a's kind; d had no declaration to mark
    expect(decls(f)).toEqual(["-const a@2", "+function c@3", "+type T@4", "+const b@6", "+export d@6"]);
  });

  it("`export { x as y }` of an import declares the new name y; the bare `export { x }` stays with the import", () => {
    expect(decls(ts('import { x } from "./x";\nexport { x as y };\nexport { x };\n'))).toEqual(["+export y@2"]);
  });

  const defaults: Array<[string, string, string[]]> = [
    ["a named function", "export default async function handler() {}", ["+function handler@1"]],
    ["an anonymous function", "export default function () {}", ["+function default@1"]],
    ["an anonymous class", "export default class extends Base {}", ["+class default@1"]],
    ["an identifier marks its declaration", "const app = make();\nexport default app;", ["+const app@1"]],
    ["an expression", "export default defineConfig({ a: 1 });", ["+default default@1"]],
    ["an expression that starts with a declared name is still an expression", "const app = make();\nexport default app.listen(3000);", ["-const app@1", "+default default@2"]],
    ["`as default` in a list", "function main() {}\nexport { main as default };", ["+function main@1"]],
    ["an imported binding is the import's, not a declaration here", 'import x from "x";\nexport default x;', []],
    ["commonjs", "function run() {}\nconst two = 2;\nmodule.exports = { run, two };\nexports.three = 3;\n", ["+function run@1", "+const two@2", "+export three@4"]],
  ];
  it.each(defaults)("export default: %s", (_name, src, want) => {
    expect(decls(ts(src))).toEqual(want);
  });
});

describe("code: imports", () => {
  const cases: Array<[string, string, string[]]> = [
    ["default", `import Stripe from "stripe";`, ["import stripe [default] @1"]],
    ["named, with the name BEFORE `as`", `import { a, b as c } from './x';`, ["import ./x [a,b] @1"]],
    ["namespace", `import * as ns from "../ns";`, ["import ../ns [*] @1"]],
    ["default + named", `import React, { useState } from "react";`, ["import react [default,useState] @1"]],
    ["default + namespace", `import d, * as all from "pkg";`, ["import pkg [default,*] @1"]],
    ["side effect", `import "./styles.css";`, ["import ./styles.css [] @1"]],
    ["import type", `import type { Request, Response } from "express";`, ["import:type express [Request,Response] @1"]],
    ["import type default", `import type Stripe from "stripe";`, ["import:type stripe [default] @1"]],
    ["inline type on every name", `import { type A, type B } from "./t";`, ["import:type ./t [A,B] @1"]],
    ["inline type on some names only", `import { type A, b } from "./t";`, ["import ./t [A,b] @1"]],
    ["a default import called `type`", `import type from "./type";`, ["import ./type [default] @1"]],
    ["multi-line, with comments inside", `import {\n  a, // first\n  /* second */ b as c,\n  type D,\n} from "@scope/pkg";`, ["import @scope/pkg [a,b,D] @1"]],
    ["minified", `import{a}from"./a.js";export*from"./b.js";`, ["import ./a.js [a] @1", "reexport ./b.js [*] @1"]],
    ["re-export, names as the target has them, `as` = what this file exposes", `export { a as b, c } from "./x";`, ["reexport ./x [a,c] as [b,c] @1"]],
    ["re-export without a rename carries no `as`", `export { a, c } from "./x";`, ["reexport ./x [a,c] @1"]],
    [
      "the same target re-exported under two names is two facts (the Button barrel)",
      `export { default } from './Button';\nexport { default as Button } from './Button';\nexport { a as x } from './a';\nexport { a as y } from './a';`,
      ["reexport ./Button [default] @1", "reexport ./Button [default] as [Button] @2", "reexport ./a [a] as [x] @3", "reexport ./a [a] as [y] @4"],
    ],
    ["export *", `export * from "./all";`, ["reexport ./all [*] @1"]],
    ["export * as ns", `export * as api from "./api";`, ["reexport ./api [*] as [api] @1"]],
    ["export type … from", `export type { AuthSession, AuthUser } from './auth-base';`, ["reexport:type ./auth-base [AuthSession,AuthUser] @1"]],
    ["dynamic", `const m = await import("./lazy");`, ["dynamic ./lazy [] @1"]],
    ["dynamic, static template", "const m = await import(`./lazy`);", ["dynamic ./lazy [] @1"]],
    ["dynamic with a computed specifier is not a fact", "const m = await import(`./locale/${lang}.ts`);\nconst n = require('./a' + b);", []],
    ["typeof import() is type-only", `type M = typeof import("./shape");`, ["dynamic:type ./shape [] @1"]],
    ["require", `const fs = require("node:fs");`, ["require node:fs [] @1"]],
    ["source order and lines", `import a from "a";\n\nimport b from "b";\nexport * from "c";\nconst d = require("d");`, ["import a [default] @1", "import b [default] @3", "reexport c [*] @4", "require d [] @5"]],
    ["the same statement twice is one fact", `await import("./x");\nawait import("./x");`, ["dynamic ./x [] @1"]],
    ["not imports", `export const from = "x";\nfoo.import("y");\nconst important = require_("z");`, []],
  ];
  it.each(cases)("%s", (_name, src, want) => {
    expect(imports(ts(src))).toEqual(want);
  });
});

describe("code: what is not code is not read", () => {
  it("ignores imports, calls and names inside comments, strings, templates and regex literals", () => {
    const f = ts(
      [
        "/*",
        ' * import { ghost } from "in-block-comment";',
        " */",
        '// import x from "in-line-comment"; commented(out);',
        'const doc = `import { t } from "in-template"; templated(1);`;',
        "const s = 'require(\"in-string\")';",
        "const re = /import\\(\"in-regex\"\\)|['\"`]/g;",
        'import { real } from "real";',
        "real(doc, s, re);",
      ].join("\n"),
    );
    expect(imports(f)).toEqual(["import real [real] @8"]);
    expect(f.calls).toEqual(["real"]);
  });

  it("still reads the code inside ${…}, and only the code", () => {
    const f = ts("const sql = `select ${quote(`inner ${deep(1)} import('no')`)} from t where fake(1)`;\nafter(sql);\n");
    expect(f.calls).toEqual(["quote", "deep", "after"]);
    expect(f.imports).toEqual([]);
  });

  it("an apostrophe in JSX text does not swallow the code after it", () => {
    const f = extractFacts("export function Page() {\n  return <p>Don't panic</p>;\n}\nexport function next() { return helper(1); }\n", "tsx");
    expect(decls(f)).toEqual(["+function Page@1", "+function next@4"]);
    expect(f.calls).toEqual(["helper"]);
  });

  it("a division is not a regex, after a word and after `)` / `]` alike", () => {
    expect(ts("const r = total / count; const q = other / 2; called(r, q);\n").calls).toEqual(["called"]);
    expect(ts("const q = (a + b) / two(x) + arr[i] / three(y) / 2; called(q);\n").calls).toEqual(["two", "three", "called"]);
  });

  it("a regex after `return` is a regex", () => {
    expect(ts("function f(s) { return /needle(x)/.test(s) ? accept(1) : deny(2); }\n").calls).toEqual(["accept", "deny"]);
  });

  it("a JSX closing tag does not open a regex", () => {
    const f = extractFacts('export function Row({ x }: P) {\n  return <tr><td>{fmt(x)}</td><td>{format(x.d)}</td><td>{done(x)} / {total(y)}</td><td><Badge label="x" /></td></tr>;\n}\n', "tsx");
    expect(f.calls).toEqual(["fmt", "format", "done", "total", "Badge"]);
    expect(extractFacts("const v = <div>{two(1)}</div><span>{three(1)}</span>;\n", "tsx").calls).toEqual(["two", "three"]);
  });
});

describe("code: calls", () => {
  it("keeps `foo(`, drops `.foo(`, syntax, builtins, test globals and declarations", () => {
    const f = ts(
      [
        "export const auth = betterAuth({", // a call
        "  plugins: [",
        "    jwt({", // first on its line, still a call
        "    admin(),",
        "  ],",
        "});",
        "function declared(a: number) { return helper<string>(a); }",
        "async function* gen() {}",
        "const x = new Client(opts);",
        "obj.method(1); obj?.maybe(2); this.own(3);",
        "if (x) for (;;) while (y) switch (z) {}",
        "const n = Number(parseInt(s)) + Math.max(1, 2); new Map(); JSON.parse(s);",
        "describe('s', () => { it('t', () => { expect(run()).toBe(1); }); beforeEach(() => {}); });",
        "cn(a); t(b);", // too short to mean anything
        "class Svc {",
        "  handle(req: Request): Promise<void> {",
        "    return dispatch(req);",
        "  }",
        "  private async other(a: string) {",
        "  }",
        "}",
        "interface Api {",
        "  list(page: number): string[];",
        "}",
        "const o = {",
        "  handler(req) {",
        "    return goNow(req);",
        "  },",
        "  async other() {},", // one-line method bodies are still definitions
        "  get prop() { return 1; },",
        "  info() {},",
        "  run: () => { retry(1); },",
        "};",
      ].join("\n"),
    );
    expect(f.calls).toEqual(["betterAuth", "jwt", "admin", "helper", "Client", "run", "dispatch", "goNow", "retry"]);
  });

  it("counts a rendered component in tsx, not a type argument or parameter, and not in ts", () => {
    const src = "const m = new Map<Panel, Row>();\nexport const V = <T extends object>(p: T) => <Panel title=\"x\"><Icons.Check /><div /></Panel>;\n";
    expect(extractFacts(src, "tsx").calls).toEqual(["Panel", "Icons"]);
    expect(extractFacts("export const G = <TData extends object>(x: TData) => <Panel row={x} />;\n", "tsx").calls).toEqual(["Panel"]);
    expect(extractFacts("const m = new Map<Panel, Row>();\nconst y = <Cast>value;\n", "ts").calls).toEqual([]);
  });
});

describe("code: strings", () => {
  it("keeps literals that name something", () => {
    const f = ts(
      [
        'import { x } from "./not-a-string";',
        'app.post("/api/webhooks/resend", h);',
        'const id = req.headers["svix-id"]; const ct = "Content-Type";',
        "const event = 'customer.subscription.updated'; const kind = `email.bounced`;",
        'const code = "P2003"; const scope = "offline_access"; const flag = "HORSE_MCP_ALLOW_DCR";',
        'const mime = "application/json"; const topic = "user:created";',
        'const prose = "Missing Svix signature headers"; const word = "admin"; const url = "https://example.com/x";',
        "const tpl = `dynamic.${kind}`; const short = 'ab';",
        "const key = process.env.RESEND_API_KEY ?? env.DATABASE_URL;",
      ].join("\n"),
    );
    expect(f.strings).toEqual([
      "/api/webhooks/resend", "svix-id", "Content-Type", "customer.subscription.updated", "email.bounced", "P2003", "offline_access",
      "HORSE_MCP_ALLOW_DCR", "application/json", "user:created", "RESEND_API_KEY", "DATABASE_URL",
    ]);
  });

  it("reads neither calls nor strings from a minified line, but still its imports", () => {
    const blob = `import{a}from"./a.js";var s="svix-id";${"call(1);".repeat(80)}`;
    const f = extractFacts(`${blob}\nshortLine("x-api-key");\n`, "js");
    expect(imports(f)).toEqual(["import ./a.js [a] @1"]);
    expect(f.calls).toEqual(["shortLine"]);
    expect(f.strings).toEqual(["x-api-key"]);
  });
});

describe("markdown", () => {
  it("takes H1–H3 outside fences and the first real paragraph", () => {
    const f = extractFacts(
      [
        "---",
        "title: ignored",
        "---",
        "# Field *guide*",
        "",
        "[![build](https://img/badge.svg)](https://ci)",
        "<p align=\"center\">logo</p>",
        "| a | b |",
        "|---|---|",
        "",
        "A **standalone** playground for `TypeSafe`, see [the docs](https://x.dev/docs)",
        "and keep snake_case_names intact.",
        "",
        "## Commands ##",
        "```sh",
        "# not a heading",
        "",
        "pnpm serve",
        "```",
        "~~~",
        "## nor this",
        "~~~",
        "### Deep",
        "#### Too deep",
        "Second paragraph.",
      ].join("\n"),
      "md",
    );
    expect(f.headings).toEqual(["Field guide", "Commands", "Deep"]);
    expect(f.about).toBe("A standalone playground for TypeSafe, see the docs and keep snake_case_names intact.");
  });

  it("falls back to the first list when there is no paragraph; mdx imports are not prose", () => {
    const f = extractFacts("import X from './x'\n\n# Checklist\n\n- rotate the keys\n- redeploy\n", "mdx");
    expect(f.about).toBe("rotate the keys redeploy");
  });

  it("an unclosed front-matter fence is a rule, not front matter", () => {
    expect(extractFacts("---\n\n# Title\n\nBody text here.\n", "md")).toMatchObject({ headings: ["Title"], about: "Body text here." });
  });
});

describe("json", () => {
  const want = ["name", "scripts", "scripts.build", "scripts.test", "files", "nested", "nested.deep"];
  it("lists top-level keys and one nested level; `description` is the about", () => {
    const f = extractFacts(JSON.stringify({ name: "x", description: "A tree navigator.", scripts: { build: "b", test: "t" }, files: ["a"], nested: { deep: { deeper: 1 } } }), "json");
    expect(f.keys).toEqual(["name", "description", ...want.slice(1)]);
    expect(f.about).toBe("A tree navigator.");
  });

  it("tolerates JSONC: comments, trailing commas, // inside strings", () => {
    const src = `// Base compiler settings.\n{\n  "name": "x", /* inline */\n  "scripts": { "build": "tsc // not a comment", "test": "vitest", },\n  "files": ["a",],\n  "nested": { "deep": { "deeper": 1 } },\n}\n`;
    const f = extractFacts(src, "json");
    expect(f.keys).toEqual(want);
    expect(f.about).toBe("Base compiler settings.");
  });

  it("falls back to a key scan when nothing parses", () => {
    const src = `{\n  "name": "x",\n  "scripts": {\n    "build": "b",\n    "test": "t"\n      "tooDeep": 1\n  },\n  "files": [ oops\n  "nested": {\n    "deep": {\n`;
    expect(extractFacts(src, "json").keys).toEqual(["name", "scripts", "scripts.build", "scripts.test", "files", "nested", "nested.deep"]);
  });

  it("reads the schema of an array of records, and nothing from scalars", () => {
    expect(extractFacts(`[{"id":"a","query":"q","path":"p"},{"id":"b"}]`, "json").keys).toEqual(["[].id", "[].query", "[].path"]);
    expect(extractFacts(`[1,2,3]`, "json")).toEqual(emptyFacts());
  });
});

describe("yml yaml toml env example", () => {
  it("yaml: leading comment, top-level keys and one nested level, block scalars are text", () => {
    const f = extractFacts(
      [
        "# Workspace-wide versions. Packages reference these",
        "# as \"catalog:\".",
        "packages:",
        "  - apps/*",
        "catalog:",
        "  '@types/node': ^25",
        "  next: 16",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: echo",
        "  \"e2e-trigger\":",
        "    name: x",
        "script: |",
        "  note: not a key",
        "url: http://example.com",
      ].join("\n"),
      "yaml",
    );
    expect(f.about).toBe('Workspace-wide versions. Packages reference these as "catalog:".');
    expect(f.keys).toEqual(["packages", "catalog", "catalog.@types/node", "catalog.next", "jobs", "jobs.test", "jobs.e2e-trigger", "script", "url"]);
  });

  it("yaml: with no leading comment, a flush-left one near the top describes the file; an indented one does not", () => {
    expect(extractFacts("name: CI\non:\n  # only on main\n  push: {}\n\n# A force-push obsoletes the in-flight run.\nconcurrency: x\n", "yml").about).toBe("A force-push obsoletes the in-flight run.");
    expect(extractFacts("name: CI\non:\n  # only on main\n  push: {}\n", "yml").about).toBeUndefined();
  });

  it("toml: sections, their keys, and the manifest description", () => {
    const f = extractFacts('[project]\nname = "svc"\ndescription = "Document conversion service"\ndependencies = [\n    # extraction\n    "pdfplumber",\n]\n\n[tool.ruff]\nline-length = 100\n\n[[bin]]\nname = "x"\n', "toml");
    expect(f.keys).toEqual(["project", "project.name", "project.description", "project.dependencies", "tool.ruff", "bin", "bin.name"]);
    expect(f.about).toBe("Document conversion service");
  });

  it("env: names only, never values; `export` and commented-out optionals count", () => {
    const f = extractFacts("# Keys for the LLM step.\nTYPESAFE_API_KEY=sk-secret-value\nexport PORT=4747\n# CEREBRAS_API_KEY=\n", "example");
    expect(f.keys).toEqual(["TYPESAFE_API_KEY", "PORT", "CEREBRAS_API_KEY"]);
    expect(f.about).toBe("Keys for the LLM step.");
    expect(factsText(f)).not.toContain("sk-secret-value");
  });
});

describe("sql and prisma", () => {
  it("sql: header comment, tables in source order, noise words and non-tables skipped", () => {
    const f = extractFacts(
      [
        "-- Content scope: whose an uploaded row is.",
        "-- Deploy before the API.",
        "",
        'CREATE TYPE "ContentScope" AS ENUM (\'COURSE\', \'PERSONAL\');',
        'ALTER TABLE "v2_documents" ADD COLUMN "scope" "ContentScope";',
        "CREATE TABLE IF NOT EXISTS public.course_memberships (id uuid REFERENCES users(id) ON UPDATE CASCADE);",
        'CREATE UNIQUE INDEX CONCURRENTLY "idx_docs_scope" ON "v2_documents"("scope");',
        "INSERT INTO audit_log (msg) VALUES ('copied from the old_table; update nothing');",
        "-- DROP TABLE commented_out;",
        "WITH recent AS (SELECT * FROM v2_chats c JOIN professors p ON p.id = c.prof WHERE EXTRACT(EPOCH FROM c.created_at) > 0)",
        "UPDATE v2_folders f SET scope = 'COURSE' FROM recent r, unnest(ARRAY[1]) u WHERE a IS DISTINCT FROM b;",
        "SELECT 1 FROM v2_folders FOR UPDATE SKIP LOCKED;",
        "DROP TABLE IF EXISTS legacy_uploads;",
        "CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$ BEGIN UPDATE counters SET n = n + 1; RETURN NEW; END $$ LANGUAGE plpgsql;",
      ].join("\n"),
      "sql",
    );
    expect(f.about).toBe("Content scope: whose an uploaded row is. Deploy before the API.");
    expect(f.tables).toEqual(["ContentScope", "v2_documents", "public.course_memberships", "users", "audit_log", "v2_chats", "professors", "v2_folders", "legacy_uploads", "counters"]);
    expect(decls(f)).toEqual(["-function touch_updated_at@14"]);
  });

  it("sql: COPY names its table; stdin and the other words after FROM that are not tables are noise", () => {
    expect(extractFacts("COPY users (id, name) FROM stdin;\nCOPY (SELECT 1) TO stdout;\nSELECT 1 FROM sessions FOR UPDATE SKIP LOCKED;\n", "sql").tables).toEqual(["users", "sessions"]);
  });

  it("prisma: models, enums and views as tables; the header is the first block, not a model's doc", () => {
    const f = extractFacts("// OAuth 2.1 authorization server — @better-auth/mcp on top of\n// the provider, plus the JWT plugin's signing keys.\n\n// Signing keys for jwt().\nmodel Jwks {\n  id String @id\n}\n\nenum Alg { RS256 }\nview Active { id String }\n", "prisma");
    expect(f.about).toBe("OAuth 2.1 authorization server — @better-auth/mcp on top of the provider, plus the JWT plugin's signing keys.");
    expect(f.tables).toEqual(["Jwks", "Alg", "Active"]);
    // after the generator block a comment sits on the first model, not on the file
    expect(extractFacts('generator client {\n  provider = "prisma-client-js"\n}\n\n// Signing keys for jwt().\nmodel Jwks {\n  id String @id\n}\n', "prisma").about).toBeUndefined();
  });
});

describe("sh py dockerfile", () => {
  it("sh: the comment block after the shebang, and the functions", () => {
    const f = extractFacts("#!/usr/bin/env bash\n# shellcheck disable=SC2086\n# Get an authenticated session and stash it\n# in a curl cookie jar.\nset -euo pipefail\n\nlogin() {\n  curl -c jar\n}\nfunction cleanup {\n  rm jar\n}\ndone\nlogin\n", "sh");
    expect(f.about).toBe("Get an authenticated session and stash it in a curl cookie jar.");
    expect(decls(f)).toEqual(["-function login@7", "-function cleanup@10"]);
  });

  it("py: docstring header, defs and classes, imports; nothing from inside a docstring", () => {
    const f = extractFacts(
      [
        "#!/usr/bin/env python3",
        "# -*- coding: utf-8 -*-",
        '"""Thin GCS helpers.',
        "",
        "Honor STORAGE_EMULATOR_HOST. Example:",
        "    import fake_module",
        '"""',
        "from __future__ import annotations",
        "import os, sys as system",
        "import urllib.parse",
        "from google.cloud import (",
        "    storage,",
        "    pubsub as ps,",
        ")",
        "from . import sibling",
        "from ..lib.io import read_text",
        "",
        "def _client():",
        "    import lazy_dep",
        "    return 1",
        "",
        "async def download_to(uri): ...",
        "class Bucket:",
        "    def method(self): ...",
      ].join("\n"),
      "py",
    );
    expect(f.about).toBe("Thin GCS helpers. Honor STORAGE_EMULATOR_HOST. Example: import fake_module");
    expect(decls(f)).toEqual(["-def _client@18", "+def download_to@22", "+class Bucket@23"]);
    expect(imports(f)).toEqual([
      "import __future__ [annotations] @8", "import os [] @9", "import sys [] @9", "import urllib.parse [] @10", "import google.cloud [storage,pubsub] @11",
      "import . [sibling] @15", "import ..lib.io [read_text] @16", "import lazy_dep [] @19",
    ]);
  });

  it("py: a leading # block beats the docstring", () => {
    expect(extractFacts('# Clusters embeddings with UMAP.\n\n"""Docstring."""\n', "py").about).toBe("Clusters embeddings with UMAP.");
  });

  it("dockerfile: header (not the syntax pragma) and build stages", () => {
    const f = extractFacts("# syntax=docker/dockerfile:1\n# law-api — customer-facing API, turbo-prune build.\nFROM node:24-alpine AS base\nFROM base AS pruner\nRUN echo\nFROM scratch\n", "dockerfile");
    expect(f.about).toBe("law-api — customer-facing API, turbo-prune build.");
    expect(decls(f)).toEqual(["-stage base@3", "-stage pruner@4"]);
  });
});

describe("everything else", () => {
  it("html: the title and h1–h3, not the markup", () => {
    const f = extractFacts('<!doctype html>\n<html><head><title>typesafe-nav</title></head>\n<body><h1 class="t">Tree <em>map</em></h1><h4>no</h4></body></html>\n', "html");
    expect(f).toMatchObject({ about: "typesafe-nav", headings: ["Tree map"] });
  });

  it("csv: the header row is the schema; no data leaks into the facts", () => {
    const f = extractFacts('id,"course name",created_at\n1,"Contracts, Fall",2026\n', "csv");
    expect(f.keys).toEqual(["id", "course name", "created_at"]);
    expect(f.about).toBeUndefined();
  });

  it("unknown text: the first paragraph, comment leaders stripped, markup skipped", () => {
    expect(extractFacts("<?xml version='1.0'?>\n# Robots policy for\n# the marketing site.\n\nUser-agent: *\n", "txt").about).toBe("Robots policy for the marketing site.");
    expect(extractFacts("syntax = \"proto3\";\n", "proto").about).toBe('syntax = "proto3";');
  });

  it("the extension is case-insensitive", () => {
    expect(extractFacts("# T\n", "MD").headings).toEqual(["T"]);
  });
});

describe("robustness", () => {
  it("binary-looking text and empty text yield empty facts", () => {
    expect(extractFacts("PNG\0\0\u0001binary import x from 'y'", "ts")).toEqual(emptyFacts());
    expect(extractFacts(`${"x".repeat(9000)}\0\0\0 import x from 'y'`, "ts").imports).toHaveLength(1); // only the first 8 KiB are probed
    expect(extractFacts("", "ts")).toEqual(emptyFacts());
  });

  it("one NUL typed into a template string does not make a source file binary", () => {
    const src = `// ${"Pairs topics that are tested together. ".repeat(30)}\nimport { prisma } from "@scope/db";\nconst key = \`\${a}\0\${b}\`;\n`;
    expect(imports(extractFacts(src, "ts"))).toEqual(["import @scope/db [prisma] @2"]);
  });

  it("strips a BOM", () => {
    expect(extractFacts("\uFEFF// Header.\nexport {};\n", "ts").about).toBe("Header.");
    expect(extractFacts('\uFEFF{"a":1}', "json").keys).toEqual(["a"]);
  });

  const garbage = [
    "`unterminated template ${ with { braces",
    "/* unclosed comment\nimport x from 'y'",
    "'\"`'\"`\\",
    "export { a as , , type } from ;\nimport from from from;\nexport default\n",
    "}}}}${${${`",
    "a / b / c /[/ d\n</div></div>",
    "\\",
    "{".repeat(5000),
    '"""'.repeat(99),
    "[[[[\n]]]]\n= = =\n: : :",
    "\n".repeat(10000),
  ];
  const exts = ["ts", "tsx", "js", "md", "json", "yaml", "toml", "env", "example", "sql", "prisma", "sh", "py", "dockerfile", "html", "csv", "css", "txt", ""];
  it("never throws, whatever the input", () => {
    for (const src of garbage) for (const ext of exts) expect(() => extractFacts(src, ext)).not.toThrow();
  });

  it("stays linear on the long runs of spaces that masking leaves behind", () => {
    const src = `/*${" ".repeat(60000)}*/\nexport function after() { return call(1); }\n${" ".repeat(60000)}\nimport late from "late";\n`;
    const t0 = performance.now();
    const f = ts(src);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(f.calls).toEqual(["call"]);
    expect(imports(f)).toEqual(["import late [default] @4"]);
  });

  it("is deterministic", () => {
    const src = `// H.\nimport { b, a } from "x";\nexport const z = a(b("svix-id"));\n`;
    expect(ts(src)).toEqual(ts(src));
    expect(JSON.stringify(ts(src))).toBe(JSON.stringify(ts(src)));
  });
});

describe("factsText", () => {
  it("is every string in the facts, one per line, minus the names that name nothing", () => {
    const f = ts(`// Signs tokens.\nimport jose, * as all from "jose";\nimport { jwt } from "better-auth/plugins";\nexport { a as b } from "./a";\nexport default function mint() { return jwt(sign("x-token-id")); }\n`);
    expect(factsText(f).split("\n")).toEqual(["Signs tokens.", "mint", "jose", "better-auth/plugins", "jwt", "./a", "a", "b", "jwt", "sign", "x-token-id"]);
    expect(factsText(emptyFacts())).toBe("");
  });
});

describe("clip", () => {
  it("cuts on a word boundary and never exceeds the cap", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("one two three four", 12)).toBe("one two…");
    expect(clip("x".repeat(50), 10)).toBe("xxxxxxxxx…");
    for (const cap of [5, 17, 110]) expect(clip("lorem ipsum dolor sit amet ".repeat(9), cap).length).toBeLessThanOrEqual(cap);
  });
});
