import { modelCallInModelModule } from "./model-call-in-model-module.ts";
import { noAwaitOutsideStep } from "./no-await-outside-step.ts";
import { noBannedLogFields } from "./no-banned-log-fields.ts";
import { noClosureInDurableOperations } from "./no-closure-in-durable-operations.ts";
import { noNestedDurableOperations } from "./no-nested-durable-operations.ts";
import { noNonDeterministicOutsideStep } from "./no-non-deterministic-outside-step.ts";
import { onlyOwnerImports } from "./only-owner-imports.ts";
import { requireStepRetryStrategy } from "./require-step-retry-strategy.ts";

// grantlink's own lint rules, registered in eslint.config.js as `grantlink/`.
export const rules = {
  "model-call-in-model-module": modelCallInModelModule,
  "no-await-outside-step": noAwaitOutsideStep,
  "no-banned-log-fields": noBannedLogFields,
  "no-closure-in-durable-operations": noClosureInDurableOperations,
  "no-nested-durable-operations": noNestedDurableOperations,
  "no-non-deterministic-outside-step": noNonDeterministicOutsideStep,
  "only-owner-imports": onlyOwnerImports,
  "require-step-retry-strategy": requireStepRetryStrategy,
};
