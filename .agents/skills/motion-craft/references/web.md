# Web Implementation Layer (CSS / WAAPI / Motion)

Read this when targeting the web. The platform-neutral judgment (when/whether to animate, easing/duration/spring feel, choreography, perceived performance, accessibility intent) lives in `SKILL.md` — this file is only the web-specific mechanics.

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
> **Web exit isn't free either.** Watch for: the `layout` prop conflicting with your own `transform`; `mode="popLayout"`/`"wait"` semantics; and the hard requirement that each child has a stable `key`. Treat the web presence model with the same suspicion as the native one.

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
`clip-path: inset(top right bottom left)` for reveals, hold-to-delete overlays, tabs with perfect color transitions, comparison sliders, scroll reveals. **There is no clean, performant native equivalent.**

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
