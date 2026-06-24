# Flagship Examples — Built in Both Stacks

Read this for the worked examples. The decision framework (§1) and the per-platform mechanics carry the detail back in `SKILL.md` — this file is the concrete signatures and the Sonner principles.

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
