// Guards the ONE property this fix is about: the Products page and the sales
// list must read the same definitions. They disagreed (9 sold vs 14 sales)
// because each surface carried its own copy of "which payments belong to this
// product" — so these tests assert the copies are gone, not just that today's
// numbers happen to line up.
//
// Deliberately TEXT-level (the technique mcpCatalog.unit.test.js uses): a test
// that require()s services/mcpService pulls in the BullMQ send queue, whose
// Redis connection keeps the event loop alive and hangs `npm test` repo-wide.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

const productSales = src('services/productSales.js');
const leads = src('routes/leads.js');
const courses = src('routes/courses.js');
const mcpService = src('services/mcpService.js');

test('productSales holds no private copy of the won-stage rule', () => {
  // The stage set comes from routes/leads.js, which is what makes the Products
  // page count exactly what GET /students lists.
  assert.match(productSales, /require\('\.\.\/routes\/leads'\)/);
  assert.match(productSales, /SALE_STAGE_KEYS/);

  // A hardcoded stage key here would re-open the drift the moment someone adds
  // a second won stage in Funnel Settings.
  const code = productSales.replace(/\/\/.*$/gm, '');
  assert.ok(!/'enrolled'/.test(code), 'productSales must not hardcode a stage key');

  // Payments come from the manual sales store only.
  assert.ok(!/razorpay/i.test(code), 'productSales must not read a payment gateway table');
});

test('leads.js exports the won-stage predicate and both sales queries use it', () => {
  assert.match(leads, /module\.exports\s*=\s*\{[^}]*SALE_STAGE_KEYS/s);
  assert.match(leads, /const SALE_STAGE_KEYS = \(\) => \{[^}]*wonStageKeys\(\)/s);
  // Falls back to the seeded key so a misconfigured funnel can't empty the
  // Sales Log (and, now, can't zero every product's sales count with it).
  assert.match(leads, /wonStageKeys\(\);\s*return won\.length \? won : \['enrolled'\]/);

  // Every won-stage lead list binds the array instead of the literal:
  // /students and /students/export.
  const anyMatches = leads.match(/WHERE l\.stage = ANY\(\$\$\{params\.length\}\)/g) || [];
  assert.ok(anyMatches.length >= 2, `expected >= 2 shared-predicate queries, found ${anyMatches.length}`);
  // No won-stage LIST may still filter on the literal. Aggregate breakdowns
  // (`COUNT(*) FILTER (WHERE l.stage = 'enrolled')`) are a different report
  // and are deliberately left alone.
  const hardcoded = leads.split('\n')
    .filter(line => /WHERE l\.stage\s*=\s*'enrolled'/.test(line) && !/FILTER\s*\(/.test(line));
  assert.deepStrictEqual(hardcoded, [], "no won-stage lead list may hardcode stage='enrolled'");
});

test('the amount-matching product aggregation is gone from every surface', () => {
  // This join is what produced the 9: it counts only gateway payments matched
  // to a payment_link by exact price, missing manual sales, part payments and
  // anything that predates the link.
  const oldJoin = /LEFT JOIN coexistence\.razorpay_events e ON e\.course_id = c\.id/;
  assert.ok(!oldJoin.test(courses), 'routes/courses.js must read product totals from the sales store');
  assert.ok(!oldJoin.test(mcpService), 'mcpService must read product totals from the sales store');

  // All three call sites go through the one service.
  assert.match(courses, /require\('\.\.\/services\/productSales'\)/);
  assert.strictEqual((mcpService.match(/require\('\.\/productSales'\)/g) || []).length, 2,
    'both listCourses and getCourseRevenue must use the shared totals');
});
