---
name: senior-frontend
description: >
  Build modern, performant frontend UIs: component design, state management,
  rendering performance, and accessibility. Covers React and Next.js (web) plus
  React Native, with framework-specific mechanics in reference files; the judgment
  applies cross-framework. Use whenever the user builds or optimizes UI components,
  manages client or server state, or fixes frontend performance including list
  virtualization and scroll or render jank (e.g. FlatList). Do NOT use for
  visual or aesthetic design direction (use frontend-design), or for animation and
  gesture craft (use motion-craft).
---

# Frontend Development

This skill is the platform-neutral judgment layer for building UIs. The principles
below hold whether you target the web or native. Framework-specific mechanics
(the actual API names, files, and config) live in the reference files at the end —
read the one that matches your target before writing code.

## Component design

The unit of a UI is a component. Get its size and boundaries right and most other
problems shrink.

- **One component per file**, named to match the export. Co-locate its styles,
  tests, and types.
- **Sizing threshold**: keep a component focused. When it pushes past ~200 lines or
  starts doing two unrelated jobs (fetching *and* laying out *and* branching on
  three states), split it. Length is a smell, not a law — a long but linear render
  is fine; a medium one juggling four concerns is not.
- **Extraction threshold**: extract a shared component only when it is genuinely
  reused (the rule of three — pull it out at the third copy, not the first).
  Premature shared components calcify into the wrong abstraction. Duplication is
  cheaper to fix than the wrong shape.
- **Props are a contract**: type them precisely. Prefer a closed set
  (`"sm" | "md" | "lg"`) over an open one (`string`). The narrower the prop type,
  the more the compiler does your reviewing for you.

## State management

Reach for the *least powerful* tool that holds the state, and escalate only when
you feel the pain. The decision order:

1. **Local first.** State that only one component cares about lives in that
   component. Most state is local.
2. **Lift when shared.** When two siblings need the same value, lift it to their
   nearest common parent — and no higher. Lifting too far makes everything below
   re-render.
3. **Context for truly global, low-churn state.** Theme, auth, locale, current
   user. Context is for things that are genuinely app-wide and change rarely. It is
   *not* a fix for prop drilling through two levels, and it is *not* a state
   manager — every consumer re-renders when the value changes.
4. **External store for high-churn or server-cache state.** Cross-cutting state
   that updates often, or that mirrors the server, belongs in a dedicated store or
   data-fetching library, not in Context.

The rule that overrides all four: **derive, don't sync.** Never copy one piece of
state into another and keep them in lockstep with effects. If a value can be
computed from existing state or props, compute it during render. State you sync is
state that drifts.

## Rendering performance

- **Measure before you memoize.** Memoization is not free — it adds allocation and
  complexity, and most components are already fast enough. Profile first, find the
  component that actually re-renders too often or computes something genuinely
  expensive, then memoize *that one*. Sprinkling memoization preventively makes
  code slower to read and rarely faster to run.
- **Stable identity matters.** Lists need stable, unique keys tied to the data, not
  array indices. Callbacks and objects passed to memoized children must keep a
  stable reference or the memoization is defeated.
- **Defer what isn't needed yet.** Lazy-load routes and heavy, below-the-fold, or
  rarely-hit components. Split the bundle along the lines users actually traverse.
- **Big lists need virtualization.** Rendering thousands of rows at once janks. Use
  the platform's windowing/virtualization primitive so only visible rows mount.

## Accessibility by default

Accessibility is not a pass at the end — it is the default way you build.

- **Semantic elements first.** Use the real interactive primitive (a button, a
  link, a labeled input) rather than re-implementing one on a generic container.
  You get focus, keyboard handling, and assistive-tech semantics for free.
- **Every control is reachable and labeled.** Keyboard (or platform equivalent)
  must reach every action; every interactive element exposes an accessible name.
- **Visible focus.** Interactive elements show a clear focus state. Never strip it
  without replacing it.
- **Adequate contrast.** Text meets a 4.5:1 contrast ratio.
- **Accessibility APIs are the escape hatch, not the default.** Reach for explicit
  accessibility attributes only when the semantic primitive can't express it.

## Loading and errors

- **Every loading state needs an error state.** Async work has three outcomes —
  pending, success, failure. A spinner without an error path is a bug waiting for a
  flaky network. Design all three before you ship the happy path.
- **Don't manually sync server state.** Server data is a cache, not local state. Use
  the platform's data-fetching layer so caching, revalidation, and error states
  come built in.

## Architecture hygiene

- **Keep data-fetching out of the render body.** Extract API calls into hooks,
  loaders, or server-side code — components should consume data, not orchestrate
  its retrieval.
- **Test behavior, not implementation.** Assert what the user sees and does, not
  internal state names. Tests coupled to implementation break on every refactor.

## Framework selection

Choose the target before reaching for mechanics:

- **React (web)** for in-browser SPAs and embedded UI where you control the host
  page.
- **Next.js** when you want server rendering, routing, and data-fetching
  conventions out of the box — content sites, app shells, anything that benefits
  from server components and SSR/SSG.
- **React Native** for iOS/Android apps from a shared codebase. The judgment above
  transfers; the primitives (views instead of DOM, native navigation, list
  virtualization, platform APIs) differ — see its reference.

The judgment on this page is the same across all three. Only the mechanics differ,
and those live in the references below.

## Motion and animation

For anything beyond a basic, static transition — deciding *whether* to animate,
choosing easing/duration/springs, building drawers/toasts/sheets, gestures and
drag-to-dismiss, or reviewing and fixing janky motion — **invoke the `motion-craft`
skill** instead of hand-rolling it. It covers both web (CSS/WAAPI/Motion) and React
Native (Reanimated + Gesture Handler). Do not duplicate motion guidance here or in
the references.

## References

Read the file that matches your target before writing framework-specific code:

- `references/react.md` — read this when targeting **React or Next.js on the web**:
  Server Components and `"use client"`, `loading.tsx`/`error.tsx`, `next/dynamic`,
  `React.memo`/`useMemo`/`useCallback`, Tailwind (`@apply`, `tailwind.config`), web
  performance, and HTML/ARIA accessibility.
- `references/react-native.md` — read this when targeting **React Native** (Expo or
  bare): StyleSheet/Flexbox and NativeWind, FlatList/SectionList/FlashList
  virtualization, React Navigation / Expo Router, Hermes and bridge performance,
  Platform APIs, and RN accessibility props.

## Definition of Done

After making any code changes, run `codument context --file <path> --owner` to find the owning doc — one line, not a read of the whole registry — and update it.
This is part of the project's Definition of Done.
