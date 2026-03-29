# Codument

An npm package that automates documentation for JS/TS projects using Claude Code.

## Build & Test

```bash
npm run build    # tsup — builds to dist/
npm test         # node:test runner
npm run typecheck # tsc --noEmit
```

## Project Structure

- `src/commands/` — CLI commands (init, scan, update)
- `src/lib/` — Core libraries (registry, scaffold, detect, codemod, markers, version)
- `src/hooks/` — PostToolUse hook script
- `skills/` — Claude Code skills shipped with the package
- `agents/` — Claude Code sub-agent definitions
- `rules/` — Path-scoped rule template
- `templates/` — Doc templates copied on init
- `tests/` — Node test runner tests

## Conventions

- ESM only (`"type": "module"`)
- TypeScript strict mode
- Lowercase kebab-case for all doc filenames
- Tests use temp directories for isolation

<!-- codument:start -->
## Documentation Maintenance

### Definition of Done
A task is NOT complete until:
1. Code works and tests pass
2. `docs/.registry.json` is checked for affected source files
3. Corresponding docs are updated or created
4. Registry is updated with new mappings
5. Dependent features flagged if interface changed
6. `last_updated` set on touched docs

### Documentation Registry
The file `docs/.registry.json` maps source files to their documentation.
Always check it before and after modifying source files.

### Documentation Structure
- Feature docs: `docs/features/{name}.md`
- Concept docs: `docs/concepts/{name}.md`
- ADRs: `docs/architecture/decisions/{NNN}-{title}.md`
- All filenames: lowercase kebab-case
<!-- codument:end -->
