export const LANDING_PAGE_COPY = `
Plan meals with confidence, reduce food waste, and keep the whole household aligned.
This copy is intentionally long enough to make broad context collection visibly more
expensive than registry-guided selection. It talks about grocery lists, seasonal produce,
sharing plans with family members, and keeping pantry staples organized across a busy week.

The benchmark should not need this file for a meal-plan scheduling task. If this content
appears in the Codument context, the relevance check should fail because the registry has
included an irrelevant concept. The point is not that marketing copy is bad. The point is
that unrelated product language can consume context budget and distract an agent when it
is trying to modify scheduling logic.

Agents are often good at skimming large context, but large context is still not free. It
costs tokens, attention, and sometimes correctness when unrelated concepts look adjacent
to the requested feature. Codument should help route the agent toward the docs and files
that carry the actual implementation contract for the task at hand.
`;
