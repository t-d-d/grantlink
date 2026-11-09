import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { FundingSections } from "../extract/rules.ts";

// The only module that reads or writes S3 (docs/constraints/storage.md):
// the private bucket that holds each paper's funding text, and the bucket
// the page is served from.

interface Sender {
  send(command: object): Promise<unknown>;
}

const PMCID = /^PMC\d+$/u;
const defaultClient = () => new S3Client({ region: "eu-west-2" });

export interface TextBucket {
  putFundingText(pmcid: string, sections: FundingSections): Promise<void>;
}

// The funding text bucket. A paper's funding sections go under cache/, and
// nowhere else. They hold names, so they never leave this bucket
// (docs/constraints/personal-data.md).
export function textBucket(
  name: string,
  client: Sender = defaultClient(),
): TextBucket {
  return {
    async putFundingText(pmcid, sections) {
      if (!PMCID.test(pmcid)) throw new Error("not a PMCID");
      await client.send(
        new PutObjectCommand({
          Bucket: name,
          Key: `cache/${pmcid}.json`,
          ContentType: "application/json",
          Body: JSON.stringify({ pmcid, ...sections }),
        }),
      );
    },
  };
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
