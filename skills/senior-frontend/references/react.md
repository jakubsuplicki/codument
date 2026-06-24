# React & Next.js (Web) Mechanics

Framework-specific mechanics for building UIs with React, Next.js, TypeScript, and
Tailwind CSS on the **web**. The platform-neutral judgment (component sizing, the
state-management decision order, measure-before-you-memoize, accessibility by
default, every-loading-state-needs-an-error-state) lives in `SKILL.md`; this file is
the concrete how on the web.

## Contents

- [Component Design](#component-design)
- [State Management](#state-management)
- [Performance](#performance)
- [Styling](#styling)
- [Accessibility](#accessibility)
- [Rules](#rules)

## Component Design

### Structure
- One component per file, named to match the export
- Co-locate styles, tests, and types with the component
- Extract shared components only when used in 3+ places
- Keep components under 200 lines — split when they do too much

### Props
- Use TypeScript interfaces for all props — no `any`
- Prefer specific types over broad ones: `"sm" | "md" | "lg"` not `string`
- Destructure props in the function signature for readability
- Default optional props at the destructuring site, not with `defaultProps`

### State Management
- Local state first (`useState`), lift only when needed
- Use `useReducer` for complex state with multiple related fields
- Context for truly global state (theme, auth, locale) — not for prop drilling avoidance
- External state libraries (Zustand, Jotai) for server cache or cross-component state
- Never put derived data in state — compute it

## Performance

### Rendering
- Avoid unnecessary re-renders: `React.memo` only when measured, not preventively
- Move expensive computations to `useMemo` — but measure first
- Stabilize callback references with `useCallback` when passed to memoized children
- Use `key` props correctly — stable IDs, not array indices for dynamic lists

### Loading
- Lazy-load routes and heavy components with `React.lazy` / `next/dynamic`
- Optimize images: proper sizes, modern formats (WebP/AVIF), lazy loading
- Minimize bundle size — check imports, avoid barrel file re-exports in libraries
- Prefetch critical data, defer non-critical requests

### Next.js Specific
- Use Server Components by default — add `"use client"` only when needed
- Fetch data in Server Components, not in client `useEffect`
- Use `loading.tsx` and `error.tsx` for route-level loading/error states
- Leverage ISR or static generation for content that doesn't change per-request

## Styling

### Tailwind CSS
- Extract repeated patterns into component abstractions, not `@apply` classes
- Use design tokens via `tailwind.config` — don't hardcode colors or spacing
- Keep className strings readable — break to multiple lines if long
- Use `cn()` or `clsx()` for conditional classes

### General
- Maintain consistent spacing scale (4px/8px/16px/32px)
- Design mobile-first, enhance for larger screens
- Ensure all interactive elements have visible focus states
- Test with keyboard navigation — not just mouse

## Accessibility

- Semantic HTML first: `<button>` not `<div onClick>`
- All images need `alt` text — decorative images get `alt=""`
- Form inputs need associated `<label>` elements
- ARIA attributes only when HTML semantics aren't sufficient
- Ensure 4.5:1 color contrast ratio for text

## Rules

- Don't optimize before measuring — React DevTools Profiler is your friend
- Don't sync server state manually — use React Query / SWR
- Don't put API calls in components — extract to hooks or server actions
- Test user behavior, not implementation details
- Every loading state needs an error state too

## Motion

For anything beyond a basic CSS transition — deciding whether to animate, choosing
easing/duration/springs, building drawers/toasts/sheets, gestures and
drag-to-dismiss, or reviewing/fixing janky motion — invoke the `motion-craft` skill
instead of hand-rolling it. It covers web (CSS/WAAPI/Motion). Animate only
`transform`/`opacity` for compositor-thread performance; never animate
layout-triggering properties (`width`, `height`, `top`, `margin`).
