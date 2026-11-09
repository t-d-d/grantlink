import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import type { FundingSections } from "../extract/rules.ts";
import { isPmcid } from "../shared/pmcid.ts";

// The only module that reads or writes S3 (docs/constraints/storage.md):
// the private bucket that holds each paper's funding text, and the bucket
// the page is served from.

interface Sender {
  send(command: object): Promise<unknown>;
}

const defaultClient = () => new S3Client({ region: "eu-west-2" });

export interface TextBucket {
  putFundingText(pmcid: string, sections: FundingSections): Promise<void>;
  // The eval snapshot under eval/ (docs/constraints/evals.md). Each write
  // happens once: a second write keeps the first copy and returns it.
  hasSnapshot(id: string): Promise<boolean>;
  putSnapshotPaper(pmcid: string, body: string): Promise<string>;
  putManifest(id: string, body: string): Promise<string>;
}

const SNAPSHOT_ID = /^s\d+$/u;

const listReply = z.object({
  Contents: z.array(z.object({ Key: z.string().optional() })).optional(),
});

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : "";

const bodyOf = (reply: unknown): Promise<string> => {
  const body = (
    reply as { Body?: { transformToString?: () => Promise<string> } }
  ).Body;
  if (typeof body?.transformToString !== "function") {
    throw new Error("S3 sent no body");
  }
  return body.transformToString();
};

// The funding text bucket. A paper's funding sections go under cache/, and
// nowhere else. They hold names, so they never leave this bucket
// (docs/constraints/personal-data.md).
export function textBucket(
  name: string,
  client: Sender = defaultClient(),
): TextBucket {
  return {
    async putFundingText(pmcid, sections) {
      if (!isPmcid(pmcid)) throw new Error("not a PMCID");
      await client.send(
        new PutObjectCommand({
          Bucket: name,
          Key: `cache/${pmcid}.json`,
          ContentType: "application/json",
          Body: JSON.stringify({ pmcid, ...sections }),
        }),
      );
    },

    // Lists the manifest's key as a prefix. The run's role may list only
    // under eval/, and S3 refuses a read of a missing key as AccessDenied
    // unless the role may list the whole bucket.
    async hasSnapshot(id) {
      if (!SNAPSHOT_ID.test(id)) throw new Error("not a snapshot id");
      const key = `eval/${id}/manifest.json`;
      const reply = listReply.parse(
        await client.send(
          new ListObjectsV2Command({ Bucket: name, Prefix: key, MaxKeys: 1 }),
        ),
      );
      return (reply.Contents ?? []).some((object) => object.Key === key);
    },

    async putSnapshotPaper(pmcid, body) {
      if (!isPmcid(pmcid)) throw new Error("not a PMCID");
      return putOnce(`eval/papers/${pmcid}.json`, body);
    },

    async putManifest(id, body) {
      if (!SNAPSHOT_ID.test(id)) throw new Error("not a snapshot id");
      return putOnce(`eval/${id}/manifest.json`, body);
    },
  };

  async function read(key: string): Promise<string> {
    return bodyOf(
      await client.send(new GetObjectCommand({ Bucket: name, Key: key })),
    );
  }

  // Writes only where nothing is. The bucket's policy refuses any other
  // write under eval/, so a copy written once never changes. A write that
  // finds a copy, such as a step's second try, returns that copy.
  async function putOnce(key: string, body: string): Promise<string> {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: name,
          Key: key,
          ContentType: "application/json",
          IfNoneMatch: "*",
          Body: body,
        }),
      );
      return body;
    } catch (error) {
      if (errorName(error) !== "PreconditionFailed") throw error;
      return read(key);
    }
  }
}

// What a run publishes: the page, and the data it was built from, which the
// deploy reads to build the page again.
export interface PageFiles {
  "index.html": string;
  "found.json": string;
}

export interface SiteBucket {
  publish(files: PageFiles): Promise<void>;
}

// CloudFront keeps a copy for as long as the file says, so a new run shows
// within five minutes with no invalidation.
const CACHE = "public, max-age=300";

export function siteBucket(
  name: string,
  client: Sender = defaultClient(),
): SiteBucket {
  return {
    // The data goes first, so a deploy never builds a page older than the
    // one served.
    async publish(files) {
      await client.send(
        new PutObjectCommand({
          Bucket: name,
          Key: "found.json",
          ContentType: "application/json",
          CacheControl: CACHE,
          Body: files["found.json"],
        }),
      );
      await client.send(
        new PutObjectCommand({
          Bucket: name,
          Key: "index.html",
          ContentType: "text/html; charset=utf-8",
          CacheControl: CACHE,
          Body: files["index.html"],
        }),
      );
    },
  };
}
