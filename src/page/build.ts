import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { found } from "./found.ts";
import { release } from "./release.ts";
import { buildPage } from "./render.ts";

// Builds the page again at deploy: from the data the last run published,
// so a deploy that changes the template keeps the findings, and from the
// release record, so the page shows the release it is. The deploy runs
//
//   node src/page/build.ts site/index.html site/release.json [found.json]
//
// which rewrites site/index.html in place before it is uploaded. Before the
// first run there is no found.json, and the page shows no findings yet.
export function rebuild(
  template: string,
  data: string | null,
  record: string | null,
): string {
  return buildPage(
    template,
    data === null ? null : found.parse(JSON.parse(data)),
    record === null ? null : release.parse(JSON.parse(record)),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [page, record, data] = process.argv.slice(2);
  if (page === undefined || record === undefined) {
    throw new Error(
      "usage: node src/page/build.ts <page.html> <release.json> [<found.json>]",
    );
  }
  const read = (path: string | undefined) =>
    path !== undefined && existsSync(path) ? readFileSync(path, "utf8") : null;
  writeFileSync(
    page,
    rebuild(
      readFileSync(page, "utf8"),
      read(data),
      readFileSync(record, "utf8"),
    ),
  );
}
