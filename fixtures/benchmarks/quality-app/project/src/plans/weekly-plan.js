import { MEAL_SLOTS, getMealSlot, normalizeMealName } from "../domain/menu.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function createWeeklyPlan({ startDate, days = 7, mealsByDay = {} }) {
  assertIsoDate(startDate);

  return {
    startDate,
    days: Array.from({ length: days }, (_, index) => {
      const isoDate = addDays(startDate, index);
      const overrides = mealsByDay[isoDate] ?? {};

      return {
        isoDate,
        meals: MEAL_SLOTS.map((slot) => ({
          slot: slot.id,
          label: slot.label,
          name: normalizeMealName(overrides[slot.id] ?? slot.defaultMeal),
        })),
      };
    }),
  };
}

export function summarizePlan(plan) {
  return {
    days: plan.days.length,
    meals: plan.days.reduce((total, day) => total + day.meals.length, 0),
  };
}

export function updateMeal(plan, isoDate, slotId, name) {
  assertIsoDate(isoDate);
  getMealSlot(slotId);

  return {
    ...plan,
    days: plan.days.map((day) => {
      if (day.isoDate !== isoDate) return day;

      return {
        ...day,
        meals: day.meals.map((meal) =>
          meal.slot === slotId
            ? { ...meal, name: normalizeMealName(name) }
            : meal,
        ),
      };
    }),
  };
}

function addDays(startDate, offset) {
  const date = new Date(`${startDate}T00:00:00.000Z`);
  date.setTime(date.getTime() + offset * DAY_MS);
  return date.toISOString().slice(0, 10);
}

function assertIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Expected ISO date, received: ${value}`);
  }
}
