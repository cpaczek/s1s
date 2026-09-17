import { DurableObject } from "cloudflare:workers";
import { admit, initialState, LIMITS, prune, release, type Admission, type ProtectionState } from "./protection.ts";
import { compute, type DemoEnv } from "./executor.ts";

/** The coordination atom is the single demo's paid budget. Inference runs here
 * too: SQLite Durable Objects provide the CPU budget needed on Workers Free. */
export class AdmissionCoordinator extends DurableObject<DemoEnv> {
  constructor(ctx: DurableObjectState, env: DemoEnv) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS answers (key TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL)");
  }
  async fetch(request: Request): Promise<Response> {
    return compute(request, this.env, this.ctx, {
      enter: (ip, key) => this.enter(ip, key),
      poll: (id) => this.poll(id),
      finish: (id, body) => this.finish(id, body),
    });
  }
  private change<T>(run: (state: ProtectionState, now: number) => T): T {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const saved = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM state WHERE id=1").toArray()[0];
      const state: ProtectionState = saved ? JSON.parse(saved.value) : initialState(now);
      prune(state, now);
      const result = run(state, now);
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO state (id,value) VALUES (1,?)", JSON.stringify(state));
      return result;
    });
  }
  enter(ip: string, key: string): Admission {
    const result = this.change((state, now) => {
      this.ctx.storage.sql.exec("DELETE FROM answers WHERE expires<=?", now);
      const cached = this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM answers WHERE key=?", key).toArray()[0];
      return admit(state, ip, key, crypto.randomUUID(), now, cached?.body);
    });
    this.ctx.waitUntil(this.ctx.storage.setAlarm((Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000));
    return result;
  }
  poll(id: string): "active" | "queued" | "expired" {
    return this.change((state) => state.leases.find((lease) => lease.id === id)?.status ?? "expired");
  }
  finish(id: string, body?: string): void {
    this.change((state, now) => {
      const lease = release(state, id, now);
      if (!lease || lease.status !== "active" || !body || new TextEncoder().encode(body).byteLength > LIMITS.cacheBytes) return;
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO answers (key,body,expires) VALUES (?,?,?)", lease.key, body, now + LIMITS.cacheMs);
      this.ctx.storage.sql.exec("DELETE FROM answers WHERE key IN (SELECT key FROM answers ORDER BY expires DESC LIMIT -1 OFFSET ?)", LIMITS.cacheEntries);
    });
  }
  async alarm(): Promise<void> {
    this.change((_state, now) => this.ctx.storage.sql.exec("DELETE FROM answers WHERE expires<=?", now));
    const remaining = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM answers").one().count;
    if (remaining) await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }
}
