import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { referenceSchema } from "../extract/rules.ts";

// The only module that reads or writes the results table
// (docs/constraints/storage.md). Every row is checked against its schema
// before it is written, and a row with any other field is refused, so
// funding text or a name cannot reach the table
// (docs/constraints/personal-data.md).

const PMCID = z.string().regex(/^PMC\d+$/u);

const versions = z
  .object({
    rules: z.string().min(1).max(40),
    code: z.string().min(1).max(40),
  })
  .strict();

const result = z
  .object({
    references: z.array(referenceSchema).max(50),
    versions,
    processedAt: z.iso.datetime(),
    runId: z.string().min(1).max(100),
  })
  .strict();

export type Result = z.infer<typeof result>;

const fields = {
  pmcid: PMCID,
  title: z.string().max(500),
  firstPublished: z.iso.date().optional(),
  // pending: found by a search, not yet read. processed: read by the rules.
  status: z.enum(["pending", "processed"]),
  foundAt: z.iso.datetime(),
  references: result.shape.references.optional(),
  versions: versions.optional(),
  processedAt: z.iso.datetime().optional(),
  runId: z.string().min(1).max(100).optional(),
  // How many runs have failed to read the paper.
  failures: z.number().int().nonnegative().optional(),
};

// What may be written: these fields and no other.
export const paperRow = z.object(fields).strict();
export type PaperRow = z.infer<typeof paperRow>;

// What is read: a row a later version wrote may carry a new field, which
// this version drops (docs/constraints/durable-execution.md). So may a
// reference or the versions within it.
const tolerantRow = z.object({
  ...fields,
  references: z.array(z.object(referenceSchema.shape)).max(50).optional(),
  versions: z.object(versions.shape).optional(),
});
export const readRow = (item: unknown): PaperRow => tolerantRow.parse(item);

export interface FoundPaper {
  pmcid: string;
  title: string;
  firstPublished?: string;
}

export interface Table {
  addFound(papers: FoundPaper[], at: string): Promise<void>;
  processed(pmcids: string[]): Promise<Set<string>>;
  markProcessed(pmcid: string, result: Result): Promise<void>;
  markFailed(pmcid: string): Promise<void>;
  all(): Promise<PaperRow[]>;
}

interface Sender {
  send(command: object): Promise<unknown>;
}

const isConflict = (error: unknown) =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";

const batches = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

const batchGetReply = z.object({
  Responses: z.record(z.string(), z.array(z.unknown())).optional(),
  UnprocessedKeys: z
    .record(z.string(), z.object({ Keys: z.array(z.object({ pmcid: PMCID })) }))
    .optional(),
});

const scanReply = z.object({
  Items: z.array(z.unknown()).optional(),
  LastEvaluatedKey: z.record(z.string(), z.unknown()).optional(),
});

export function dynamoTable(
  name: string,
  client: Sender = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: "eu-west-2" }),
    { marshallOptions: { removeUndefinedValues: true } },
  ),
): Table {
  const send = (command: object) => client.send(command);

  return {
    // Adds each paper a search found, unless the table holds it already.
    async addFound(papers, at) {
      const rows = papers.map((paper) =>
        paperRow.parse({ ...paper, status: "pending", foundAt: at }),
      );
      for (const batch of batches(rows, 25)) {
        await Promise.all(
          batch.map(async (row) => {
            try {
              await send(
                new PutCommand({
                  TableName: name,
                  Item: row,
                  ConditionExpression: "attribute_not_exists(pmcid)",
                }),
              );
            } catch (error) {
              if (!isConflict(error)) throw error;
            }
          }),
        );
      }
    },

    async processed(pmcids) {
      const done = new Set<string>();
      for (const batch of batches(pmcids, 100)) {
        let keys = batch.map((pmcid) => ({ pmcid }));
        while (keys.length > 0) {
          const reply = batchGetReply.parse(
            await send(
              new BatchGetCommand({
                RequestItems: {
                  [name]: {
                    Keys: keys,
                    ProjectionExpression: "pmcid, #status",
                    ExpressionAttributeNames: { "#status": "status" },
                  },
                },
              }),
            ),
          );
          for (const item of reply.Responses?.[name] ?? []) {
            const row = z
              .object({ pmcid: PMCID, status: z.string() })
              .parse(item);
            if (row.status === "processed") done.add(row.pmcid);
          }
          keys = reply.UnprocessedKeys?.[name]?.Keys ?? [];
        }
      }
      return done;
    },

    async markProcessed(pmcid, given) {
      const checked = result.parse(given);
      await send(
        new UpdateCommand({
          TableName: name,
          Key: { pmcid: PMCID.parse(pmcid) },
          ConditionExpression: "attribute_exists(pmcid)",
          UpdateExpression:
            "SET #status = :processed, #references = :references, versions = :versions, processedAt = :processedAt, runId = :runId",
          ExpressionAttributeNames: {
            "#status": "status",
            "#references": "references",
          },
          ExpressionAttributeValues: {
            ":processed": "processed",
            ":references": checked.references,
            ":versions": checked.versions,
            ":processedAt": checked.processedAt,
            ":runId": checked.runId,
          },
        }),
      );
    },

    async markFailed(pmcid) {
      await send(
        new UpdateCommand({
          TableName: name,
          Key: { pmcid: PMCID.parse(pmcid) },
          ConditionExpression: "attribute_exists(pmcid)",
          UpdateExpression: "ADD failures :one",
          ExpressionAttributeValues: { ":one": 1 },
        }),
      );
    },

    async all() {
      const rows: PaperRow[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const reply = scanReply.parse(
          await send(
            new ScanCommand({
              TableName: name,
              ...(start === undefined ? {} : { ExclusiveStartKey: start }),
            }),
          ),
        );
        rows.push(...(reply.Items ?? []).map(readRow));
        start = reply.LastEvaluatedKey;
      } while (start !== undefined);
      return rows;
    },
  };
}
