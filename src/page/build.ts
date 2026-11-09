import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { found } from "./found.ts";
import { buildPage } from "./render.ts";

// Builds the page again from the data the last run published, so a deploy
// that changes the template keeps the findings. scripts/publish-page.sh
// runs it on a copy of site/, which it rewrites in place:
//
//   node src/page/build.ts <found.json> <copy of site>/index.html
export function rebuild(template: string, data: string): string {
  return buildPage(template, found.parse(JSON.parse(data)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [data, page] = process.argv.slice(2);
  if (data === undefined || page === undefined) {
    throw new Error("usage: node src/page/build.ts <found.json> <page.html>");
  }
  writeFileSync(
    page,
    rebuild(readFileSync(page, "utf8"), readFileSync(data, "utf8")),
  );
}
