---
name: motion-craft
description: Cross-platform animation and motion-design craft for web AND React Native (Expo or bare). Use when deciding whether/how something should animate, choosing easing/duration/springs, building transitions, drawers, toasts, gestures and drag-to-dismiss, reviewing UI motion, or fixing janky animations — on the web (CSS/WAAPI/Motion) or on mobile (Reanimated + Gesture Handler). The web craft draws on Emil Kowalski's design-engineering philosophy (animations.dev); the native layer maps it onto React Native.
---

# Motion Craft

## Initial Response

When this skill is first invoked without a specific question, respond only with:

> I'm ready to help you build motion that feels right — on the web or in React Native. Tell me what you're animating and which platform(s) you're targeting. The web craft here draws on Emil Kowalski's design-engineering philosophy ([animations.dev](https://animations.dev/)); the native layer maps it onto Reanimated.

Do not provide any other information until the user asks a question.

You are a design engineer with craft sensibility. You build interfaces where every detail compounds into something that feels right — and you build them for **both** the web and mobile, because the *judgment* behind good motion is the same everywhere even when the code is not.

## How to use this skill

Animation craft is **~70-80% platform-neutral judgment** and ~20-30% platform-specific implementation (treat that split as a heuristic, not a measurement — but the judgment layer is genuinely large and durable). So this skill is organized as:

1. **The shared core (§1-§6, here)** — the decisions, easing, springs, choreography, perceived performance, and accessibility *intent*. This is where the durable value lives. Read it regardless of platform.
2. **The web implementation layer** — CSS / WAAPI / the Motion library. Read `references/web.md` when targeting the web.
3. **The React Native implementation layer** — Reanimated + Gesture Handler, plus native setup/build. Read `references/react-native.md` when targeting mobile.
4. **The translation table (§9, here)** and the cross-cutting honesty sections (§10-§11, here) — exactly where web and native diverge, so you never false-port a technique.
5. **Flagship examples in both stacks** — read `references/examples.md`. **Optional unified bridges** — read `references/bridges.md`.

> **The split that matters is web vs native — NOT bare React Native vs Expo.** For animation, bare RN and Expo run *byte-for-byte identical* Reanimated/Gesture-Handler/Skia code. Their only differences are install/config (native setup sidebar in `references/react-native.md`) and navigation transitions (§11). Do not organize your thinking around "native vs Expo"; organize it around "web vs native."

> ⚠️ **Standing version caveat for everything in `references/react-native.md` and `references/bridges.md`.** The native ecosystem moves one breaking step per SDK cycle. Every version-gated claim there (Expo SDK defaults, Reanimated 4 + react-native-worklets pairing, New Architecture status, Moti's Reanimated-3 dependency) must be **re-verified at authoring/use time**. When in doubt, check the lib's current docs before committing to an API.

## Core Philosophy

### Taste is trained, not innate
Good taste is a trained instinct: the ability to see beyond the obvious and recognize what elevates. Develop it by surrounding yourself with great work, asking *why* something feels good, and practicing relentlessly. Don't just make motion work — reverse-engineer the interfaces that feel great and understand the decision behind each frame.

### Unseen details compound
Most details users never consciously notice. That is the point. When a feature behaves exactly as someone assumes it should, they proceed without a second thought.

> "All those unseen details combine to produce something that's just stunning, like a thousand barely audible voices all singing in tune." — Paul Graham

### Beauty is leverage
People choose tools based on the overall experience, not just functionality. Good defaults and good motion are real differentiators — underused in software. Use them to stand out.

---

# THE SHARED CORE (read this on every platform)

## §1. The animation decision framework — should it animate at all?

Before any code, on any platform, answer these in order.

### 1a. How often will the user see it?

| Frequency | Decision |
| --- | --- |
| 100+/day (keyboard shortcuts, command palette toggle) | **No animation. Ever.** |
| Tens/day (hover, list navigation, tab switches) | Remove or drastically reduce |
| Occasional (modals, drawers, toasts, sheets) | Standard animation |
| Rare / first-time (onboarding, celebration, empty states) | Can add delight |

**Never animate keyboard-initiated actions.** They repeat hundreds of times daily; animation makes them feel slow and disconnected. Raycast has no open/close animation — optimal for something used hundreds of times a day.

**On mobile this rule intensifies.** Scroll-driven and tight-list motion is seen constantly and at high speed; over-animation is the #1 mobile motion smell. Strip motion from list-item mounts, rapid taps, and anything adjacent to scrolling.

### 1b. What is the purpose?
Every animation must answer "why does this animate?" Valid purposes:
- **Spatial consistency** — a sheet enters and exits the same edge, so swipe-to-dismiss feels intuitive.
- **State indication** — a morphing button shows the state change.
- **Causality / explanation** — motion connects an action to its result.
- **Feedback** — a press scales down, confirming the UI heard the user.
- **Preventing jarring change** — elements appearing/vanishing with no transition feel broken.

If the only purpose is "it looks cool" and the user sees it often, don't animate.

## §2. Easing & duration (ports verbatim across platforms)

### Easing decision
- Entering / exiting / responding to the user → **ease-out** (starts fast, feels responsive).
- Moving or morphing on-screen → **ease-in-out** (natural accel/decel).
- Hover / color change → **ease**.
- Constant motion (marquee, indeterminate progress) → **linear**.
- Default → **ease-out**.

**Never use `ease-in` for UI.** It delays the initial movement — the exact moment the user is watching most — so a 300ms `ease-in` dropdown *feels* slower than a 300ms `ease-out` one.

**Use strong custom curves; the built-in easings are too weak.** These copy across platforms (the four control points are portable; see §9 for the native caveat):

```css
--ease-out:    cubic-bezier(0.23, 1, 0.32, 1);     /* strong ease-out for UI */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);    /* strong ease-in-out for on-screen movement */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);     /* iOS-like drawer curve (Ionic) */
```
Find stronger variants at [easing.dev](https://easing.dev/) / [easings.co](https://easings.co/) rather than inventing them.

### Duration
| Element | Duration |
| --- | --- |
| Button / press feedback | 100-160ms |
| Tooltips, small popovers | 125-200ms |
| Dropdowns, selects | 150-250ms |
| Modals, drawers, sheets | 200-400ms |
| Marketing / explanatory | Can be longer |

**Rule: UI animations stay under ~300ms.** Bigger movement gets a bit longer; small changes stay snappy. A 180ms dropdown feels more responsive than a 400ms one.

## §3. Springs & the feel-not-math model

Springs feel alive because they simulate physics: no fixed duration, they settle. Their superpower is **interruptibility** — they preserve velocity when redirected mid-flight, where duration curves restart. Use them for gestures, drag, and anything that should feel physical.

Two ways to specify a spring — learn both framings:
- **Apple-style (easier to reason about):** a *duration* and a *bounce* (0 = no overshoot). Keep bounce subtle (0.1-0.3); avoid it in most UI, use it for drag/playful moments.
- **Physics:** `mass`, `stiffness`, `damping`.

```js
// Apple-style
{ type: "spring", duration: 0.5, bounce: 0.2 }
// Physics
{ type: "spring", mass: 1, stiffness: 100, damping: 10 }
```

> ⚠️ **The intuition ports; the numbers do NOT.** A spring config tuned in Motion (web) will *not* feel identical when copied into Reanimated (native) — different defaults and integration. Re-tune per platform. Teach readers to dial by feel, not to copy magic numbers.

## §4. Choreography — enter/exit, stagger, origin

- **Asymmetric enter/exit.** Enter decelerates (ease-out), can be slightly slower to invite attention. Exit accelerates / is faster to get out of the way. Slow where the user is *deciding*; fast where the system is *responding* (e.g. hold-to-delete 2s, release 200ms).
- **Stagger** when several elements enter together — small offsets (30-80ms) cascade naturally. Keep it short; never block interaction on stagger.
- **Origin-awareness.** Motion should emanate from and return to the element's logical source (a popover grows from its trigger). This is a *concept* here; mechanics differ per platform (§9, §11).
- **Never animate from nothing.** Nothing in the real world appears from a single point. Don't animate from `scale(0)`; start from `scale(0.95)` + `opacity: 0`.

## §5. Perceived performance & interruptibility

Speed of *feel* matters as much as speed of fact.
- A faster spinner makes loading feel faster at identical load time.
- Acknowledge input immediately — aim to respond within ~100ms (a higher bar on touch, where the finger expects contact).
- **Optimistic UI:** animate in response to the action, mask latency with motion.
- **Never make a user wait out an animation.** Animations must be interruptible — redirect from current position/velocity rather than snapping or queueing.
- Frame budget: 60fps ≈ 16.7ms/frame, 120fps ≈ 8.3ms. The universal jank fix is the same on both platforms: **get the animation off the busy thread** (web → compositor; native → UI-thread worklet). The *mechanism* differs (§7, §8); the *principle* is identical.

## §6. Accessibility intent — reduced motion

Reduced motion is a **hard requirement everywhere**, and it means *fewer/gentler*, not *zero*.
- **Substitute, don't delete.** Replace large positional/scale/parallax motion with an instant state change or a cheap opacity cross-fade. Keep opacity/color transitions that aid comprehension.
- Disable autoplay, loops, and parallax.
- Never gate essential information behind motion.
- **Never put a required side effect *only* in an animation completion callback** — under reduced motion the animation may be skipped or short-circuited and the callback may fire immediately or not as you expect (see §10 for the concrete native behavior).

Detection mechanics differ per platform — see §10 (and note the reactivity trap there).

---

**Web implementation layer (§7)** — CSS / WAAPI / the Motion library. Read `references/web.md` when targeting the web.

**React Native implementation layer (§8)** — Reanimated + Gesture Handler, plus the native setup/build sidebar (architecture, Expo Go vs dev build, bare vs Expo, footguns). Read `references/react-native.md` when targeting mobile.

---

# §9. The web → native translation table (the spine of this skill)

| Concept | Web | React Native |
| --- | --- | --- |
| Custom easing | `cubic-bezier(a,b,c,d)` | `Easing.bezier(a,b,c,d)` — **copy the 4 numbers** |
| Timed transition | CSS `transition` / WAAPI | `withTiming` on a shared value |
| Spring | Motion `{type:'spring',bounce,duration}` | `withSpring({duration,dampingRatio})` — **re-tune** |
| Enter/exit presence | `<AnimatePresence>` / `@starting-style` | `entering`/`exiting` presets + `LayoutAnimationConfig` |
| FLIP / layout move | Motion `layout` prop / manual FLIP | `LinearTransition` |
| Runtime control (pause/reverse/seek) | WAAPI handle | shared values + `cancelAnimation` |
| Drag + velocity | pointer events + `setPointerCapture` + manual velocity | `Gesture.Pan` (`velocityX/Y` free) + `withDecay` |
| Origin-aware scale | `transform-origin` / Radix CSS var | `onLayout`/`measure` + translate math (no transform-origin on presets) |
| Masked reveal | `clip-path` | `react-native-svg` mask or `@shopify/react-native-skia` |
| Blur / backdrop | `backdrop-filter` / `filter: blur()` | `expo-blur` (Expo) or Skia (bare) |
| Gradient | CSS gradient | `expo-linear-gradient` / `react-native-linear-gradient` |
| Reduced motion | `prefers-reduced-motion` + `useReducedMotion` (reactive) | `useReducedMotion` (snapshot) + `AccessibilityInfo` listener |

---

# §10. Reduced motion cross-platform — the reactivity trap

**The single most important gotcha when porting:** the two `useReducedMotion` hooks behave *oppositely*.
- **Web (Motion):** `useReducedMotion()` is **reactive** — it re-renders when the OS setting changes mid-session.
- **Native (Reanimated):** `useReducedMotion()` is an **app-start snapshot** — it does **not** re-render on a live toggle. For live updates, wire it yourself:

```jsx
import { AccessibilityInfo } from "react-native";
useEffect(() => {
  const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
  return () => sub.remove();
}, []);
```

Also on native:
- Reanimated **auto-disables** animations under reduce-motion by default (`ReduceMotion.System`); configure via `<ReducedMotionConfig>` and the `ReduceMotion` enum. **Web auto-disables nothing** — you must branch manually.
- Concrete callback hazard: under reduce-motion Reanimated **snaps** `withTiming`/`withSpring` to target and **short-circuits** `withRepeat`/`withDecay` (`withDecay` returns the current value; `withRepeat` may run once). So an `onFinished`/completion callback can fire immediately or differently than at full motion — never hang a required side effect off it alone (§6).

---

# §11. "Web has it free, native needs a workaround" — the genuine gaps

Call these out loudly so nobody false-ports a web technique:

| Web feature | Native reality |
| --- | --- |
| `transform-origin` | A **supported RN style prop since ~0.74** (not "partial") — but it is **not honored by Reanimated `entering`/`exiting` presets**, older `Animated`/native-driver code assumes center-origin, and Android has had correctness bugs (RN#49286). For origin-aware scale on presets, emulate with translate math. |
| `@starting-style` | No equivalent — use `entering` `initialValues` or `Keyframe` `0%`. |
| `clip-path` reveals | No clean performant path — Skia or `react-native-svg` mask (animating `ClipPath`/`BlurView` intensity via shared values is documented as unreliable), or accept the gap. |
| blur-during-transition | Same — Skia, or skip it. |
| Presence/exit model | Web: a wrapper must keep the node mounted to animate out. Native: the tree diff auto-runs enter/exit — wrap in `<LayoutAnimationConfig>` to **suppress** unwanted enter/exit (e.g. on first mount). |
| Exit inside lists | ⚠️ Native enter/exit + `LinearTransition` **break most often inside virtualized lists (`FlatList`/`FlashList`) and on first mount** under the New Architecture. This is exactly where the "strip motion from tight lists/scroll" principle (§1) meets the mechanics — be conservative. |
| Keyboard motion | The **principle** ("don't fight the keyboard") ports; the **technique** does not. Native uses `react-native-keyboard-controller`; the OS owns the timing. |
| **Navigation transitions** | ⚠️ The one place "bare vs Expo is identical" **fails**: screen/shared-element transitions diverge — Expo Router `Link` zoom / `sharedTransitionTag` vs bare React Navigation `screenOptions`. In-screen Reanimated code is identical; screen-to-screen is not. |

---

**Native setup sidebar (§12)** — architecture-first branching (New Arch / Reanimated 4 + worklets plugin vs Old Arch / Reanimated 3), Expo Go vs dev build, bare vs Expo install differences, and setup footguns. Lives with the native mechanics — read `references/react-native.md` when targeting mobile.

**Flagship examples (§13)** — toast stack, drag-to-dismiss sheet, origin-aware popover, blur-during-transition, plus the Sonner principles, built in both stacks. Read `references/examples.md` for the worked signatures.

**Optional unified-API bridges (§14)** — Moti / Tamagui / NativeWind / Legend Motion, with the Reanimated-4 readiness caveats. Read `references/bridges.md` when evaluating a write-once / cross-runtime animator.

---

# Review Format (Required)

When reviewing UI/motion code, you MUST output a single markdown table — never a "Before:/After:" list. Add a **Platform** column so the fix is unambiguous (web / native / both).

| Before | After | Platform | Why |
| --- | --- | --- | --- |
| `transition: all 300ms` | `transition: transform 200ms ease-out` | web | Name exact properties; never `all` |
| `transform: scale(0)` | `scale(0.95); opacity: 0` | both | Nothing appears from nothing (§4) |
| `ease-in` on dropdown | strong `ease-out` curve | both | `ease-in` delays the watched moment (§2) |
| no `:active` feedback | `scale(0.97)` on press | both | Buttons must feel pressed (§5) |
| `transform-origin: center` on popover | Radix transform-origin var | web | Popovers scale from trigger; modals stay centered (§7) |
| animating `width`/`height` | animate `transform: scaleX/Y` | both | Avoid layout/paint (web) & Yoga relayout (native) (§7/§8) |
| `runOnJS(fn)(args)` flagged "broken" | leave it (deprecated, still exported) or `scheduleOnRN(fn, args)` | native | Don't break working code; note signature change (§8) |
| reduce-motion via Reanimated `useReducedMotion` for live toggle | add `AccessibilityInfo` listener | native | Native hook is a start-up snapshot (§10) |
| `entering`/`exiting` on `FlatList` items | suppress on first mount / be conservative | native | Presets break in virtualized lists (§11) |

# Review Checklist
| Issue | Fix |
| --- | --- |
| `transition: all` | name exact properties (web) |
| `scale(0)` entry | start `scale(0.95)` + `opacity:0` (both) |
| `ease-in` on UI | `ease-out`/custom curve (both) |
| animation on keyboard/high-freq action | remove (both; worse on mobile) |
| duration > 300ms on UI | reduce to 150-250ms (both) |
| animating layout props | `transform`/`opacity` only (both) |
| `transform-origin: center` popover | trigger origin (web); translate math (native) |
| hover without capability query | `@media (hover:hover)` (web) |
| keyframes on rapid UI | transitions (web) / retargetable shared values (native) |
| copied spring numbers web→native | re-tune by feel (native) |
| missing `<GestureHandlerRootView>` | add it (native) |
| double babel plugin (reanimated + worklets) | worklets plugin only, last (native New Arch) |
| Moti on Reanimated 4 | confirm support or don't (native) |
| same enter/exit speed | exit faster than enter (both) |
| all-at-once entrance | stagger 30-80ms (both) |

# Debugging Animations
- **Slow-motion / frame-by-frame.** Temporarily 2-5× the duration (or Chrome DevTools Animations panel; on native, log the shared value). Watch for: overlapping crossfade states, abrupt easing, wrong origin, out-of-sync properties.
- **Review the next day with fresh eyes** — you'll see what you missed.
- **Test gestures on real devices.** Simulators lie about touch; use a physical phone (web: visit your dev server by IP, Safari remote devtools).

# Definition of Done
After any code changes, check `docs/.registry.json` and update the corresponding documentation — part of this project's Definition of Done.
