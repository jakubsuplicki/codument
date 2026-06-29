import { paginate } from "../util/pagination.js";
import { parseAmount } from "../util/parse-amount.js";

// A paginated transactions report: normalize each raw amount, then page the result.
export function transactionsPage(rawTransactions, page, size) {
  const parsed = rawTransactions.map((tx) => ({
    ...tx,
    amount: parseAmount(tx.amount),
  }));
  return paginate(parsed, page, size);
}
