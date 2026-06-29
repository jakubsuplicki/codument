# Codument Review Catch-Rate Task

You are in a fixture project created by `codument benchmark init --seeded`.

A teammate has finished a feature branch — "add a paginated transactions
report" — and left it as **uncommitted working-tree changes** over a clean,
committed baseline. The diff adds two utilities (`src/util/pagination.js`,
`src/util/parse-amount.js`) and a consumer (`src/report/transactions.js`), and
tidies `src/auth/authorize.js` and `src/wallet/account.js` along the way.

The branch carries a number of planted bugs. They are **not listed anywhere in
this directory** — finding them is the point.

Your job depends on which run you are doing:

- **no-loop run:** commit the work as-is. (This is the baseline: what ships when
  there is no review gate.)
- **loop run:** run the Codument review step (`codument review`, then the
  `review-work` skill in `AGENTS.md`) on the uncommitted diff, fix every issue
  it surfaces, and update the durable docs and `docs/.registry.json` for what
  you touch. Then commit.

Either way, when you finish, the scorer runs hidden detector tests against the
final state:

```
codument benchmark score <this-dir> --mode loop      # or --mode no-loop
```

Workflow notes:

- Use the Codument instructions in `AGENTS.md`.
- Do not modify `benchmark.lock.json` or `.codument/benchmark.json`.
- Run `npm test` before you stop.

Stop with a concise review summary and the verification you ran.
