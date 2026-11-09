import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { referenceSchema } from "../extract/rules.ts";
import { batches } from "../shared/batches.ts";
import { pmcid as PMCID } from "../shared/pmcid.ts";

// The only module that reads or writes the results table
// (docs/constraints/storage.md). Every row is checked against its schema
// before it is written, and a row with any other field is refused, so
// funding text or a name cannot reach the table
// (docs/constraints/personal-data.md).

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
  // The latest-started run whose search returned the paper. A run that
  // started earlier never replaces it, so two runs that overlap cannot
  // take each other's papers off the page (#125). The search asks for papers
  // linked to none of the funder's grants, so a paper a later search leaves
  // out has since been linked, or dropped. Optional, so rows written before
  // it read as before (docs/constraints/durable-execution.md).
  foundByRun: z.string().min(1).max(100).optional(),
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

// The key of the one item that is not a paper: the run whose search is the
// latest to complete. A run's id is `run-` and the time it started, as an
// ISO 8601 string, so ids sort as their runs started.
export const LATEST_SEARCH = "latest-search";

const latestSearchItem = z.object({ runId: z.string().min(1).max(100) });

export interface Table {
  addFound(papers: FoundPaper[], at: string, runId: string): Promise<void>;
  // Records the run's search as the latest complete one, unless a run that
  // started later has recorded its own. Safe to run twice.
  recordSearch(runId: string): Promise<void>;
  // The run whose search is the latest complete one, or null before any.
  latestSearch(): Promise<string | null>;
  processed(pmcids: string[]): Promise<Set<string>>;
  markProcessed(pmcid: string, result: Result): Promise<void>;
  markFailed(pmcid: string): Promise<void>;
  all(): Promise<PaperRow[]>;
}

interface Sender {
  send(command: object): Promise<unknown>;
}

type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// DynamoDB hands back the keys it could not read when the table is
// throttled. Each try that reads none of them waits twice as long as the
// one before; a try that reads some starts the count again. After the last
// try in a row that reads none, the step that called fails, and its own
// retries take over.
const UNPROCESSED_FIRST_WAIT_MS = 50;
const UNPROCESSED_TRIES = 8;

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

const isLatestSearch = (item: unknown): boolean =>
  z.object({ pmcid: z.literal(LATEST_SEARCH) }).safeParse(item).success;

export function dynamoTable(
  name: string,
  client: Sender = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: "eu-west-2" }),
    { marshallOptions: { removeUndefinedValues: true } },
  ),
  sleep: Sleep = realSleep,
): Table {
  const send = (command: object) => client.send(command);

  return {
    // Records each paper a run's search found: adds it if the table does
    // not hold it, keeps what the table holds of it if it does, and notes
    // that this run's search returned it, unless a run that started later
    // has noted its own. Safe to run twice.
    async addFound(papers, at, runId) {
      const rows = papers.map((paper) =>
        paperRow.parse({
          ...paper,
          status: "pending",
          foundAt: at,
          foundByRun: runId,
        }),
      );
      for (const batch of batches(rows, 25)) {
        await Promise.all(
          batch.map(async (row) => {
            // Fields the table keeps if it holds them already.
            const kept = Object.entries({
              status: row.status,
              title: row.title,
              foundAt: row.foundAt,
              firstPublished: row.firstPublished,
            }).filter(([, value]) => value !== undefined);
            // status is a DynamoDB reserved word.
            const path = (field: string) =>
              field === "status" ? "#status" : field;
            const keep = kept.map(
              ([field]) =>
                `${path(field)} = if_not_exists(${path(field)}, :${field})`,
            );
            const values = kept.map(([field, value]): [string, unknown] => [
              `:${field}`,
              value,
            ]);
            try {
              await send(
                new UpdateCommand({
                  TableName: name,
                  Key: { pmcid: row.pmcid },
                  UpdateExpression: `SET ${[...keep, "foundByRun = :foundByRun"].join(", ")}`,
                  ConditionExpression:
                    "attribute_not_exists(foundByRun) OR foundByRun <= :foundByRun",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: Object.fromEntries([
                    ...values,
                    [":foundByRun", row.foundByRun],
                  ]),
                }),
              );
            } catch (error) {
              if (!(error instanceof ConditionalCheckFailedException)) {
                throw error;
              }
              // A run that started later returned the paper too. Its mark
              // stays, and so does the rest of what the table holds.
              await send(
                new UpdateCommand({
                  TableName: name,
                  Key: { pmcid: row.pmcid },
                  UpdateExpression: `SET ${keep.join(", ")}`,
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: Object.fromEntries(values),
                }),
              );
            }
          }),
        );
      }
    },

    async recordSearch(runId) {
      try {
        await send(
          new UpdateCommand({
            TableName: name,
            Key: { pmcid: LATEST_SEARCH },
            UpdateExpression: "SET runId = :runId",
            ConditionExpression:
              "attribute_not_exists(runId) OR runId <= :runId",
            ExpressionAttributeValues: {
              ":runId": latestSearchItem.shape.runId.parse(runId),
            },
          }),
        );
      } catch (error) {
        // A run that started later has recorded its search, which stays.
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      }
    },

    async latestSearch() {
      const reply = z.object({ Item: latestSearchItem.optional() }).parse(
        await send(
          new GetCommand({
            TableName: name,
            Key: { pmcid: LATEST_SEARCH },
            ConsistentRead: true,
          }),
        ),
      );
      return reply.Item?.runId ?? null;
    },

    async processed(pmcids) {
      const done = new Set<string>();
      for (const batch of batches(pmcids, 100)) {
        let keys = batch.map((pmcid) => ({ pmcid }));
        let stalled = 0;
        for (let tries = 0; keys.length > 0; tries += 1) {
          if (stalled === UNPROCESSED_TRIES) {
            throw new Error(
              `${String(keys.length)} keys still unprocessed after ${String(UNPROCESSED_TRIES)} tries`,
            );
          }
          if (tries > 0) {
            await sleep(UNPROCESSED_FIRST_WAIT_MS * 2 ** stalled);
          }
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
          const left = reply.UnprocessedKeys?.[name]?.Keys ?? [];
          stalled = left.length < keys.length ? 0 : stalled + 1;
          keys = left;
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
            // A strongly consistent read, so the page sees what this run's
            // own steps wrote just before, such as each row's foundByRun.
            new ScanCommand({
              TableName: name,
              ConsistentRead: true,
              ...(start === undefined ? {} : { ExclusiveStartKey: start }),
            }),
          ),
        );
        rows.push(
          ...(reply.Items ?? [])
            .filter((item) => !isLatestSearch(item))
            .map(readRow),
        );
        start = reply.LastEvaluatedKey;
      } while (start !== undefined);
      return rows;
    },
  };
}
