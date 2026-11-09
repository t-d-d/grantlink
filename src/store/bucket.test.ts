import { describe, expect, it } from "vitest";
import { siteBucket, textBucket } from "./bucket.ts";

function recorder() {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: (command: { constructor: { name: string }; input: object }) => {
      sent.push({
        name: command.constructor.name,
        input: command.input as Record<string, unknown>,
      });
      return Promise.resolve({});
    },
  };
  return { client, sent };
}

describe("the funding text bucket", () => {
  it("keeps a paper's funding sections under cache/", async () => {
    const { client, sent } = recorder();
    await textBucket("grantlink-text-x", client).putFundingText("PMC11", {
      text: ["Funded by Cancer Research UK."],
      awards: [],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe("PutObjectCommand");
    expect(sent[0]?.input).toMatchObject({
      Bucket: "grantlink-text-x",
      Key: "cache/PMC11.json",
      ContentType: "application/json",
    });
    expect(JSON.parse(String(sent[0]?.input.Body))).toEqual({
      pmcid: "PMC11",
      text: ["Funded by Cancer Research UK."],
      awards: [],
    });
  });

  it("refuses a key that is not a PMCID", async () => {
    const { client, sent } = recorder();
    await expect(
      textBucket("b", client).putFundingText("../eval/x", {
        text: [],
        awards: [],
      }),
    ).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});

describe("the page's bucket", () => {
  it("publishes the page and its data, cached for five minutes", async () => {
    const { client, sent } = recorder();
    await siteBucket("site", client).publish({
      "index.html": "<!doctype html>",
      "found.json": "{}",
    });
    expect(
      sent.map((s) => [s.input.Key, s.input.ContentType, s.input.CacheControl]),
    ).toEqual([
      ["found.json", "application/json", "public, max-age=300"],
      ["index.html", "text/html; charset=utf-8", "public, max-age=300"],
    ]);
  });
});
