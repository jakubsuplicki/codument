// A tiny in-memory account.

export function createAccount(balance = 0) {
  return { balance };
}

export function deposit(account, amount) {
  return { ...account, balance: account.balance + amount };
}

export function withdraw(account, amount) {
  if (amount > account.balance) {
    throw new Error("insufficient funds");
  }
  return { ...account, balance: account.balance - amount };
}
