import { z } from "zod";
import { readRepoFile } from "./repo.ts";

// The recorded and hand-written Europe PMC responses the tests read, and the
// sources file that lists each one (docs/constraints/personal-data.md).
export const FIXTURES = "test/fixtures/europepmc";

export const sources = z
  .object({
    about: z.string(),
    fixtures: z.array(
      z
        .object({
          file: z.string(),
          origin: z.string().min(1),
          licence: z.string(),
          names: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .parse(JSON.parse(readRepoFile(`${FIXTURES}/sources.json`)));

export const fixture = (file: string): string =>
  readRepoFile(`${FIXTURES}/${file}`);

// Every made-up name the fixtures carry.
export const NAMES = sources.fixtures.flatMap((entry) => entry.names);
