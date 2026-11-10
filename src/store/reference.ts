import { z } from "zod";
import { referenceSchema } from "../extract/rules.ts";

// A reference as it is read back once written: from the results table
// (src/store/table.ts) and from found.json (src/page/found.ts). A version
// later than this one may allow a character this one's referenceSchema does
// not (#314, #344), so a written reference is read by the length and type of
// each field alone. The version that wrote it checked its characters against
// its own referenceSchema, and every write still does.
const lengthOnly = (field: z.ZodString) =>
  z
    .string()
    .min(field.minLength ?? 0)
    .max(field.maxLength ?? Infinity);

export const storedReference = z.object({
  asWritten: lengthOnly(referenceSchema.shape.asWritten),
  normalised: lengthOnly(referenceSchema.shape.normalised),
  format: lengthOnly(referenceSchema.shape.format),
});
