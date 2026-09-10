export function shippingCents(subtotalCents) {
  return subtotalCents >= 5000 ? 0 : 800;
}
