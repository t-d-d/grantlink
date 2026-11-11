import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { dynamoTable, olderRules, paperRow, readRow } from "./table.ts";

const processed = {
  pmcid: "PMC11",
  title: "A title",
  status: "processed",
  foundAt: "2026-11-09T10:00:00.000Z",
  references: [
    { asWritten: "C1/A12345", normalised: "C1/A12345", format: "Cn/An" },
  ],
  versions: { rules: "rules-1", code: "abc123" },
  processedAt: "2026-11-09T10:05:00.000Z",
  runId: "run-1",
};

// A DynamoDB client that records what it is sent.
function recorder(reply: (command: object) => unknown = () => ({})) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: (command: { constructor: { name: string }; input: object }) => {
      sent.push({
        name: command.constructor.name,
        input: command.input as Record<string, unknown>,
      });
      return Promise.resolve(reply(command));
    },
  };
  return { client, sent };
}

describe("fitness: no text in the table (storage.md)", () => {
  it("takes a row with only its own fields", () => {
    expect(paperRow.parse(processed)).toEqual(processed);
  });

  it.each([
    "fundingText",
    "acknowledgements",
    "authors",
    "abstract",
    "sections",
  ])("refuses a row with a %s field", (field) => {
    expect(() => paperRow.parse({ ...processed, [field]: "x" })).toThrow();
  });

  it("refuses a reference that carries more than a reference", () => {
    expect(() =>
      paperRow.parse({
        ...processed,
        references: [
          {
            asWritten: "Dr Ada Example, C1/A12345",
            normalised: "C1/A12345",
            format: "Cn/An",
          },
        ],
      }),
    ).toThrow();
  });

  it("refuses to write a result with a field outside the schema", async () => {
    const { client, sent } = recorder();
    const table = dynamoTable("results", client);
    await expect(
      table.markProcessed("PMC11", {
        references: [],
        versions: { rules: "rules-1", code: "abc" },
        processedAt: "2026-11-09T10:05:00.000Z",
        runId: "run-1",
        fundingText: "Funded by ...",
      } as never),
    ).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});

describe("reading rows tolerantly (durable-execution.md)", () => {
  it("reads a row a later version wrote with a new field", () => {
    expect(readRow({ ...processed, confidence: 0.9 })).toEqual(processed);
  });

  it("reads a row a later version wrote with a new field in a reference or its versions", () => {
    expect(
      readRow({
        ...processed,
        references: processed.references.map((reference) => ({
          ...reference,
          confidence: 0.9,
        })),
        versions: { ...processed.versions, prompt: "prompt-1" },
      }),
    ).toEqual(processed);
  });

  // A made-up reference in a shape a later version might allow: an
  // underscore, which referenceSchema does not (#314).
  const later = { asWritten: "A_12345", normalised: "A_12345", format: "A_n" };

  it("reads a row a later version wrote with a character this version does not allow in a reference", () => {
    const row = { ...processed, references: [later] };
    expect(readRow(row)).toEqual(row);
  });

  it("still checks a stored reference's length and type", () => {
    expect(() =>
      readRow({
        ...processed,
        references: [{ ...later, asWritten: "A".repeat(49) }],
      }),
    ).toThrow();
    expect(() =>
      readRow({ ...processed, references: [{ ...later, normalised: 12345 }] }),
    ).toThrow();
    expect(() =>
      readRow({ ...processed, references: [{ ...later, format: "" }] }),
    ).toThrow();
  });

  it("does not write a reference with a character this version does not allow", async () => {
    const { client, sent } = recorder();
    await expect(
      dynamoTable("results", client).markProcessed("PMC11", {
        references: [later],
        versions: processed.versions,
        processedAt: processed.processedAt,
        runId: processed.runId,
      }),
    ).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});

describe("the table module", () => {
  it("adds a paper the search found, and records that this run's search returned it", async () => {
    const { client, sent } = recorder();
    await dynamoTable("results", client).addFound(
      [{ pmcid: "PMC11", title: "A title", firstPublished: "2021-02-03" }],
      "2026-11-09T10:00:00.000Z",
      "run-2",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe("UpdateCommand");
    expect(sent[0]?.input).toEqual({
      TableName: "results",
      Key: { pmcid: "PMC11" },
      UpdateExpression:
        "SET #status = if_not_exists(#status, :status), title = if_not_exists(title, :title), foundAt = if_not_exists(foundAt, :foundAt), firstPublished = if_not_exists(firstPublished, :firstPublished), foundByRun = :foundByRun",
      ConditionExpression:
        "attribute_not_exists(foundByRun) OR foundByRun <= :foundByRun",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "pending",
        ":title": "A title",
        ":foundAt": "2026-11-09T10:00:00.000Z",
        ":firstPublished": "2021-02-03",
        ":foundByRun": "run-2",
      },
    });
  });

  it("keeps the mark of a run that started later, and the rest of what it holds", async () => {
    const failed = new ConditionalCheckFailedException({
      message: "The conditional request failed",
      $metadata: {},
    });
    const { client, sent } = recorder((command) => {
      if ("ConditionExpression" in (command as { input: object }).input) {
        throw failed;
      }
      return {};
    });
    await dynamoTable("results", client).addFound(
      [{ pmcid: "PMC11", title: "A title" }],
      "2026-11-09T10:00:00.000Z",
      "run-2026-11-09T09:00:00.000Z",
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]?.input).toEqual({
      TableName: "results",
      Key: { pmcid: "PMC11" },
      UpdateExpression:
        "SET #status = if_not_exists(#status, :status), title = if_not_exists(title, :title), foundAt = if_not_exists(foundAt, :foundAt)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "pending",
        ":title": "A title",
        ":foundAt": "2026-11-09T10:00:00.000Z",
      },
    });
  });

  it("fails on any other error when it records a paper", async () => {
    const { client } = recorder(() => {
      throw new Error("throttled");
    });
    await expect(
      dynamoTable("results", client).addFound(
        [{ pmcid: "PMC11", title: "A title" }],
        "2026-11-09T10:00:00.000Z",
        "run-2",
      ),
    ).rejects.toThrow("throttled");
  });

  it("records a run's search as the latest complete one, unless a later run's is", async () => {
    const { client, sent } = recorder();
    await dynamoTable("results", client).recordSearch(
      "run-2026-11-09T09:00:00.000Z",
    );
    expect(sent).toEqual([
      {
        name: "UpdateCommand",
        input: {
          TableName: "results",
          Key: { pmcid: "latest-search" },
          UpdateExpression: "SET runId = :runId",
          ConditionExpression: "attribute_not_exists(runId) OR runId <= :runId",
          ExpressionAttributeValues: {
            ":runId": "run-2026-11-09T09:00:00.000Z",
          },
        },
      },
    ]);
  });

  it("leaves a later run's search recorded, without failing", async () => {
    const { client } = recorder(() => {
      throw new ConditionalCheckFailedException({
        message: "The conditional request failed",
        $metadata: {},
      });
    });
    await expect(
      dynamoTable("results", client).recordSearch("run-1"),
    ).resolves.toBeUndefined();
  });

  it("reads the latest complete search as last written", async () => {
    const { client, sent } = recorder(() => ({
      Item: { pmcid: "latest-search", runId: "run-2" },
    }));
    expect(await dynamoTable("results", client).latestSearch()).toBe("run-2");
    expect(sent[0]).toEqual({
      name: "GetCommand",
      input: {
        TableName: "results",
        Key: { pmcid: "latest-search" },
        ConsistentRead: true,
      },
    });
  });

  it("reads no latest complete search before one is recorded", async () => {
    const { client } = recorder(() => ({}));
    expect(await dynamoTable("results", client).latestSearch()).toBeNull();
  });

  it("leaves a paper with no date of first publication without one", async () => {
    const { client, sent } = recorder();
    await dynamoTable("results", client).addFound(
      [{ pmcid: "PMC11", title: "A title" }],
      "2026-11-09T10:00:00.000Z",
      "run-2",
    );
    expect(sent[0]?.input.UpdateExpression).not.toContain("firstPublished");
    expect(sent[0]?.input.ExpressionAttributeValues).not.toHaveProperty(
      ":firstPublished",
    );
  });

  it("refuses to record a paper with a field outside the schema", async () => {
    const { client, sent } = recorder();
    await expect(
      dynamoTable("results", client).addFound(
        [{ pmcid: "PMC11", title: "A title", abstract: "x" } as never],
        "2026-11-09T10:00:00.000Z",
        "run-2",
      ),
    ).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  it("names which papers are already processed, by their rules versions", async () => {
    const { client } = recorder(() => ({
      Responses: {
        results: [
          { pmcid: "PMC11", status: "processed" },
          { pmcid: "PMC12", status: "pending" },
        ],
      },
    }));
    const done = await dynamoTable("results", client).rulesRead([
      "PMC11",
      "PMC12",
      "PMC13",
    ]);
    expect([...done.keys()]).toEqual(["PMC11"]);
  });

  it("asks again for unprocessed keys after a growing wait", async () => {
    let calls = 0;
    const { client, sent } = recorder(() => {
      calls += 1;
      return calls < 4
        ? {
            Responses: { results: [] },
            UnprocessedKeys: { results: { Keys: [{ pmcid: "PMC11" }] } },
          }
        : { Responses: { results: [{ pmcid: "PMC11", status: "processed" }] } };
    });
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const done = await dynamoTable("results", client, sleep).rulesRead([
      "PMC11",
    ]);
    expect([...done.keys()]).toEqual(["PMC11"]);
    expect(sent).toHaveLength(4);
    expect(waits).toHaveLength(3);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
    expect(waits[2]).toBeGreaterThan(waits[1] ?? 0);
  });

  it("keeps asking while each reply reads some of the keys", async () => {
    const pmcids = Array.from({ length: 12 }, (_, i) => `PMC${String(i + 1)}`);
    const { client, sent } = recorder((command) => {
      const keys = (
        command as {
          input: { RequestItems: { results: { Keys: { pmcid: string }[] } } };
        }
      ).input.RequestItems.results.Keys;
      const [first, ...rest] = keys;
      return {
        Responses: {
          results: [{ pmcid: first?.pmcid, status: "processed" }],
        },
        ...(rest.length > 0
          ? { UnprocessedKeys: { results: { Keys: rest } } }
          : {}),
      };
    });
    const done = await dynamoTable("results", client, () =>
      Promise.resolve(),
    ).rulesRead(pmcids);
    expect([...done.keys()].sort()).toEqual([...pmcids].sort());
    expect(sent).toHaveLength(12);
  });

  it("waits only when keys come back unprocessed", async () => {
    const { client } = recorder(() => ({
      Responses: { results: [{ pmcid: "PMC11", status: "processed" }] },
    }));
    const waits: number[] = [];
    await dynamoTable("results", client, (ms) => {
      waits.push(ms);
      return Promise.resolve();
    }).rulesRead(["PMC11"]);
    expect(waits).toEqual([]);
  });

  it("gives up when keys stay unprocessed", async () => {
    const { client, sent } = recorder(() => ({
      UnprocessedKeys: { results: { Keys: [{ pmcid: "PMC11" }] } },
    }));
    await expect(
      dynamoTable("results", client, () => Promise.resolve()).rulesRead([
        "PMC11",
      ]),
    ).rejects.toThrow(/unprocessed/u);
    expect(sent).toHaveLength(8);
  });

  it("names the rules version that read each processed paper, or none (#686)", async () => {
    const { client, sent } = recorder(() => ({
      Responses: {
        results: [
          {
            pmcid: "PMC11",
            status: "processed",
            versions: { rules: "rules-9", code: "a" },
          },
          { pmcid: "PMC12", status: "processed" },
          { pmcid: "PMC13", status: "pending" },
          {
            pmcid: "PMC14",
            status: "processed",
            versions: { rules: "rules-21", code: "b", later: 1 },
          },
          // A later version's shape this one cannot read. It is not a row
          // that records no version, so it must not read as older.
          {
            pmcid: "PMC15",
            status: "processed",
            versions: { code: "c", rulesAt: { number: 22 } },
          },
        ],
      },
    }));
    const read = await dynamoTable("results", client).rulesRead([
      "PMC11",
      "PMC12",
      "PMC13",
      "PMC14",
      "PMC15",
    ]);
    expect([...read]).toEqual([
      ["PMC11", "rules-9"],
      ["PMC12", null],
      ["PMC14", "rules-21"],
      ["PMC15", ""],
    ]);
    expect(sent[0]?.input).toMatchObject({
      RequestItems: {
        results: { ProjectionExpression: "pmcid, #status, versions" },
      },
    });
  });

  it("replaces a paper's references and versions only while the rules that read it are the ones it was given (#686)", async () => {
    const { client, sent } = recorder();
    const result = {
      references: processed.references,
      versions: { rules: "rules-20", code: "abc123" },
      processedAt: "2026-11-11T10:00:00.000Z",
      runId: "run-2",
    };
    const table = dynamoTable("results", client);
    expect(await table.replaceReferences("PMC11", "rules-9", result)).toBe(
      true,
    );
    expect(await table.replaceReferences("PMC11", null, result)).toBe(true);
    expect(sent[0]?.input).toMatchObject({
      Key: { pmcid: "PMC11" },
      ConditionExpression:
        "#status = :processed AND (versions.rules = :from OR versions.rules = :to)",
      ExpressionAttributeValues: {
        ":from": "rules-9",
        ":to": "rules-20",
        ":references": result.references,
        ":versions": result.versions,
      },
    });
    expect(sent[1]?.input).toMatchObject({
      ConditionExpression:
        "#status = :processed AND (attribute_not_exists(versions.rules) OR versions.rules = :to)",
    });
  });

  it("leaves a paper whose rules version has changed since, without failing (#686)", async () => {
    const { client } = recorder(() => {
      throw new ConditionalCheckFailedException({
        message: "changed",
        $metadata: {},
      });
    });
    expect(
      await dynamoTable("results", client).replaceReferences(
        "PMC11",
        "rules-9",
        {
          references: [],
          versions: { rules: "rules-20", code: "abc123" },
          processedAt: "2026-11-11T10:00:00.000Z",
          runId: "run-2",
        },
      ),
    ).toBe(false);
  });

  it("records why a paper last failed as it counts the failure (#504)", async () => {
    const { client, sent } = recorder();
    await dynamoTable("results", client).markFailed("PMC11", 500);
    expect(sent[0]?.input).toMatchObject({
      Key: { pmcid: "PMC11" },
      UpdateExpression: "SET lastFailure = :why ADD failures :one",
      ExpressionAttributeValues: { ":one": 1, ":why": 500 },
    });
  });

  it("records a failure with no known reason as a count alone (#504)", async () => {
    const { client, sent } = recorder();
    await dynamoTable("results", client).markFailed("PMC11", undefined);
    expect(sent[0]?.input).toMatchObject({
      UpdateExpression: "REMOVE lastFailure ADD failures :one",
      ExpressionAttributeValues: { ":one": 1 },
    });
  });

  it("names why each paper not yet processed last failed, if it did (#504)", async () => {
    const { client, sent } = recorder(() => ({
      Responses: {
        results: [
          { pmcid: "PMC11", status: "processed", lastFailure: 500 },
          { pmcid: "PMC12", status: "pending", lastFailure: 500 },
          { pmcid: "PMC13", status: "pending", lastFailure: "timeout" },
          { pmcid: "PMC14", status: "pending" },
          { pmcid: "PMC15", status: "pending", lastFailure: "a new reason" },
        ],
      },
    }));
    const failed = await dynamoTable("results", client).lastFailures([
      "PMC11",
      "PMC12",
      "PMC13",
      "PMC14",
      "PMC15",
    ]);
    expect(failed).toEqual(
      new Map<string, unknown>([
        ["PMC12", 500],
        ["PMC13", "timeout"],
      ]),
    );
    expect(sent).toHaveLength(1);
  });

  it("reads a row whose reason for failing a later version wrote (#504)", () => {
    const row = readRow({
      ...processed,
      status: "pending",
      lastFailure: "a new reason",
    });
    expect(row.lastFailure).toBeUndefined();
  });

  it("reads every row, page by page", async () => {
    const { client, sent } = recorder((command) =>
      (command as { input: { ExclusiveStartKey?: unknown } }).input
        .ExclusiveStartKey
        ? { Items: [{ ...processed, pmcid: "PMC12" }] }
        : { Items: [processed], LastEvaluatedKey: { pmcid: "PMC11" } },
    );
    const rows = await dynamoTable("results", client).all();
    expect(rows.map((row) => row.pmcid)).toEqual(["PMC11", "PMC12"]);
    expect(sent).toHaveLength(2);
  });

  it("reads no record of the latest search as a paper", async () => {
    const { client } = recorder(() => ({
      Items: [processed, { pmcid: "latest-search", runId: "run-2" }],
    }));
    const rows = await dynamoTable("results", client).all();
    expect(rows.map((row) => row.pmcid)).toEqual(["PMC11"]);
  });

  it("reads every row as last written, so the page sees this run's own writes", async () => {
    const { client, sent } = recorder(() => ({ Items: [processed] }));
    await dynamoTable("results", client).all();
    expect(sent[0]?.input.ConsistentRead).toBe(true);
  });
});

describe("which rules version is older (#686)", () => {
  it.each([
    ["rules-9", "rules-20", true],
    ["rules-19", "rules-20", true],
    [null, "rules-20", true],
    ["rules-20", "rules-20", false],
    ["rules-21", "rules-20", false],
    ["rules-100", "rules-20", false],
    // A version this code cannot read the number of is left as it is.
    ["r", "rules-20", false],
    ["rules-", "rules-20", false],
    ["rules-9x", "rules-20", false],
  ])("reads %s as older than %s: %s", (read, current, older) => {
    expect(olderRules(read, current)).toBe(older);
  });
});

// A run that started before a deploy stays on the older Lambda version, so
// it can read a paper after a newer version has (#688).
describe("recording a paper's result over a row another rules version read (#688)", () => {
  const result = {
    references: processed.references,
    versions: { rules: "rules-20", code: "abc123" },
    processedAt: "2026-11-11T10:00:00.000Z",
    runId: "run-2",
  };
  const refused = () =>
    new ConditionalCheckFailedException({ message: "refused", $metadata: {} });

  // A client that refuses the first update, as the table does when another
  // rules version has read the paper, then answers a read with `item` and
  // takes every later update.
  function heldBy(item: Record<string, unknown> | undefined) {
    let updates = 0;
    return recorder((command) => {
      const name = command.constructor.name;
      if (name === "GetCommand")
        return item === undefined ? {} : { Item: item };
      updates += 1;
      if (updates === 1) throw refused();
      return {};
    });
  }

  it("writes only while the row holds no rules version or the result's own", async () => {
    const { client, sent } = recorder();
    await dynamoTable("results", client).markProcessed("PMC11", result);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toMatchObject({
      Key: { pmcid: "PMC11" },
      ConditionExpression:
        "attribute_exists(pmcid) AND (attribute_not_exists(versions.rules) OR versions.rules = :to)",
      ExpressionAttributeValues: {
        ":to": "rules-20",
        ":versions": result.versions,
      },
    });
  });

  it.each([
    ["a newer version, compared by number", { rules: "rules-100", code: "x" }],
    [
      "a version this code cannot read the number of",
      { rules: "r", code: "x" },
    ],
    ["versions in a shape this code does not know", "rules-21"],
  ])(
    "leaves a row %s read as it is, and counts the paper as done",
    async (_case, versions) => {
      const { client, sent } = heldBy({
        pmcid: "PMC11",
        status: "processed",
        versions,
      });
      await expect(
        dynamoTable("results", client).markProcessed("PMC11", result),
      ).resolves.toBeUndefined();
      expect(sent.map((command) => command.name)).toEqual([
        "UpdateCommand",
        "GetCommand",
      ]);
      expect(sent[1]?.input).toMatchObject({
        Key: { pmcid: "PMC11" },
        ConsistentRead: true,
      });
    },
  );

  it("writes over a row an older version read since, while that version still holds it", async () => {
    const { client, sent } = heldBy({
      pmcid: "PMC11",
      status: "processed",
      versions: { rules: "rules-9", code: "x" },
    });
    await dynamoTable("results", client).markProcessed("PMC11", result);
    expect(sent.map((command) => command.name)).toEqual([
      "UpdateCommand",
      "GetCommand",
      "UpdateCommand",
    ]);
    expect(sent[2]?.input).toMatchObject({
      ConditionExpression:
        "attribute_exists(pmcid) AND (versions.rules = :seen OR versions.rules = :to)",
      ExpressionAttributeValues: { ":seen": "rules-9", ":to": "rules-20" },
    });
  });

  it("fails for a paper the table does not hold", async () => {
    const { client } = heldBy(undefined);
    await expect(
      dynamoTable("results", client).markProcessed("PMC11", result),
    ).rejects.toThrow(ConditionalCheckFailedException);
  });

  it("fails when the row keeps changing under it, so the step tries again", async () => {
    const { client } = recorder((command) => {
      if (command.constructor.name === "GetCommand") {
        return {
          Item: {
            pmcid: "PMC11",
            status: "processed",
            versions: { rules: "rules-9", code: "x" },
          },
        };
      }
      throw refused();
    });
    await expect(
      dynamoTable("results", client).markProcessed("PMC11", result),
    ).rejects.toThrow(ConditionalCheckFailedException);
  });
});
