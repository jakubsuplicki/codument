// Trusted scorer; this file is never copied to a worker fixture.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [root, task] = process.argv.slice(2);
const checks = [];
async function check(id, run) {
  try { await run(); checks.push({id, passed:true}); }
  catch { checks.push({id, passed:false}); }
}
const load = name => import(pathToFileURL(join(root, 'src', name + '.js')).href);
if (task === 'retrieval') {
  await check('dependent-contract', async () => {
    const {totalCents: total} = await load('pricing');
    assert.equal(total([{unitCents:105,quantity:1},{unitCents:105,quantity:1}],10),190);
    assert.equal(total([{unitCents:-105,quantity:1}],10),-95);
    assert.equal(total([{unitCents:201,quantity:3}],50),302);
    assert.equal(total([{unitCents:-201,quantity:3}],50),-302);
    assert.equal(total([{unitCents:123,quantity:2}]),246);
    assert.equal(total([{unitCents:123,quantity:2}],100),0);
    assert.equal(total([],10),0);
  });
}
if (task === 'approval-change') {
  await check('approved-boundary', async () => {
    const {shippingCents: shipping} = await load('shipping');
    assert.equal(shipping(4999),800); assert.equal(shipping(5000),0);
    assert.equal(shipping(7499),0); assert.equal(shipping(9999),0);
  });
}
if (task === 'interrupted-work') {
  await check('resumed-contract', async () => {
    const {retryDelay: delay} = await load('retry');
    for (const [attempt,expected] of [[0,1000],[1,2000],[4,16000],[5,30000],[15,30000],[1024,30000]]) {
      assert.equal(delay(attempt),expected);
    }
  });
}
await check('valid-control', async () => {
  const {invoiceLabel: label} = await load('labels');
  assert.equal(label('  inv-ab  '),'INV-AB'); assert.equal(label(42),'42'); assert.equal(label(''),'');
});
process.stdout.write(JSON.stringify(checks));
