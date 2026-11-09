import { z } from "zod";

// A paper's id in PubMed Central, such as PMC11234567. The one definition of
// its pattern, so the client, the stores and the page cannot drift apart.
const PATTERN = /^PMC\d+$/u;

export const isPmcid = (id: string): boolean => PATTERN.test(id);

export const pmcid = z.string().regex(PATTERN);
