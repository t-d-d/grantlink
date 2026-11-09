// The go/no-go table from the PRD (#1), set before the build. A release
// ships only when every row that gates scores at or above its floor. A row
// with no data yet, such as gold set B before its labels, does not block.

export type RowId =
  | "precision-b"
  | "recall-b"
  | "review-share"
  | "recall-a"
  | "model-adds"
  | "spend";

export type Result =
  "go" | "no-go" | "awaiting labels" | "awaiting snapshot" | "not measured yet";

export interface Floor {
  id: RowId;
  measure: string;
  on: string;
  goIf: string;
  // "yes" blocks a release below its floor. The others are shown only.
  gates: "yes" | "reported" | "decides the model";
  // Whether a score clears the floor. Shares are fractions, spend is US
  // dollars per 1,000 papers, and what the model adds is in fractions too.
  clears: (score: number) => boolean;
  // What a row with no score waits for.
  missing: Exclude<Result, "go" | "no-go">;
}

export const FLOORS: readonly Floor[] = [
  {
    id: "precision-b",
    measure: "Precision of accepted links",
    on: "Gold set B",
    goIf: "95% or more",
    gates: "yes",
    clears: (score) => score >= 0.95,
    missing: "awaiting labels",
  },
  {
    id: "recall-b",
    measure: "Recall of true CRUK references",
    on: "Gold set B",
    goIf: "80% or more",
    gates: "yes",
    clears: (score) => score >= 0.8,
    missing: "awaiting labels",
  },
  {
    id: "review-share",
    measure: "Papers sent to review",
    on: "Everything processed",
    goIf: "20% or fewer",
    gates: "reported",
    clears: (score) => score <= 0.2,
    missing: "not measured yet",
  },
  {
    id: "recall-a",
    measure: "Recall",
    on: "Gold set A",
    goIf: "95% or more",
    gates: "yes",
    clears: (score) => score >= 0.95,
    missing: "awaiting snapshot",
  },
  {
    id: "model-adds",
    measure: "What the model adds",
    on: "Gold set B",
    goIf: "Recall at least 10 points above rules alone",
    gates: "decides the model",
    // A hair under ten points still counts, so 0.1 computed as 0.0999...
    // is not refused.
    clears: (score) => score >= 0.1 - 1e-9,
    missing: "awaiting labels",
  },
  {
    id: "spend",
    measure: "Model spend",
    on: "Per 1,000 papers",
    goIf: "$5 or less",
    gates: "yes",
    clears: (score) => score <= 5,
    missing: "not measured yet",
  },
];

export function floorOf(id: RowId): Floor {
  const floor = FLOORS.find((row) => row.id === id);
  if (floor === undefined) throw new Error(`no floor for ${id}`);
  return floor;
}

export function judge(id: RowId, score: number | null): Result {
  const floor = floorOf(id);
  if (score === null) return floor.missing;
  return floor.clears(score) ? "go" : "no-go";
}

// A score as the page and the pull request's comment show it.
export function shownScore(id: RowId, score: number | null): string {
  if (score === null) return "-";
  if (id === "spend") return `$${score.toFixed(2)}`;
  if (id === "model-adds") return `${(score * 100).toFixed(1)} points`;
  return `${(score * 100).toFixed(1)}%`;
}
