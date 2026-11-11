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

describe("reading funding text back from cache/ (#686)", () => {
  const replying = (reply: () => unknown) => {
    const sent: Record<string, unknown>[] = [];
    const client = {
      send: (command: { input: object }) => {
        sent.push(command.input as Record<string, unknown>);
        return Promise.resolve().then(reply);
      },
    };
    return { client, sent };
  };

  it("reads a paper's funding sections from cache/", async () => {
    const { client, sent } = replying(() => ({
      Body: {
        transformToString: () =>
          Promise.resolve(
            JSON.stringify({ pmcid: "PMC11", text: ["t"], awards: [] }),
          ),
      },
    }));
    expect(await textBucket("b", client).getFundingText("PMC11")).toEqual({
      text: ["t"],
      awards: [],
    });
    expect(sent).toEqual([{ Bucket: "b", Key: "cache/PMC11.json" }]);
  });

  it("reads a paper with no text in cache/ as null", async () => {
    const { client } = replying(() => {
      throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    });
    expect(await textBucket("b", client).getFundingText("PMC11")).toBeNull();
  });

  it("fails on any other error, and on text it does not recognise", async () => {
    const denied = replying(() => {
      throw Object.assign(new Error("denied"), { name: "AccessDenied" });
    });
    await expect(
      textBucket("b", denied.client).getFundingText("PMC11"),
    ).rejects.toThrow("denied");
    const odd = replying(() => ({
      Body: { transformToString: () => Promise.resolve('{"text":"t"}') },
    }));
    await expect(
      textBucket("b", odd.client).getFundingText("PMC11"),
    ).rejects.toThrow();
  });

  it("refuses a key that is not a PMCID", async () => {
    const { client, sent } = replying(() => ({}));
    await expect(
      textBucket("b", client).getFundingText("../eval/x"),
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

  // The README says what a run whose page write fails leaves on the site
  // (#79): its found.json stays, and the next deploy builds the page from it.
  it("leaves the new found.json in place when the page write fails", async () => {
    const written: string[] = [];
    const client = {
      send: (command: { input: object }) => {
        const { Key } = command.input as { Key: string };
        if (Key === "index.html") {
          return Promise.reject(new Error("SlowDown"));
        }
        written.push(Key);
        return Promise.resolve({});
      },
    };
    await expect(
      siteBucket("site", client).publish({
        "index.html": "<!doctype html>",
        "found.json": "{}",
      }),
    ).rejects.toThrow("SlowDown");
    expect(written).toEqual(["found.json"]);
  });
});

describe("the live release record in the page's bucket", () => {
  const replying = (reply: () => Promise<unknown>) => {
    const keys: unknown[] = [];
    const client = {
      send: (command: { input: { Bucket?: string; Key?: string } }) => {
        keys.push([command.input.Bucket, command.input.Key]);
        return reply();
      },
    };
    return { client, keys };
  };

  it("reads release.json", async () => {
    const { client, keys } = replying(() =>
      Promise.resolve({
        Body: { transformToString: () => Promise.resolve("{}") },
      }),
    );
    expect(await siteBucket("site", client).liveRelease()).toBe("{}");
    expect(keys).toEqual([["site", "release.json"]]);
  });

  it("reads a missing record as none", async () => {
    const { client } = replying(() =>
      Promise.reject(Object.assign(new Error("x"), { name: "NoSuchKey" })),
    );
    expect(await siteBucket("site", client).liveRelease()).toBeNull();
  });

  it("stops on any other error", async () => {
    const { client } = replying(() =>
      Promise.reject(Object.assign(new Error("x"), { name: "AccessDenied" })),
    );
    await expect(siteBucket("site", client).liveRelease()).rejects.toThrow();
  });

  it("publishes only the data when there is no page to write", async () => {
    const { client, sent } = recorder();
    await siteBucket("site", client).publish({ "found.json": "{}" });
    expect(sent.map((s) => s.input.Key)).toEqual(["found.json"]);
  });
});

// An S3 held in memory that refuses a write over an existing key when the
// write asks it to, as the bucket's policy makes every write under eval/.
// The run's role may list only under eval/, and S3 does not count a listing
// limited to a prefix when it reads a missing key, so that read is refused
// as AccessDenied, not NoSuchKey.
function memoryS3() {
  const objects = new Map<string, string>();
  const fail = (name: string, status: number) =>
    Object.assign(new Error(name), {
      name,
      $metadata: { httpStatusCode: status },
    });
  const client = {
    send: (command: { constructor: { name: string }; input: object }) => {
      const input = command.input as {
        Key: string;
        Prefix?: string;
        Body?: string;
        IfNoneMatch?: string;
      };
      switch (command.constructor.name) {
        case "PutObjectCommand":
          if (input.IfNoneMatch === "*" && objects.has(input.Key)) {
            return Promise.reject(fail("PreconditionFailed", 412));
          }
          objects.set(input.Key, input.Body ?? "");
          return Promise.resolve({});
        case "GetObjectCommand": {
          const body = objects.get(input.Key);
          if (body === undefined) {
            return Promise.reject(fail("AccessDenied", 403));
          }
          return Promise.resolve({
            Body: { transformToString: () => Promise.resolve(body) },
          });
        }
        case "ListObjectsV2Command": {
          const keys = [...objects.keys()].filter((key) =>
            key.startsWith(input.Prefix ?? ""),
          );
          return Promise.resolve({
            KeyCount: keys.length,
            Contents: keys.map((Key) => ({ Key })),
          });
        }
        default:
          return Promise.reject(new Error("not faked"));
      }
    },
  };
  return { client, objects };
}

describe("the eval snapshot in the funding text bucket", () => {
  it("writes a paper's text under its snapshot's own id once, and keeps the first copy", async () => {
    const { client, objects } = memoryS3();
    const bucket = textBucket("b", client);
    expect(await bucket.putSnapshotPaper("s3", "PMC11", "first")).toBe("first");
    expect(await bucket.putSnapshotPaper("s3", "PMC11", "second")).toBe(
      "first",
    );
    expect(objects.get("eval/s3/papers/PMC11.json")).toBe("first");
  });

  // Each snapshot cuts its own text (#502), so a cutter fix reaches a paper
  // an earlier snapshot holds.
  it("writes a fresh copy of a paper an earlier snapshot holds under a new snapshot id", async () => {
    const { client, objects } = memoryS3();
    const bucket = textBucket("b", client);
    await bucket.putSnapshotPaper("s2", "PMC11", "old cut");
    expect(await bucket.putSnapshotPaper("s3", "PMC11", "new cut")).toBe(
      "new cut",
    );
    expect(objects.get("eval/s2/papers/PMC11.json")).toBe("old cut");
    expect(objects.get("eval/s3/papers/PMC11.json")).toBe("new cut");
  });

  it("refuses a paper's text under a key that is not a snapshot id", async () => {
    const { client } = memoryS3();
    const bucket = textBucket("b", client);
    await expect(
      bucket.putSnapshotPaper("../cache", "PMC11", "x"),
    ).rejects.toThrow("not a snapshot id");
  });

  it("writes a snapshot's manifest once, and knows whether it exists", async () => {
    const { client, objects } = memoryS3();
    const bucket = textBucket("b", client);
    expect(await bucket.hasSnapshot("s1")).toBe(false);
    expect(await bucket.putManifest("s1", "{}")).toBe("{}");
    expect(await bucket.putManifest("s1", "[]")).toBe("{}");
    expect(await bucket.hasSnapshot("s1")).toBe(true);
    expect([...objects.keys()]).toEqual(["eval/s1/manifest.json"]);
  });

  it("refuses a key that is not a PMCID or a snapshot id", async () => {
    const { client, objects } = memoryS3();
    const bucket = textBucket("b", client);
    await expect(bucket.putSnapshotPaper("s3", "../x", "")).rejects.toThrow();
    await expect(bucket.putManifest("../x", "")).rejects.toThrow();
    expect(objects.size).toBe(0);
  });
});
