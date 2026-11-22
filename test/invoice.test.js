const assert = require('node:assert/strict');
const test = require('node:test');
const invoice = require('../lib/invoice');
const ledger = require('../lib/ledger');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');

function billOrder(items, coupon = '') {
  const customer = { id: 1, name: 'Test Customer' };
  const db = { orders: [], nextOrderId: 1001, customers: [customer] };
  const billed = pricing.computeTotals(items, coupon);

  assert.equal(ledger.chargeOrderToKhata(db, customer.id, billed.total).ok, true);
  const order = orders.add(db, {
    ...billed,
    date: '01/11/2021',
    customer: customer.name,
    customerId: customer.id,
    paymentMode: 'khata',
    items,
    coupon
  });

  assert.equal(customer.totalBilled, order.total);
  return { order, billed, figures: invoice.computeInvoiceFigures(order) };
}

function amounts({ subtotal, discount, tax, cgst, sgst, total }) {
  return [subtotal, discount, tax, cgst, sgst, total];
}

test('invoice shows the billed total and GST breakdown for a mixed-rate order', () => {
  const { order, figures } = billOrder([
    { name: 'Rice', hsn: '1006', price: 640, qty: 1 },
    { name: 'Ghee', hsn: '0405', price: 260, qty: 1 }
  ]);

  assert.equal(order.total, 963.20);
  assert.equal(order.tax, 63.20);
  assert.equal(figures.total, order.total, 'invoice total must match the amount billed');
  assert.equal(figures.tax, order.tax);
  assert.deepEqual([figures.cgst, figures.sgst], [31.60, 31.60]);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[5, 32], [12, 31.20]]);

  const html = invoice.render(order);
  assert.ok(html.includes('CGST + SGST (Total GST)</td><td class="r">₹63.20'));
  assert.ok(html.includes('Invoice Total</td><td class="r">₹963.20'));
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice matches the billed total with default GST and no coupon', () => {
  const { order, billed, figures } = billOrder([
    { name: 'Unclassified item', price: 50, qty: 2 }
  ]);

  assert.deepEqual(amounts(billed), [100, 0, 18, 9, 9, 118]);
  assert.deepEqual(amounts(figures), [100, 0, 18, 9, 9, 118]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice prefers current line rates when both pricing methods match the recorded totals', () => {
  const { figures } = billOrder([
    { name: 'Rice', hsn: '1006', price: 0.03, qty: 1 },
    { name: 'Unclassified item', price: 0.03, qty: 1 }
  ]);

  assert.deepEqual(amounts(figures), [0.06, 0, 0.01, 0.01, 0, 0.07]);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[5, 0], [18, 0.01]]);
});

test('invoice preserves the recorded flat GST on an order billed before the HSN migration', () => {
  const order = {
    id: 1001,
    items: [{ name: 'Rice', hsn: '1006', price: 640, qty: 1 }],
    subtotal: 640,
    discount: 0,
    tax: 115.20,
    total: 755.20
  };

  const figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual(amounts(figures), [640, 0, 115.20, 57.60, 57.60, 755.20]);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[18, 115.20]]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice uses the recorded discount and reconciles line rounding on a pre-migration order', () => {
  const order = {
    items: [
      { name: 'Rice', hsn: '1006', price: 1000.03, qty: 1 },
      { name: 'Ghee', hsn: '0405', price: 1000.03, qty: 1 }
    ],
    coupon: 'SAVE10',
    subtotal: 2000.06,
    discount: 200.01,
    tax: 324.01,
    total: 2124.06
  };

  const figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual(amounts(figures), [2000.06, 200.01, 324.01, 162.01, 162, 2124.06]);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[18, 162], [18, 162.01]]);
});

test('invoice reproduces GST billed with a pre-migration unrounded percentage discount', () => {
  const order = {
    items: [{ name: 'Rice', hsn: '1006', price: 500.03, qty: 1 }],
    coupon: 'SAVE10',
    subtotal: 500.03,
    discount: 50,
    tax: 81,
    total: 531.03
  };

  const figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual(amounts(figures), [500.03, 50, 81, 40.5, 40.5, 531.03]);
  assert.equal(figures.rows[0].lineTax, 81);
});

test('invoice shows a signed reconciliation notice when the recorded total differs', () => {
  const { order } = billOrder([
    { name: 'Unclassified item', price: 100, qty: 1 }
  ]);

  for (const [total, difference] of [[117.99, '+₹0.01'], [118.01, '-₹0.01']]) {
    const html = invoice.render({ ...order, total });
    assert.match(html, /Accountant Reconciliation Notice/);
    assert.ok(html.includes(`differs from Order Ledger recorded total (₹${total}) by ${difference}.`));
  }
});

test('invoice uses HSN rates for stored lines without explicit rates', () => {
  const { billed, figures } = billOrder([
    { name: 'Rice', hsn: '1006', price: 100, qty: 1 },
    { name: 'Ghee', hsn: '0405', price: 50, qty: 2 }
  ]);

  assert.deepEqual(billed.lines.map(({ gstPercent, tax }) => [gstPercent, tax]), [[5, 5], [12, 12]]);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[5, 5], [12, 12]]);
  assert.deepEqual(amounts(billed), [200, 0, 17, 8.5, 8.5, 217]);
  assert.deepEqual(amounts(figures), amounts(billed));
});

test('invoice applies the percent coupon cap and calculates GST after the discount', () => {
  const { order, billed, figures } = billOrder([
    { name: 'Tea', hsn: '0902', price: 2000, qty: 1 }
  ], 'SAVE10');

  assert.deepEqual(amounts(billed), [2000, 150, 333, 166.5, 166.5, 2183]);
  assert.deepEqual(amounts(figures), amounts(billed));
  assert.equal(figures.rows[0].lineTax, 333);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice calculates GST after a flat coupon discount', () => {
  const { billed, figures } = billOrder([
    { name: 'Tea', hsn: '0902', price: 300, qty: 1 }
  ], 'FLAT50');

  assert.deepEqual(amounts(billed), [300, 50, 45, 22.5, 22.5, 295]);
  assert.deepEqual(amounts(figures), amounts(billed));
  assert.equal(figures.rows[0].lineTax, 45);
});

test('invoice GST matches the sum of the billed line taxes rounded to paise', () => {
  const { order, billed, figures } = billOrder([
    { name: 'First item', price: 0.03, qty: 1 },
    { name: 'Second item', price: 0.03, qty: 1 }
  ]);

  assert.deepEqual(figures.rows.map(({ lineTax }) => lineTax), [0.01, 0.01]);
  assert.deepEqual(amounts(billed), [0.06, 0, 0.02, 0.01, 0.01, 0.08]);
  assert.deepEqual(amounts(figures), amounts(billed));
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice accepts explicit percentage, decimal and zero GST rates as billing does', () => {
  const { billed, figures } = billOrder([
    { name: 'Percentage rate', price: 100, qty: 1, gstRate: 5 },
    { name: 'Decimal rate', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 }
  ]);

  assert.deepEqual(billed.lines.map(({ gstPercent, tax }) => [gstPercent, tax]), [[5, 5], [5, 5], [0, 0]]);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[5, 5], [5, 5], [0, 0]]);
  assert.deepEqual(amounts(billed), [300, 0, 10, 5, 5, 310]);
  assert.deepEqual(amounts(figures), amounts(billed));
});
