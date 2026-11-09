import { describe, expect, it } from "vitest";
import { FLOORS, judge } from "./floors.ts";

describe("the go/no-go floors", () => {
  it("lists the PRD's rows, in its order", () => {
    expect(FLOORS.map((floor) => floor.id)).toEqual([
      "precision-b",
      "recall-b",
      "review-share",
      "recall-a",
      "model-adds",
      "spend",
    ]);
  });

  it("gates on precision and recall on B, recall on A and spend", () => {
    expect(
      FLOORS.filter((floor) => floor.gates === "yes").map((floor) => floor.id),
    ).toEqual(["precision-b", "recall-b", "recall-a", "spend"]);
  });

  it.each([
    ["precision-b", 0.95, "go"],
    ["precision-b", 0.949, "no-go"],
    ["recall-b", 0.8, "go"],
    ["recall-b", 0.79, "no-go"],
    ["recall-a", 0.95, "go"],
    ["recall-a", 0.9, "no-go"],
    ["review-share", 0.2, "go"],
    ["review-share", 0.21, "no-go"],
    ["model-adds", 0.1, "go"],
    ["model-adds", 0.05, "no-go"],
    ["spend", 5, "go"],
    ["spend", 5.01, "no-go"],
  ] as const)("judges %s at %f as %s", (id, score, result) => {
    expect(judge(id, score)).toBe(result);
  });

  it("calls a row with no data yet by what it waits for, not a failure", () => {
    expect(judge("recall-b", null)).toBe("awaiting labels");
    expect(judge("model-adds", null)).toBe("awaiting labels");
    expect(judge("recall-a", null)).toBe("awaiting snapshot");
    expect(judge("review-share", null)).toBe("not measured yet");
  });
});
