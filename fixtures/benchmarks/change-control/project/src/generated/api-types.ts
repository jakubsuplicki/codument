// AUTO-GENERATED — do not edit by hand.
// Planted scenario: this generated file is (incorrectly) listed in the
// `notifications` entry's primary_sources. The canonical exclusion spec must
// filter it out of BOTH the coverage numerator and denominator, and `doctor`
// should raise a generated-leakage lint.

export type ApiUser = { id: string; email: string };
export type ApiTask = { id: string; title: string; done: boolean };
export type ApiResponse<T> = { data: T; error: null } | { data: null; error: string };
