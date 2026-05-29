export interface MealSlot {
  recipeId: string;
  date: string;
  mealType: "breakfast" | "lunch" | "dinner";
}

const MEAL_TYPE_ORDER = new Map([
  ["breakfast", 0],
  ["lunch", 1],
  ["dinner", 2],
]);

export function sortMealSlots(meals: MealSlot[]): MealSlot[] {
  return [...meals].sort((a, b) => {
    if (a.date !== b.date) {
      return a.date.localeCompare(b.date);
    }
    return mealTypeOrder(a.mealType) - mealTypeOrder(b.mealType);
  });
}

function mealTypeOrder(mealType: MealSlot["mealType"]): number {
  return MEAL_TYPE_ORDER.get(mealType) ?? 99;
}
