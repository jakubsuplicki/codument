export const MEAL_SLOTS = [
  {
    id: "breakfast",
    label: "Breakfast",
    defaultMeal: "overnight oats",
  },
  {
    id: "lunch",
    label: "Lunch",
    defaultMeal: "grain bowl",
  },
  {
    id: "dinner",
    label: "Dinner",
    defaultMeal: "vegetable curry",
  },
];

export function normalizeMealName(value) {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

export function getMealSlot(slotId) {
  const slot = MEAL_SLOTS.find((candidate) => candidate.id === slotId);
  if (!slot) {
    throw new Error(`Unknown meal slot: ${slotId}`);
  }
  return slot;
}
