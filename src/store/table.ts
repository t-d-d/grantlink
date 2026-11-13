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
import { storedReference } from "./reference.ts";

// The only module that reads or writes the results table
// (docs/constraints/storage.md). Every row is checked against its schema
// before it is written, and a row with any other field is refused, so
// funding text or a name cannot reach the table
// (docs/constraints/personal-data.md).

const versions = z
  .object({
    rules: z.string().min(1).max(40),
    code: z.string().min(1).max(40),
    // The cutter version that cut the paper's funding sections. Rows written
    // before #443 hold none, and read as cut by an older version.
    cutter: z.string().min(1).max(40).optional(),
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

// The number of a version, `<prefix>-<number>`, or null for a version this
// code cannot read the number of.
function versionNumber(prefix: string, version: string): number | null {
  const match = new RegExp(`^${prefix}-(\\d+)$`, "u").exec(version);
  return match?.[1] === undefined ? null : Number(match[1]);
}

// Whether a version, or null for none recorded, is older than `current`.
// Versions compare by number, not as strings, and a version whose number
// cannot be read counts as not older, so the row stays as it is.
function older(prefix: string, read: string | null, current: string) {
  if (read === null) return true;
  const was = versionNumber(prefix, read);
  const now = versionNumber(prefix, current);
  return was !== null && now !== null && was < now;
}

// Whether the rules version that read a paper is older than `current`
// (#686).
export const olderRules = (read: string | null, current: string): boolean =>
  older("rules", read, current);

// Whether the cutter version that cut a paper is older than `current`. A
// run fetches and cuts again a paper an older version cut (#443).
export const olderCutter = (read: string | null, current: string): boolean =>
  older("cutter", read, current);

// The versions a processed row holds, as versionsRead reads them: null for
// none, or an empty string for each when the versions are in a shape this
// version does not know.
export interface HeldVersions {
  rules: string | null;
  cutter: string | null;
}

const heldVersions = z
  .object({
    rules: versions.shape.rules,
    cutter: versions.shape.cutter,
  })
  .optional()
  .catch({ rules: "", cutter: "" });

// The names markProcessed and replaceReferences write a result through.
// status, references and rules are DynamoDB reserved words, so an
// expression names them only through these (#698).
const RESULT_NAMES = {
  "#status": "status",
  "#references": "references",
  "#rules": "rules",
};

// How many times markProcessed reads a row that changed under its write
// before it fails, and the step that called it tries again.
const MARK_PROCESSED_TRIES = 3;

// Why a paper last failed: the status of Europe PMC's last answer, or that
// the last request timed out or could not connect, or that a wait Europe PMC
// asked for was still owed, or that the fault was in the code (#378). A run
// asks once for a paper whose full text last answered 500 (#504,
// docs/constraints/europe-pmc.md). Ids and codes only, never a message.
export const lastFailure = z.union([
  z.number().int().min(100).max(599),
  z.enum(["timeout", "no-connection", "waiting", "code"]),
]);
export type LastFailure = z.infer<typeof lastFailure>;

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
  // linked to none of the funder's grants and not marked as retracted, so a
  // paper a later search leaves out has since been linked, retracted or
  // dropped. Optional, so rows written before it read as before
  // (docs/constraints/durable-execution.md).
  foundByRun: z.string().min(1).max(100).optional(),
  references: result.shape.references.optional(),
  versions: versions.optional(),
  processedAt: z.iso.datetime().optional(),
  runId: z.string().min(1).max(100).optional(),
  // How many runs have failed to read the paper.
  failures: z.number().int().nonnegative().optional(),
  // Why the paper last failed. Rows written before #504 hold none.
  lastFailure: lastFailure.optional(),
};

// What may be written: these fields and no other.
export const paperRow = z.object(fields).strict();
export type PaperRow = z.infer<typeof paperRow>;

// What is read: a row a later version wrote may carry a new field, which
// this version drops (docs/constraints/durable-execution.md). So may a
// reference or the versions within it. A reference may also hold a character
// a later version allows and this one does not (#314), so a stored one is
// read by the length and type of each field alone (src/store/reference.ts).
// What is written still passes the whole of referenceSchema.
const tolerantRow = z.object({
  ...fields,
  references: z.array(storedReference).max(50).optional(),
  versions: z.object(versions.shape).optional(),
  // A reason a later version added reads as none, so the paper gets the
  // usual tries.
  lastFailure: lastFailure.optional().catch(undefined),
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
  // The rules version that read each processed paper and the cutter version
  // that cut it, each null for one whose row records none, or an empty
  // string for one this version cannot read (#686, #443).
  versionsRead(pmcids: string[]): Promise<Map<string, HeldVersions>>;
  // Why each paper last failed, for those that hold a reason this version
  // reads. A processed paper holds one only if a fetch to cut it again has
  // failed since it was read, since a read drops it (#443).
  lastFailures(pmcids: string[]): Promise<Map<string, LastFailure>>;
  // Records a paper's result, and drops why it last failed, unless a rules
  // version newer than the result's, or one this version cannot read, has
  // read it, whose result stays and the paper counts as done (#688).
  markProcessed(pmcid: string, result: Result): Promise<void>;
  // Writes the result of re-running the rules on a processed paper, only
  // while the rules version that read it is still `from` (null while the row
  // holds no versions at all) or already the result's own. Returns false,
  // and writes nothing, when another version has read it since. Safe to run
  // twice (#686).
  replaceReferences(
    pmcid: string,
    from: string | null,
    result: Result,
  ): Promise<boolean>;
  // Counts a failure, and keeps why, or no reason when none is known.
  markFailed(pmcid: string, why?: LastFailure): Promise<void>;
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

const latestSearchKey = z.object({ pmcid: z.literal(LATEST_SEARCH) });

const isLatestSearch = (item: unknown): boolean =>
  latestSearchKey.safeParse(item).success;

export function dynamoTable(
  name: string,
  client: Sender = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: "eu-west-2" }),
    { marshallOptions: { removeUndefinedValues: true } },
  ),
  sleep: Sleep = realSleep,
): Table {
  const send = (command: object) => client.send(command);

  // The items the table holds of `pmcids`, each with its pmcid, its status
  // and the `extra` fields, read a hundred keys at a time. The projection
  // always names #status, so the name it is given is always used.
  async function getMany(
    pmcids: string[],
    extra: string[] = [],
  ): Promise<unknown[]> {
    const projection = ["pmcid", "#status", ...extra].join(", ");
    const items: unknown[] = [];
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
                  ProjectionExpression: projection,
                  ExpressionAttributeNames: { "#status": "status" },
                },
              },
            }),
          ),
        );
        items.push(...(reply.Responses?.[name] ?? []));
        const left = reply.UnprocessedKeys?.[name]?.Keys ?? [];
        stalled = left.length < keys.length ? 0 : stalled + 1;
        keys = left;
      }
    }
    return items;
  }

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

    async versionsRead(pmcids) {
      const read = new Map<string, HeldVersions>();
      for (const item of await getMany(pmcids, ["versions"])) {
        const row = z
          .object({
            pmcid: PMCID,
            status: z.string(),
            // A row a later version wrote may hold more, or a shape this
            // version does not know. That reads as empty versions, which
            // neither olderRules nor olderCutter counts as older, so the
            // row stays as it is. A row with no versions at all reads as
            // none, and one with no cutter version as no cutter.
            versions: heldVersions,
          })
          .parse(item);
        if (row.status === "processed") {
          read.set(row.pmcid, {
            rules: row.versions?.rules ?? null,
            cutter: row.versions?.cutter ?? null,
          });
        }
      }
      return read;
    },

    async lastFailures(pmcids) {
      const failed = new Map<string, LastFailure>();
      for (const item of await getMany(pmcids, ["lastFailure"])) {
        const row = z
          .object({
            pmcid: PMCID,
            status: z.string(),
            lastFailure: lastFailure.optional().catch(undefined),
          })
          .parse(item);
        if (row.lastFailure !== undefined) {
          failed.set(row.pmcid, row.lastFailure);
        }
      }
      return failed;
    },

    // Writes only while the row holds no rules version, the result's own,
    // or one olderRules counts as older, so a run that started before a
    // deploy leaves a row a newer version read as it is (#688). The first
    // write asks for no version or the result's own. If the table refuses
    // it, the row is read: a version not older stays, and the paper counts
    // as done, and an older one is written over while it still holds.
    async markProcessed(pmcid, given) {
      const checked = result.parse(given);
      const key = { pmcid: PMCID.parse(pmcid) };
      let seen: string | null = null;
      for (let tries = 1; ; tries += 1) {
        try {
          await send(
            new UpdateCommand({
              TableName: name,
              Key: key,
              // No versions at all, not no versions.rules: a row whose
              // versions are in a shape this version does not know lacks
              // versions.rules too, and versionsRead reads it as not older.
              ConditionExpression: `attribute_exists(pmcid) AND (${
                seen === null
                  ? "attribute_not_exists(versions)"
                  : "versions.#rules = :seen"
              } OR versions.#rules = :to)`,
              UpdateExpression:
                "SET #status = :processed, #references = :references, versions = :versions, processedAt = :processedAt, runId = :runId REMOVE lastFailure",
              ExpressionAttributeNames: RESULT_NAMES,
              ExpressionAttributeValues: {
                ":processed": "processed",
                ...(seen === null ? {} : { ":seen": seen }),
                ":to": checked.versions.rules,
                ":references": checked.references,
                ":versions": checked.versions,
                ":processedAt": checked.processedAt,
                ":runId": checked.runId,
              },
            }),
          );
          return;
        } catch (error) {
          if (!(error instanceof ConditionalCheckFailedException)) throw error;
          if (tries === MARK_PROCESSED_TRIES) throw error;
          const reply = z
            .object({
              Item: z
                .object({ pmcid: PMCID, versions: heldVersions })
                .optional(),
            })
            .parse(
              await send(
                new GetCommand({
                  TableName: name,
                  Key: key,
                  ProjectionExpression: "pmcid, versions",
                  ConsistentRead: true,
                }),
              ),
            );
          // The table does not hold the paper.
          if (reply.Item === undefined) throw error;
          const held = reply.Item.versions?.rules ?? null;
          if (held !== null && !olderRules(held, checked.versions.rules)) {
            // A rules version not older than the result's, or one this
            // version cannot read, has read the paper since, and its
            // result stays.
            return;
          }
          seen = held;
        }
      }
    },

    async replaceReferences(pmcid, from, given) {
      const checked = result.parse(given);
      const was =
        from === null
          ? "attribute_not_exists(versions)"
          : "versions.#rules = :from";
      try {
        await send(
          new UpdateCommand({
            TableName: name,
            Key: { pmcid: PMCID.parse(pmcid) },
            ConditionExpression: `#status = :processed AND (${was} OR versions.#rules = :to)`,
            UpdateExpression:
              "SET #references = :references, versions = :versions, processedAt = :processedAt, runId = :runId",
            ExpressionAttributeNames: RESULT_NAMES,
            ExpressionAttributeValues: {
              ":processed": "processed",
              ...(from === null
                ? {}
                : { ":from": versions.shape.rules.parse(from) }),
              ":to": checked.versions.rules,
              ":references": checked.references,
              ":versions": checked.versions,
              ":processedAt": checked.processedAt,
              ":runId": checked.runId,
            },
          }),
        );
        return true;
      } catch (error) {
        // Another rules version has read the paper since, and its result
        // stays.
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
        return false;
      }
    },

    async markFailed(pmcid, why) {
      const checked = lastFailure.optional().parse(why);
      await send(
        new UpdateCommand({
          TableName: name,
          Key: { pmcid: PMCID.parse(pmcid) },
          ConditionExpression: "attribute_exists(pmcid)",
          UpdateExpression:
            checked === undefined
              ? "REMOVE lastFailure ADD failures :one"
              : "SET lastFailure = :why ADD failures :one",
          ExpressionAttributeValues:
            checked === undefined
              ? { ":one": 1 }
              : { ":one": 1, ":why": checked },
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
