import { isDateInIsoWeek, toIsoDate } from "../../lib/date-utils";
import { sortMealSlots, type MealSlot } from "./schedule";

export interface MealPlan {
  id: string;
  isoWeek: string;
  meals: MealSlot[];
}

export function createMealPlan(
  id: string,
  isoWeek: string,
  meals: MealSlot[],
): MealPlan {
  for (const meal of meals) {
    if (!isDateInIsoWeek(meal.date, isoWeek)) {
      throw new Error(`Meal ${meal.recipeId} is outside ${isoWeek}`);
    }
  }

  return {
    id,
    isoWeek,
    meals: sortMealSlots(meals),
  };
}

export function listMealsForDate(plan: MealPlan, date: Date): MealSlot[] {
  const isoDate = toIsoDate(date);
  return plan.meals.filter((meal) => meal.date === isoDate);
}
