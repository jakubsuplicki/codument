// A tiny in-memory account. Amounts must be positive; withdrawals may not
// overdraw the balance. Both guards are load-bearing: dropping the positive
// check turns a withdrawal of a negative amount into a deposit.

export function createAccount(balance = 0) {
  return { balance };
}

export function deposit(account, amount) {
  assertPositive(amount);
  return { ...account, balance: account.balance + amount };
}

export function withdraw(account, amount) {
  assertPositive(amount);
  if (amount > account.balance) {
    throw new Error("insufficient funds");
  }
  return { ...account, balance: account.balance - amount };
}

function assertPositive(amount) {
  if (!(typeof amount === "number" && amount > 0)) {
    throw new Error(`amount must be a positive number, received: ${amount}`);
  }
}
