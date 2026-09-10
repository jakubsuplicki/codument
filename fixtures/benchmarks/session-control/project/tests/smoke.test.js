import assert from 'node:assert/strict';
import { test } from 'node:test';
import { totalCents } from '../src/pricing.js';
import { shippingCents } from '../src/shipping.js';
import { retryDelay } from '../src/retry.js';
test('existing entry points remain usable', () => {
  assert.equal(totalCents([]), 0);
  assert.equal(totalCents([{unitCents:200, quantity:2}]), 400);
  assert.equal(shippingCents(0), 800);
  assert.equal(retryDelay(0), 1000);
});
