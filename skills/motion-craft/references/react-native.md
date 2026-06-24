# React Native Implementation Layer (Reanimated + Gesture Handler)

Read this when targeting React Native (Expo or bare). The platform-neutral judgment (when/whether to animate, easing/duration/spring feel, choreography, perceived performance, accessibility intent) lives in `SKILL.md` — this file is only the native-specific mechanics and the native setup/build sidebar.

Contents:
- Core primitives, timing/spring/decay, performance, enter/exit & layout
- Gestures & drag, crossing threads, legacy, reduced motion
- Native setup sidebar (architecture, Expo Go vs dev build, bare vs Expo, footguns)

> Identical for Expo and bare RN. Setup differs — see the native setup sidebar below.

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
- `withTiming(to, { duration, easing })` — `Easing.bezier(x1,y1,x2,y2)` takes the **same four control points** as your CSS `cubic-bezier` (copy the numbers; see the translation table caveat in `SKILL.md`).
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
> ⚠️ **`LinearTransition` is simpler to *invoke*, not simpler to *get right*.** It is finicky inside virtualized lists, with nested layouts, and on first mount under the New Architecture. Expect to debug it in real lists.

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

### Reduced motion (native)
See the "reduced motion cross-platform — the reactivity trap" section in `SKILL.md` for the native snapshot-vs-reactive gotcha and the callback hazard.

---

## Native setup sidebar (NOT a principles axis)

Branch your *setup* in this order — none of it changes the animation code:

1. **Architecture first.** New Architecture is the SDK 53+ default, **forced from SDK 55+** (RN 0.76+):
   - New Arch → **Reanimated 4** + `react-native-worklets` + the **`react-native-worklets/plugin`** babel plugin (must be **last** in the babel plugin list; do **not** also add the old `react-native-reanimated/plugin`).
   - Old Arch → **Reanimated 3** + `react-native-reanimated/plugin`.
2. **Expo Go vs dev build.** Expo Go pins exact native module versions; the moment you need a newer Reanimated/Skia API, move to an **EAS dev build**.
3. **Only then, bare vs Expo — install-only.** Expo: `npx expo install` (plugin auto-configured via `babel-preset-expo`). Bare: npm + `pod install` + manual plugin. Adjacent libs differ by name (`expo-blur` vs the **effectively unmaintained** `@react-native-community/blur` — prefer Skia for bare; `expo-linear-gradient` vs `react-native-linear-gradient`).

**Footguns:** missing `<GestureHandlerRootView>`; Reanimated breaks **Remote JS Debugging** (use Hermes debugging); `useAnimatedGestureHandler` removed in v4.
