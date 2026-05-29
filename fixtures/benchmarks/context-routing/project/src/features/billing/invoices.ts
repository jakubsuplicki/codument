export interface InvoiceLine {
  label: string;
  cents: number;
}

export interface Invoice {
  accountId: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export function createInvoice(
  accountId: string,
  lines: InvoiceLine[],
  taxRate: number,
): Invoice {
  const subtotalCents = lines.reduce((sum, line) => sum + line.cents, 0);
  const taxCents = Math.round(subtotalCents * taxRate);

  return {
    accountId,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
  };
}
