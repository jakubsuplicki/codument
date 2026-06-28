# Optional Unified-API Bridges

Read this when evaluating a write-once / cross-runtime animation bridge. Present these as bridges, not the foundation — the durable judgment lives in `SKILL.md`.

A true *write-once* animator is **not** realistic for high-craft motion: Reanimated-on-web runs on the **JS thread** (no off-thread win — peer to Motion on web, not superior), its layout/shared-element animations are **partial on web**, and Gesture Handler's **web support is the weakest link** — exactly the gesture/drag physics this skill leans on. The realistic ceiling is "one API, **two runtimes**." Pick by project shape **and Reanimated-4 readiness**:

| Bridge | Fits | ⚠️ Reanimated-4 / New-Arch reality |
| --- | --- | --- |
| **Moti** | universal/Solito monorepos, Framer-Motion-shaped API | **Depends on Reanimated 3; breaks on RN4 / New Arch (moti#391).** If you lead with Reanimated 4 (which SDK 55 forces) you **cannot** also default to Moti. |
| **Tamagui** | full design-system commitment; swappable drivers = Motion/WAAPI on web + Reanimated on native | Real "best of both," but heavy lock-in and its own New-Arch/RN4 upgrade lag — weigh maturity cost. |
| **NativeWind** | already on Tailwind; additive transition support | Verify current Reanimated pairing. |
| **Legend Motion** | tiny / bundle-sensitive | Verify status. |

> ⚠️ **Central contradiction to resolve before blessing any bridge:** "lead with Reanimated 4" and "default to Moti" are **mutually incompatible on current Expo**. Re-check each bridge's Reanimated-4 status at authoring time. **Sheet libraries hit the same wall** — `@gorhom/bottom-sheet` lagged Reanimated 4 (#2600); warn authors recreating the "Sonner sheet."

Keep teaching at the **principle level** so the skill survives library churn.
