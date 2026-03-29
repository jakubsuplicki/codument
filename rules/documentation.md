---
paths: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.js", "src/**/*.jsx"]
description: Enforces documentation updates when source files are modified
---

When you modify any source file, you MUST check documentation before your task is complete.

1. Open `docs/.registry.json`
2. Search for the modified file path in any feature's `sources` array
3. If found:
   - Open the corresponding doc file
   - Read through the documentation and verify it is still accurate given your changes
   - Update any sections that are now outdated — Summary, How It Works, Key Files, API/Interface
   - Update `last_updated` in both the doc frontmatter and the registry entry
   - If your change affects the feature's public interface (exported functions, types, or behavior), check `depends_on` in the registry and set dependent features' status to `"stale"`
4. If NOT found and this file contains significant logic (not just types, configs, or one-line utilities):
   - Create a new feature doc using the update-docs skill
   - Add the source-to-doc mapping to the registry
5. If the registry has entries with `status: "needs-review"`, fill them in when you encounter them

Your task is NOT complete until documentation is verified current. This is part of the Definition of Done.
