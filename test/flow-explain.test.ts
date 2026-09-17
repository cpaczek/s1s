import { describe, expect, it } from "vitest";
import { explain } from "../src/flow/explain.ts";
import { graphOf } from "../src/index/build.ts";
import type { NavEvent } from "../src/nav/events.ts";
import { newTally } from "../src/nav/walk.ts";
import { fakeClient, fakeIndex } from "./fake.ts";

/** A tiny monorepo: an API that mounts auth, the shared auth core, a guard, a logger everyone imports, and a doc. */
const TEXTS: Record<string, string> = {
  "apps/api/package.json": '{ "name": "@acme/api" }',
  "apps/api/src/index.ts": "// The API server: mounts /api/auth/* and the routers.\nimport { auth } from '../../../packages/auth/src/auth';\nimport { log } from '../../../packages/log/src/log';\nimport { protectedProcedure } from './trpc';\napp.use('/api/auth/*', toNodeHandler(auth));\nlog('up');\n",
  "apps/api/src/trpc.ts": "// protectedProcedure: rejects any call without a live session.\nimport { auth } from '../../../packages/auth/src/auth';\nexport const protectedProcedure = t.procedure.use(async ({ ctx }) => { const session = await auth.api.getSession(); if (!session) throw new Error('UNAUTHORIZED'); });\n",
  "apps/api/src/routers/billing.ts": "// Billing router.\nimport { protectedProcedure } from '../trpc';\nimport { log } from '../../../../packages/log/src/log';\nexport const billingRouter = protectedProcedure.query(() => log('billing'));\n",
  "packages/auth/package.json": '{ "name": "@acme/auth" }',
  "packages/auth/src/auth.ts": "// The one better-auth instance: sessions, cookies, sign-in.\nimport { betterAuth } from 'better-auth';\nimport { baseOptions } from './base';\nimport { db } from '../../db/src/client';\nexport const auth = betterAuth({ ...baseOptions, database: db, session: { cookieCache: true } });\n",
  "packages/auth/src/base.ts": "// Shared options both auth instances spread: cookie prefix, session TTL.\nexport const baseOptions = { advanced: { cookiePrefix: 'acme' }, session: { expiresIn: 60 * 60 * 24 * 7 } };\n",
  "packages/db/package.json": '{ "name": "@acme/db" }',
  "packages/db/src/client.ts": "// Prisma client singleton.\nexport const db = new PrismaClient();\n",
  "packages/log/package.json": '{ "name": "@acme/log" }',
  "packages/log/src/log.ts": "// Logger used everywhere.\nexport const log = (m: string) => console.log(m);\n",
  "docs/auth.md": "# Authentication\nWe use better-auth. Sessions live in cookies.\n",
  "apps/api/src/index.test.ts": "import { auth } from '../../../packages/auth/src/auth';\ntest('auth', () => {});\n",
};
const PATHS = [...Object.keys(TEXTS), ...Array.from({ length: 30 }, (_, i) => `packages/log/src/user${i}.ts`)];
// Thirty importers make the logger a hub.
for (let i = 0; i < 30; i++) TEXTS[`packages/log/src/user${i}.ts`] = "import { log } from './log';\nlog('x');\n";

const AUTH = "packages/auth/src/auth.ts";
const BASE = "packages/auth/src/base.ts";
const API = "apps/api/src/index.ts";
const TRPC = "apps/api/src/trpc.ts";
const DB = "packages/db/src/client.ts";
const LOG = "packages/log/src/log.ts";

describe("explain", () => {
  it("gathers seeds, expands over real references, judges blocks and edges, and builds the chart", async () => {
    const index = fakeIndex(PATHS, TEXTS);
    expect(graphOf(index).out.get(AUTH)?.map((e) => e.to).sort()).toEqual([DB, BASE].sort()); // the fake repo really links up
    const client = fakeClient({
      byPath: {
        member: { [AUTH]: 0.95, [BASE]: 0.8, "docs/auth.md": 0.9, [TRPC]: 0.6 },
        part: { [AUTH]: 0.95, [BASE]: 0.85, [API]: 0.8, [TRPC]: 0.8, [DB]: 0.6, [LOG]: 0.55, "apps/api/src/routers/billing.ts": 0.2 },
        plumbing: { [LOG]: 0.9, [DB]: 0.4 },
      },
      choicePrefs: { entrypoint: 1, guard: 1, service: 1, persistence: 1, b0: 5 },
      nouls: { "explain how": 0.75, "carry out a step": 0.72, "hand `topic` work": 0.8 },
      defaultNoul: 0.1,
    });
    const events: NavEvent[] = [];
    const out = await explain({ client, index, question: "how does authentication work", scope: "", emit: (e) => events.push(e), tally: newTally() });
    const g = out.graph;

    // Seeds: the map's surest members, prose and tests excluded.
    const seeds = events.find((e) => e.type === "explain_seeds");
    expect(seeds?.type === "explain_seeds" && seeds.seeds).toEqual([AUTH, BASE]);
    expect(g.topic).toBe("authentication");

    // Expansion reached the API, the guard and the db through real edges; the logger is a hub, never expanded through.
    const drawn = g.nodes.map((n) => n.id);
    expect(drawn).toEqual(expect.arrayContaining([AUTH, BASE, API, TRPC, DB]));
    expect(drawn).not.toContain("apps/api/src/routers/billing.ts"); // judged not a step
    expect(drawn).not.toContain("docs/auth.md");
    expect(drawn).not.toContain("apps/api/src/index.test.ts");
    const hops = events.filter((e) => e.type === "explain_hop");
    expect(hops.length).toBeGreaterThanOrEqual(2);
    const logNode = g.nodes.find((n) => n.id === LOG);
    if (logNode) expect(logNode.terminal).toBe(true);
    expect(hops.every((h) => h.type === "explain_hop" && !h.expanded.includes(LOG))).toBe(true);
    // Every candidate beyond the seeds carried the reference it was reached through.
    const hop1 = client.states.find((s) => (s as { candidates?: Array<{ reached?: unknown }> }).candidates?.some((c) => c.reached)) as { candidates: Array<{ path: string; reached?: { from: string; at: string; line: string } }> };
    expect(hop1.candidates.find((c) => c.path === API)?.reached).toMatchObject({ from: AUTH, at: `${API}:2` });

    // Evidence: the header comments were judged and crowned; the summary is the authors' sentence.
    expect(g.nodes.find((n) => n.id === BASE)?.summary).toBe("Shared options both auth instances spread: cookie prefix, session TTL.");
    expect(g.nodes.find((n) => n.id === AUTH)?.evidence.length).toBeGreaterThan(0);

    // Edges are real imports with their names, judged; nothing invented.
    for (const e of g.edges) {
      const real = (graphOf(index).out.get(e.from) ?? []).some((x) => x.to === e.to) || (graphOf(index).out.get(e.to) ?? []).some((x) => x.to === e.from) || e.kind === "mention";
      expect(real).toBe(true);
    }
    expect(g.edges.some((e) => e.from === API && e.to === AUTH && e.names.includes("auth"))).toBe(true);
    expect(g.verdict).toBe("found");
    expect(events.at(-1)?.type).toBe("explain_edges");
    expect(out.judged).toBeGreaterThan(seeds?.type === "explain_seeds" ? seeds.seeds.length : 0);
  });

  it("is absent when nothing belongs to the subject", async () => {
    const index = fakeIndex(PATHS, TEXTS);
    const client = fakeClient({ defaultNoul: 0.05 });
    const out = await explain({ client, index, question: "how does the payment gateway work", scope: "", emit: () => {}, tally: newTally() });
    expect(out.graph.verdict).toBe("absent");
    expect(out.graph.nodes).toEqual([]);
  });
});
