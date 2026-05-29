export interface Recipe {
  id: string;
  title: string;
  ingredients: string[];
}

export function searchRecipes(recipes: Recipe[], query: string): Recipe[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  return recipes
    .map((recipe) => ({
      recipe,
      score: scoreRecipe(recipe, tokens),
    }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((result) => result.recipe);
}

function scoreRecipe(recipe: Recipe, tokens: string[]): number {
  const title = recipe.title.toLowerCase();
  const ingredients = recipe.ingredients.join(" ").toLowerCase();

  return tokens.reduce((score, token) => {
    if (title.includes(token)) return score + 3;
    if (ingredients.includes(token)) return score + 1;
    return score;
  }, 0);
}
