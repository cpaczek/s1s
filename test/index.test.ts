import { describe, expect, it } from "vitest";
import { nameWords, rankThemes } from "../src/index/build.ts";

describe("theme helpers", () => {
  it("nameWords splits camel/kebab/snake, drops extensions, suffixes, numbers and generic words", () => {
    expect(nameWords("AuthBase.test.ts")).toEqual(["auth"]);
    expect(nameWords("stripe-webhook-handler.ts")).toEqual(["stripe", "webhook"]);
    expect(nameWords("20250812_add_billing_wallet")).toEqual(["billing", "wallet"]);
  });
  it("rankThemes prefers words frequent here and concentrated here", () => {
    const here = new Map([["auth", 4], ["billing", 6], ["donna", 1]]);
    const repo = new Map([["auth", 4], ["billing", 60], ["donna", 1]]);
    // auth: 16/4 = 4; billing: 36/60 = 0.6; donna: 1/1 = 1
    expect(rankThemes(here, repo)).toEqual(["auth", "donna", "billing"]);
    expect(rankThemes(here, repo, 1)).toEqual(["auth"]);
  });
});
