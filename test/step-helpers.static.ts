import { describe, expect, it } from "vitest";
import { STEP_HELPERS } from "../eslint-rules/create-rule.ts";
import { readRepoFile } from "./repo.ts";
import { callbackMismatches } from "./step-helpers.ts";

// The durable lint rules treat the arguments STEP_HELPERS lists as a step's
// callbacks. Only this check ties those positions to the helpers' real
// signatures, so a stale entry fails here and not silently in lint (#411).
describe("fitness: the step helpers' callback positions match their signatures (durable-execution.md)", () => {
  it.each(STEP_HELPERS.map((helper) => [helper.module, helper.name, helper]))(
    "%s exports %s with its callbacks where the table says",
    (_module, _name, helper) => {
      expect(
        callbackMismatches(
          readRepoFile(helper.module),
          helper.name,
          helper.callbacks,
          helper.module,
        ),
      ).toEqual([]);
    },
  );
});
