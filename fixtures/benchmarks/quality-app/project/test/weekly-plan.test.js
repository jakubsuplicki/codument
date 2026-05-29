import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createWeeklyPlan,
  summarizePlan,
  updateMeal,
} from "../src/plans/weekly-plan.js";

describe("weekly plans", () => {
  it("creates a seven-day plan with default meals", () => {
    const plan = createWeeklyPlan({ startDate: "2026-06-01" });

    assert.equal(plan.days.length, 7);
    assert.deepEqual(plan.days[0], {
      isoDate: "2026-06-01",
      meals: [
        { slot: "breakfast", label: "Breakfast", name: "overnight oats" },
        { slot: "lunch", label: "Lunch", name: "grain bowl" },
        { slot: "dinner", label: "Dinner", name: "vegetable curry" },
      ],
    });
  });

  it("applies meal overrides for a specific date", () => {
    const plan = createWeeklyPlan({
      startDate: "2026-06-01",
      mealsByDay: {
        "2026-06-02": {
          lunch: "  Tomato   Soup ",
        },
      },
    });

    assert.equal(plan.days[1].meals[1].name, "tomato soup");
  });

  it("summarizes days and meal count", () => {
    const plan = createWeeklyPlan({ startDate: "2026-06-01", days: 2 });

    assert.deepEqual(summarizePlan(plan), {
      days: 2,
      meals: 6,
    });
  });

  it("updates one meal without mutating the original plan", () => {
    const plan = createWeeklyPlan({ startDate: "2026-06-01", days: 2 });
    const updated = updateMeal(plan, "2026-06-02", "dinner", "  Lentil Stew ");

    assert.equal(plan.days[1].meals[2].name, "vegetable curry");
    assert.equal(updated.days[1].meals[2].name, "lentil stew");
  });
});
