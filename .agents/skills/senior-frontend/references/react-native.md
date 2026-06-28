# React Native Mechanics

Framework-specific mechanics for building UIs with React Native (Expo or bare). The
platform-neutral judgment — component sizing, the state-management decision order,
measure-before-you-memoize, accessibility by default, every-loading-state-needs-an-
error-state — lives in `SKILL.md` and transfers unchanged. This file covers only
where React Native **diverges from web React**: styling, list virtualization,
navigation, performance, platform APIs, and accessibility props.

## Contents

- [What Carries Over, What Diverges](#what-carries-over-what-diverges)
- [Styling](#styling)
- [List Virtualization](#list-virtualization)
- [Navigation](#navigation)
- [Performance](#performance)
- [Platform APIs](#platform-apis)
- [Accessibility](#accessibility)
- [Motion](#motion)

## What Carries Over, What Diverges

Component design, the state-management order (local → lifted → context → external
store, derive-don't-sync), and TypeScript prop discipline are identical to web —
follow `SKILL.md`. The hooks (`useState`, `useReducer`, `useMemo`, `useCallback`,
`React.memo`) work the same way.

What changes is the primitives. There is no DOM: you compose `View`, `Text`,
`Image`, `Pressable`, `ScrollView`, and friends instead of `div`/`span`/`button`.
All text must be inside `<Text>` — bare strings under a `View` throw. There is no
CSS cascade, no `className` by default, and styling, lists, navigation, and platform
access each work differently. The rest of this file is those differences.

## Styling

- **`StyleSheet.create`** is the baseline. It returns plain style objects but
  validates keys and lets the runtime optimize. Define styles once at module scope,
  not inline per render, so you don't allocate a new object every frame.
- **Flexbox is the only layout system**, and the defaults differ from web:
  `flexDirection` defaults to `column` (web defaults to `row`), and every `View` is
  effectively `display: flex`. There is no grid and no `float`.
- **Units are unitless density-independent pixels.** No `px`, `rem`, `em`, or `%`
  strings for most properties (percentage strings are allowed for a few). There is
  no `gap` cascade across older RN versions — check your version or use margins.
- **No cascade and no pseudo-selectors.** No `:hover`, no descendant selectors. State
  styling (pressed, focused, disabled) is expressed by passing a style array or a
  function to `style`, e.g. `Pressable`'s `style={({ pressed }) => [...]}`.
- **NativeWind** brings Tailwind's `className` API to RN by compiling utility classes
  to `StyleSheet` objects at build time. Use it the way you'd use Tailwind on web —
  design tokens in `tailwind.config`, `cn()`/`clsx()` for conditional classes — but
  remember only the supported subset of utilities maps to native style props.

## List Virtualization

Never render a long list with `.map()` inside a `ScrollView` — that mounts every row
at once and will jank or crash on large data. Use a virtualized list:

- **`FlatList`** for a single flat data array. It windows rows, mounting only what's
  near the viewport.
- **`SectionList`** for grouped data with section headers (contacts, settings).
- **`FlashList`** (Shopify) as a drop-in, higher-performance replacement that recycles
  views instead of unmounting them; prefer it for large or media-heavy lists.

Make virtualized lists fast:
- Provide a stable `keyExtractor` returning a unique id per item — never the index.
- **Memoize the row component** (`React.memo`) and pass it a stable `renderItem`
  reference so unchanged rows don't re-render as you scroll.
- Provide **`getItemLayout`** when rows are a fixed height — it lets the list skip
  measurement and jump/scroll instantly. (FlashList wants an `estimatedItemSize`
  instead.)
- Tune `initialNumToRender`, `windowSize`, and `maxToRenderPerBatch` only after
  measuring a real scroll problem.

## Navigation

There is no URL bar or browser history — navigation is a native stack you manage.

- **React Navigation** is the de-facto library: stack, tab, and drawer navigators,
  typed routes, and screen options. Screens mount/unmount as the user pushes and pops.
- **Expo Router** layers file-based routing (à la Next.js `app/`) on top of React
  Navigation — files under `app/` become routes, with `_layout` files defining
  navigators. Choose it when you want the file-system routing convention; choose
  plain React Navigation when you want explicit navigator trees.
- Pass params through navigation, not through Context, for screen-to-screen data; keep
  Context for truly app-wide state as on web.

## Performance

- **Run on Hermes.** The Hermes engine (default in modern RN/Expo) gives faster
  startup and lower memory than JSC. Confirm it's enabled before chasing micro-opts.
- **Minimize bridge / serialization thrash.** On the old architecture, every JS↔native
  call crosses an asynchronous bridge; high-frequency chatter (per-frame state updates,
  large payloads each scroll tick) starves the UI thread. Batch work, debounce
  high-frequency events, and drive continuous animation off the UI thread (see Motion).
  The New Architecture (Fabric/JSI/TurboModules) removes the async bridge, but the
  habit of not flooding the boundary still pays off.
- **Memoize list rows** and stabilize `renderItem`/callbacks, as above — re-rendering
  rows during scroll is the most common RN jank source.
- **`getItemLayout`** to skip layout measurement on fixed-height lists.
- **Lazy-load heavy screens** and defer non-critical work off the first paint;
  keep image sizes sane and use a caching image component for remote media.

## Platform APIs

- **`Platform.OS`** is `'ios' | 'android' | 'web' | ...`; branch on it for the rare
  genuine platform difference.
- **`Platform.select({ ios, android, default })`** picks a value per platform —
  cleaner than `if` chains for styles or config.
- **`Platform.Version`** for OS-version gating.
- **Platform-specific files** (`Component.ios.tsx` / `Component.android.tsx`) let the
  bundler pick the right implementation automatically — use them when an entire
  component diverges, rather than littering one file with `Platform` checks.
- **Safe areas:** account for notches and home indicators with
  `react-native-safe-area-context` rather than hardcoding insets.

## Accessibility

The judgment is identical to web (everything reachable, labeled, adequate contrast),
but the props differ — there is no HTML semantics to inherit, so you declare them:

- **`accessible`** marks a view as a single accessibility element (groups children).
- **`accessibilityLabel`** is the spoken name (web's accessible name / `aria-label`).
- **`accessibilityHint`** describes what happens on activation.
- **`accessibilityRole`** declares the element's type (`"button"`, `"link"`,
  `"header"`, `"image"`, `"adjustable"`, …) — the analog of choosing a semantic HTML
  element, since `View`/`Text` carry no implicit role.
- **`accessibilityState`** communicates state (`{ disabled, selected, checked,
  expanded, busy }`) — the analog of ARIA state attributes.
- **`accessibilityValue`** for sliders and progress (`min`/`max`/`now`/`text`).
- Prefer **`Pressable`** (or `TouchableOpacity`) over a touchable `View`; like
  preferring `<button>` on web, it gives correct focus and screen-reader behavior.
- Test with **VoiceOver (iOS)** and **TalkBack (Android)**, the native analog of a
  screen-reader pass.

## Motion

For animation and gestures — deciding whether to animate, easing/duration/springs,
drawers/sheets/toasts, drag-to-dismiss, or fixing janky motion — **defer to the
`motion-craft` skill**. It covers the React Native motion layer (Reanimated +
Gesture Handler) and maps the web motion philosophy onto native. Do **not** duplicate
Reanimated or Gesture Handler guidance here.
