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

1. **The shared core (§1-§6)** — the decisions, easing, springs, choreography, perceived performance, and accessibility *intent*. This is where the durable value lives. Read it regardless of platform.
2. **The web implementation layer (§7)** — CSS / WAAPI / the Motion library.
3. **The React Native implementation layer (§8)** — Reanimated + Gesture Handler.
4. **The translation table (§9)** and the cross-cutting honesty sections (§10-§12) — exactly where web and native diverge, so you never false-port a technique.
5. **Flagship examples in both stacks (§13)** and **optional unified bridges (§14)**.

> **The split that matters is web vs native — NOT bare React Native vs Expo.** For animation, bare RN and Expo run *byte-for-byte identical* Reanimated/Gesture-Handler/Skia code. Their only differences are install/config (§12) and navigation transitions (§11). Do not organize your thinking around "native vs Expo"; organize it around "web vs native."

> ⚠️ **Standing version caveat for everything in §8, §12, §14.** The native ecosystem moves one breaking step per SDK cycle. Every version-gated claim here (Expo SDK defaults, Reanimated 4 + react-native-worklets pairing, New Architecture status, Moti's Reanimated-3 dependency) must be **re-verified at authoring/use time**. When in doubt, check the lib's current docs before committing to an API.

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

# §7. WEB IMPLEMENTATION LAYER

### The library: it's `motion` now
Framer Motion was renamed. Use package **`motion`**, import from **`motion/react`**, docs at **motion.dev**. (`framer-motion` still resolves as the legacy package, but new code should use `motion`.)

```jsx
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
```

### Performance rule (web-specific)
Animate **`transform` and `opacity`** (and `filter` when needed) — these can run on the **compositor thread**, skipping layout and paint. Animating `width`/`height`/`margin`/`top` triggers layout + paint on the main thread.
- `will-change` / `translateZ(0)` promote a layer — use *sparingly*; over-promotion is its own anti-pattern (memory, too many layers).
- Avoid layout thrashing (interleaved read/write of layout properties in a frame).
- **WAAPI caveat:** `element.animate()` only composites the *same* properties CSS does (transform/opacity/filter). Animating any other property via WAAPI runs on the main thread exactly like CSS — WAAPI is not categorically off-main-thread.

### Buttons must feel responsive
```css
.button { transition: transform 160ms ease-out; }
.button:active { transform: scale(0.97); }   /* subtle: 0.95-0.98 */
```

### Enter without JS — `@starting-style`
```css
.toast {
  opacity: 1; transform: translateY(0);
  transition: opacity 400ms ease, transform 400ms ease;
  @starting-style { opacity: 0; transform: translateY(100%); }
}
```
- Enter via `@starting-style` is Baseline (since ~FF129 / 2024). It only applies on the element's **first** style update.
- **Full exit** via animated `display`/`overlay`/`transition-behavior: allow-discrete` is **not yet Baseline** — for robust exit choreography use Motion's `<AnimatePresence>`.
- Legacy fallback everywhere: `useEffect(() => setMounted(true), [])` + `data-mounted`.

### Presence / exit — `<AnimatePresence>`
Wrap exiting elements so they survive unmount long enough to animate out.
> **Web exit isn't free either.** Watch for: the `layout` prop conflicting with your own `transform`; `mode="popLayout"`/`"wait"` semantics; and the hard requirement that each child has a stable `key`. Treat the web presence model with the same suspicion as the native one (§11).

### Origin-aware popovers
Default `transform-origin: center` is wrong for almost every popover. Scale from the trigger:
```css
.popover { transform-origin: var(--radix-popover-content-transform-origin); } /* Radix */
.popover { transform-origin: var(--transform-origin); }                       /* Base UI */
```
**Exception: modals keep `transform-origin: center`** — they aren't anchored to a trigger.

### CSS transitions over keyframes for interruptible UI
Transitions retarget mid-flight; `@keyframes` restart from zero. For rapidly-triggered UI (toasts, toggles) use transitions. Use `@keyframes`/WAAPI for predetermined motion.

### clip-path (web-only superpower)
`clip-path: inset(top right bottom left)` for reveals, hold-to-delete overlays, tabs with perfect color transitions, comparison sliders, scroll reveals. **There is no clean, performant native equivalent** (§11).

### Reduced motion (web)
```css
@media (prefers-reduced-motion: reduce) { .element { animation: fade 0.2s ease; /* no transform motion */ } }
```
```jsx
const reduce = useReducedMotion();           // reactive: re-renders when the OS setting flips
const closedX = reduce ? 0 : "-100%";
```

### Touch-vs-pointer on web
Gate hover behind capability so touch taps don't trigger false hovers:
```css
@media (hover: hover) and (pointer: fine) { .element:hover { transform: scale(1.05); } }
```

---

# §8. REACT NATIVE IMPLEMENTATION LAYER (Reanimated + Gesture Handler)

> Identical for Expo and bare RN. Setup differs — see §12.

### Core primitives (run on the UI thread via worklets)
```jsx
import Animated, {
  useSharedValue, useAnimatedStyle,
  withTiming, withSpring, withDecay,
  Easing, FadeIn, SlideInUp, LinearTransition,
} from "react-native-reanimated";

const x = useSharedValue(0);
const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

x.value = withTiming(100, { duration: 220, easing: Easing.bezier(0.23, 1, 0.32, 1) });
```

### Timing, spring, decay
- `withTiming(to, { duration, easing })` — `Easing.bezier(x1,y1,x2,y2)` takes the **same four control points** as your CSS `cubic-bezier` (copy the numbers; see §9 caveat).
- `withSpring(to, config)` — **two mutually-exclusive modes**: physics `{ mass, stiffness, damping }` **or** perceptual `{ duration, dampingRatio }`. (Reanimated 4 adds `energyThreshold` for rest detection.) Re-tune from your web values.
- `withDecay({ velocity, deceleration, clamp, rubberBand })` — momentum/fling and the basis of velocity-based dismissal.

### Performance rule (native-specific)
Keep animation on the **UI thread** via worklets (Reanimated does this by default) so it survives a busy JS thread. Even on the UI thread, prefer **`transform`/`opacity`** — animating `width`/`height`/`flex` re-runs **Yoga layout** every frame.

### Enter/exit & layout — simpler than the web here
- `entering`/`exiting` presets: `FadeIn`, `SlideInUp`, `ZoomIn`, … with `.springify()`, `.duration()`, `.delay()`.
- `LinearTransition` is the built-in FLIP/layout answer (web needs Motion's `layout` prop or manual FLIP).
- `Keyframe` API for multi-step.

```jsx
<Animated.View entering={FadeIn.duration(220)} exiting={FadeIn.duration(150)} layout={LinearTransition} />
```
> ⚠️ **`LinearTransition` is simpler to *invoke*, not simpler to *get right*.** It is finicky inside virtualized lists, with nested layouts, and on first mount under the New Architecture (§11). Expect to debug it in real lists.

### Gestures & drag (full Gesture Handler API)
```jsx
import { Gesture, GestureDetector } from "react-native-gesture-handler";

const pan = Gesture.Pan()
  .onUpdate(e => { translateY.value = e.translationY; })
  .onEnd(e => {
    // velocity comes free — momentum dismissal without measuring time yourself
    translateY.value = withDecay({ velocity: e.velocityY, clamp: [0, SHEET_HEIGHT] });
  });
// <GestureDetector gesture={pan}><Animated.View style={style} /></GestureDetector>
```
- Wrap the app in **`<GestureHandlerRootView>`** (footgun: forgetting it = gestures silently dead).
- `simultaneousWithExternalGesture(scrollRef)` for drag-inside-a-scrollview.
- Multi-touch protection, pointer capture, boundary damping → all expressed in `onUpdate`/`onEnd` math.

### Crossing threads: `runOnJS` → `scheduleOnRN`
- `runOnJS` / `runOnUI` are **still re-exported from `react-native-reanimated` but deprecated**. Existing `runOnJS(fn)(...args)` code keeps working — do **not** tell readers it's broken.
- New preferred names live in `react-native-worklets`: **`scheduleOnRN`** / `scheduleOnUI`. **The call signature changed:** `scheduleOnRN(fn, ...args)` — *not* `scheduleOnRN(fn)(...args)`. This is a real migration footgun.

### Legacy
The old `Animated` API + `useNativeDriver: true` exists in older code — recognize it, but author new motion in Reanimated. `useAnimatedGestureHandler` was **removed in Reanimated 4** — use the `Gesture` API above.

### Reduced motion (native) — see §10 for the reactivity trap.

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

# §12. Native setup sidebar (NOT a principles axis)

Branch your *setup* in this order — none of it changes the animation code:

1. **Architecture first.** New Architecture is the SDK 53+ default, **forced from SDK 55+** (RN 0.76+):
   - New Arch → **Reanimated 4** + `react-native-worklets` + the **`react-native-worklets/plugin`** babel plugin (must be **last** in the babel plugin list; do **not** also add the old `react-native-reanimated/plugin`).
   - Old Arch → **Reanimated 3** + `react-native-reanimated/plugin`.
2. **Expo Go vs dev build.** Expo Go pins exact native module versions; the moment you need a newer Reanimated/Skia API, move to an **EAS dev build**.
3. **Only then, bare vs Expo — install-only.** Expo: `npx expo install` (plugin auto-configured via `babel-preset-expo`). Bare: npm + `pod install` + manual plugin. Adjacent libs differ by name (`expo-blur` vs the **effectively unmaintained** `@react-native-community/blur` — prefer Skia for bare; `expo-linear-gradient` vs `react-native-linear-gradient`).

**Footguns:** missing `<GestureHandlerRootView>`; Reanimated breaks **Remote JS Debugging** (use Hermes debugging); `useAnimatedGestureHandler` removed in v4.

---

# §13. Flagship examples — built in both stacks

Recreate the signatures in **both** so the mapping is concrete. **Each opens with the decision (§1) before any code.**

- **Toast stack (Sonner-style)** — *Decision: occasional, purpose = spatial consistency + feedback.* Springs + velocity dismissal + restack. Web: transitions + `<AnimatePresence>`. Native: `withSpring` + `Gesture.Pan` + `withDecay` + `LinearTransition`. **Ports beautifully.**
- **Drag-to-dismiss sheet (Vaul-style)** — *Decision: occasional, purpose = spatial consistency.* Web: pointer events + manual velocity. Native: `Gesture.Pan` (`velocityY` free) + `withDecay` + boundary `rubberBand`. **Ports beautifully** — the native gesture story is arguably cleaner here.
- **Origin-aware popover** — **lossy on native** (no transform-origin on presets → translate math). Flag it.
- **Any blur-during-transition** — **lossy on native** (Skia or skip). Flag it.

## Sonner principles (building loved components — platform-agnostic)
1. **DX is king** — no hooks/context/setup. `<Toaster />` once, `toast()` anywhere.
2. **Good defaults > options** — ship beautiful out of the box.
3. **Naming creates identity** — "Sonner" over "react-toast."
4. **Handle edge cases invisibly** — pause timers on hidden tab/blur, fill stack gaps, capture pointers/gestures during drag.
5. **Transitions, not keyframes, for dynamic UI** (web) / shared values you can retarget (native).
6. **Cohesion** — match motion to the component's personality; a playful toast can be bouncier than a banking graph.

---

# §14. Optional unified-API bridges (present as bridges, not the foundation)

A true *write-once* animator is **not** realistic for high-craft motion: Reanimated-on-web runs on the **JS thread** (no off-thread win — peer to Motion on web, not superior), its layout/shared-element animations are **partial on web**, and Gesture Handler's **web support is the weakest link** — exactly the gesture/drag physics this skill leans on. The realistic ceiling is "one API, **two runtimes**." Pick by project shape **and Reanimated-4 readiness**:

| Bridge | Fits | ⚠️ Reanimated-4 / New-Arch reality |
| --- | --- | --- |
| **Moti** | universal/Solito monorepos, Framer-Motion-shaped API | **Depends on Reanimated 3; breaks on RN4 / New Arch (moti#391).** If you lead with Reanimated 4 (which SDK 55 forces) you **cannot** also default to Moti. |
| **Tamagui** | full design-system commitment; swappable drivers = Motion/WAAPI on web + Reanimated on native | Real "best of both," but heavy lock-in and its own New-Arch/RN4 upgrade lag — weigh maturity cost. |
| **NativeWind** | already on Tailwind; additive transition support | Verify current Reanimated pairing. |
| **Legend Motion** | tiny / bundle-sensitive | Verify status. |

> ⚠️ **Central contradiction to resolve before blessing any bridge:** "lead with Reanimated 4" and "default to Moti" are **mutually incompatible on current Expo**. Re-check each bridge's Reanimated-4 status at authoring time. **Sheet libraries hit the same wall** — `@gorhom/bottom-sheet` lagged Reanimated 4 (#2600); warn authors recreating the "Sonner sheet."

Keep teaching at the **principle level** so the skill survives library churn.

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
