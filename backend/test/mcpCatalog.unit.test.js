// Unit tests for the MCP tool catalog. No DB, no network.
//
// The coverage tests are the important ones. ForgeGrowth registers the same
// tools TWICE — once in backend/src/mcpHttp.js (Streamable HTTP, the remote
// connector) and once in mcp-server/src/index.js (stdio, local dev). Those two
// lists have always been kept in step BY HAND, which is precisely the kind of
// mirror that drifts silently. Now that gating is derived from the tool name,
// a tool missing from the catalog is not a cosmetic gap — it is REFUSED at
// runtime. So "the catalog and both transports describe the same set of tools"
// has to be an assertion, not a habit.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const catalog = require('../src/services/mcpCatalog');

const PKG = path.join(__dirname, '..');          // the backend package
const REPO = path.join(PKG, '..');               // the repo, when there is one

const { ROUTE_TOOL_NAMES } = require('../src/services/mcpRouteTools');

// Hand-registered tools (registerTool('name') in the source) PLUS the tools
// declared as data in services/mcpRouteTools.js, which a transport registers in
// a loop. A transport is credited with the shared list only if its source
// actually loads that file — so deleting the loop from one transport still
// fails the parity test below.
function registeredTools(absPath) {
  if (!fs.existsSync(absPath)) return null;
  const src = fs.readFileSync(absPath, 'utf8');
  const hand = [...src.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map(m => m[1]);
  const loadsShared = /mcpRouteTools(\.js)?['"]/.test(src) && /ROUTE_TOOLS/.test(src);
  return [...hand, ...(loadsShared ? ROUTE_TOOL_NAMES : [])].sort();
}

// Resolved relative to THIS package, never via a repo-root guess — the backend
// is copied on its own into the Docker image, where a repo-relative path
// silently resolves to nothing and every coverage assertion below would fail
// for a reason that has nothing to do with the catalog.
const HTTP_TOOLS = registeredTools(path.join(PKG, 'src', 'mcpHttp.js'));

// The stdio server lives OUTSIDE the backend package (../mcp-server), so it is
// absent whenever only backend/ is checked out — including inside the backend
// Docker image, which is where the suite is run to get a real `pg`. A missing
// file is not evidence of drift, so those tests SKIP with a stated reason
// rather than failing: a check that goes red for environmental reasons gets
// muted, and a muted drift check is the same as no drift check at all.
const STDIO_TOOLS = registeredTools(path.join(REPO, 'mcp-server', 'src', 'index.js'));
const NO_STDIO = 'mcp-server/ not present in this checkout — parity not checked here';

const CATALOG_TOOLS = [...catalog.TOOL_NAMES].sort();

describe('catalog covers both transports', () => {
  test('the HTTP transport registers a non-trivial number of tools', () => {
    // Guards the regex itself: if registerTool( is ever renamed, every coverage
    // test below would pass vacuously against an empty list.
    assert.ok(HTTP_TOOLS && HTTP_TOOLS.length > 30,
      `only found ${HTTP_TOOLS?.length} tools — has registerTool( been renamed?`);
  });

  test('every tool registered over HTTP has a catalog entry', () => {
    const missing = HTTP_TOOLS.filter(t => !catalog.toolCategory(t));
    assert.deepStrictEqual(missing, [],
      `these tools are registered but not in mcpCatalog.js, so they are REFUSED at runtime: ${missing.join(', ')}`);
  });

  test('the catalog lists no tool that does not exist', () => {
    const orphans = CATALOG_TOOLS.filter(t => !HTTP_TOOLS.includes(t));
    assert.deepStrictEqual(orphans, [],
      `catalog lists tools no transport registers — Settings would show a switch for nothing: ${orphans.join(', ')}`);
  });

  test('every tool registered over stdio has a catalog entry', (t) => {
    // Skip decided INSIDE the body: a describe() body runs at module load, so a
    // { skip } option computed there can read a flag before it is set.
    if (!STDIO_TOOLS) return t.skip(NO_STDIO);
    const missing = STDIO_TOOLS.filter(x => !catalog.toolCategory(x));
    assert.deepStrictEqual(missing, [],
      `registered on stdio but not in the catalog: ${missing.join(', ')}`);
  });

  test('both transports expose exactly the same tools', (t) => {
    if (!STDIO_TOOLS) return t.skip(NO_STDIO);
    assert.ok(STDIO_TOOLS.length > 30, `only found ${STDIO_TOOLS.length} stdio tools`);
    assert.deepStrictEqual(HTTP_TOOLS, STDIO_TOOLS,
      'the two transports have drifted — one connector can do something the other cannot');
  });
});

describe('category integrity', () => {
  test('every tool points at a category that exists', () => {
    const bad = catalog.TOOL_NAMES.filter(n => !catalog.CATEGORY_KEYS.includes(catalog.TOOLS[n].category));
    assert.deepStrictEqual(bad, []);
  });

  test('every category owns at least one tool', () => {
    // An empty category renders in Settings as a switch reading "0 tools",
    // which is a control that visibly does nothing.
    const empty = catalog.CATEGORY_KEYS.filter(k => catalog.toolsInCategory(k).length === 0);
    assert.deepStrictEqual(empty, []);
  });

  test('the category tool counts add up to the whole catalog', () => {
    const summed = catalog.CATEGORY_KEYS.reduce((n, k) => n + catalog.toolsInCategory(k).length, 0);
    assert.strictEqual(summed, catalog.TOOL_NAMES.length,
      'a tool is counted twice or not at all — "is this on?" becomes unanswerable from the UI');
  });

  test('every category declares a tier that exists', () => {
    for (const c of catalog.CATEGORIES) {
      assert.ok(catalog.TIERS[c.tier], `category ${c.key} has unknown tier ${c.tier}`);
    }
  });

  test('every tool carries a summary for the Settings screen', () => {
    const blank = catalog.TOOL_NAMES.filter(n => !catalog.TOOLS[n].summary?.trim());
    assert.deepStrictEqual(blank, []);
  });
});

describe('isToolAllowed is default-deny', () => {
  const allOn = Object.fromEntries(catalog.CATEGORY_KEYS.map(k => [k, true]));

  test('an unknown tool is refused even with every category on', () => {
    assert.strictEqual(catalog.isToolAllowed('definitely_not_a_tool', allOn), false);
  });

  test('a known tool is refused when its category is off', () => {
    assert.strictEqual(catalog.isToolAllowed('create_template', { ...allOn, templates: false }), false);
  });

  test('a known tool is allowed when its category is on', () => {
    assert.strictEqual(catalog.isToolAllowed('create_template', allOn), true);
  });

  test('a missing category key reads as off, never as on', () => {
    assert.strictEqual(catalog.isToolAllowed('create_template', {}), false);
    assert.strictEqual(catalog.isToolAllowed('create_template', undefined), false);
  });

  test('only a strict true enables — truthy values do not', () => {
    // A stored 'true' string or a 1 must not open a category. Anything that is
    // not the boolean true is off.
    for (const v of ['true', 1, 'yes', {}, []]) {
      assert.strictEqual(catalog.isToolAllowed('create_template', { templates: v }), false,
        `${JSON.stringify(v)} should not enable a category`);
    }
  });

  test('the refusal names the category, not the internal key', () => {
    const msg = catalog.toolDeniedMessage('create_template');
    assert.match(msg, /Template Builder/, 'the person reading this in Claude needs to know which switch to flip');
  });
});

describe('seedCategories never widens access', () => {
  test('no capabilities at all → every category off', () => {
    const seeded = catalog.seedCategories({});
    assert.deepStrictEqual(Object.values(seeded).filter(Boolean), []);
  });

  test('every legacy capability on → every category on', () => {
    const all = {};
    for (const c of catalog.CATEGORIES) for (const k of c.legacyCaps || []) all[k] = true;
    const seeded = catalog.seedCategories(all);
    const off = catalog.CATEGORY_KEYS.filter(k => !seeded[k]);
    assert.deepStrictEqual(off, [], `these would have gone dark on a fully-enabled instance: ${off.join(', ')}`);
  });

  test('a partially-enabled category stays OFF (needs ALL its legacy caps)', () => {
    // templates needs discovery AND area_broadcasts. Having only one before
    // means the client could not do the whole job, so seeding it on would
    // GRANT something that was previously impossible.
    const seeded = catalog.seedCategories({ discovery: true });
    assert.strictEqual(seeded.templates, false);
    assert.strictEqual(seeded.setup, true, 'setup needs only discovery, so it should carry over');
  });

  test('direct_api seeds on when ANY proxy area was open', () => {
    assert.strictEqual(catalog.seedCategories({ area_insights: true }).direct_api, true);
    assert.strictEqual(catalog.seedCategories({}).direct_api, false);
  });

  test('seeding is deterministic', () => {
    const caps = { discovery: true, area_broadcasts: true, read_messages: true };
    assert.deepStrictEqual(catalog.seedCategories(caps), catalog.seedCategories(caps));
  });

  // Pinned to the ACTUAL capabilities blob on the live instance at the time of
  // the rewrite. It is not all-on: `delete`, `area_admin`, `area_messaging` and
  // `area_resources` are off, and `area_scoring` is a stale key left over from
  // a feature that was removed.
  //
  // This is the regression that matters most on deploy day. An earlier version
  // of the catalog put delete_agent/delete_tool inside AI Agents, so `delete`
  // being off dragged all TEN agent tools dark — silently breaking list_agents,
  // create_agent and the rest, which work today. Splitting deletion into its
  // own category is what keeps the seed faithful.
  describe('the live instance keeps exactly what it can do today', () => {
    const LIVE = {
      delete: false, area_bda: true, discovery: true, area_admin: false,
      area_leads: true, area_courses: true, area_scoring: true, create_agent: true,
      manage_tools: true, update_agent: true, area_contacts: true, area_insights: true,
      area_payments: true, read_messages: true, send_messages: true,
      area_marketing: true, area_messaging: false, area_resources: false,
      area_broadcasts: true, area_automations: true,
    };
    const seeded = catalog.seedCategories(LIVE);

    test('agent building survives even though delete was switched off', () => {
      assert.strictEqual(seeded.agents, true);
      for (const t of ['list_agents', 'get_agent', 'create_agent', 'update_agent', 'add_tool', 'add_http_tool']) {
        assert.strictEqual(catalog.isToolAllowed(t, seeded), true, `${t} works today and must keep working`);
      }
    });

    test('deletion stays denied, exactly as the admin had it', () => {
      assert.strictEqual(seeded.delete, false);
      assert.strictEqual(catalog.isToolAllowed('delete_agent', seeded), false);
      assert.strictEqual(catalog.isToolAllowed('delete_tool', seeded), false);
    });

    // ⚠ A POSITIVE allowlist, deliberately — not "the denied set equals [...]".
    //
    // A frozen DENIED list has to be edited every time a category is added,
    // because a new category correctly seeds OFF; edit it often enough and it
    // stops meaning anything. And a list derived from the CURRENT catalog is
    // worse than useless: it judges "was this reachable before?" using the
    // definition that just changed, so adding a cap to an existing category
    // makes its tools vanish from the check instead of failing it. (Verified —
    // a derived version passed while silently dropping a whole category.)
    //
    // This snapshot is what the live connector could actually reach when the
    // Chat Analyzer shipped. New tools never disturb it; a tool losing access
    // always fails it. (The Forms + Projects tools were removed on purpose on
    // 2026-10-16, and the Marketing + Razorpay tools on 2026-10-21; they came
    // out of this list with them.)
    const REACHABLE_ON_DEPLOY_DAY = [
      'add_google_sheets_tool', 'add_http_tool', 'add_tool',
      'create_agent', 'create_automation', 'create_template',
      'forgechat_request', 'get_agent', 'get_automation_runs',
      'get_product_revenue', 'get_template', 'list_agents',
      'list_automations', 'list_conversations', 'list_endpoints',
      'list_leads', 'list_media', 'list_models',
      'list_products', 'list_sheet_tabs', 'list_templates',
      'list_wa_accounts', 'move_lead_stage',
      'read_messages', 'read_sheet_values', 'search_spreadsheets', 'send_bulk_message',
      'send_interactive', 'send_media', 'send_message', 'send_template',
      'submit_template', 'sync_template', 'update_agent', 'update_automation',
      'update_tool', 'upload_media', 'validate_automation',
    ];

    test('the deploy takes nothing away that worked before', () => {
      const lost = REACHABLE_ON_DEPLOY_DAY
        .filter(n => catalog.TOOL_NAMES.includes(n))   // a renamed tool is a separate concern
        .filter(n => !catalog.isToolAllowed(n, seeded));
      assert.deepStrictEqual(lost, [],
        'these tools work on the live instance today and this deploy would switch them off');
    });

    test('a NEW category seeds off, so nothing gains access on deploy', () => {
      // The other half of the same rule. Chat Analyzer bills the AI provider per
      // call, so it must arrive switched off and wait for an admin.
      assert.strictEqual(seeded.chat_analysis, false);
      for (const t of ['analyze_chat', 'list_analysed_chats', 'get_chat_analysis']) {
        assert.strictEqual(catalog.isToolAllowed(t, seeded), false,
          `${t} is new and must not be reachable until an admin enables it`);
      }
    });

    test('a stale capability key does not create a phantom category', () => {
      assert.ok(!('area_scoring' in seeded), 'area_scoring belongs to a removed feature');
    });
  });
});

describe('areas and kinds', () => {
  test('every category belongs to an area that exists', () => {
    const areas = new Set(catalog.AREAS.map(a => a.key));
    const bad = catalog.CATEGORIES.filter(c => !areas.has(c.area)).map(c => c.key);
    assert.deepStrictEqual(bad, [], `categories with no valid area: ${bad.join(', ')}`);
  });

  test('every tool has a kind the Settings screen can label', () => {
    const bad = catalog.TOOL_NAMES.filter(n => !catalog.KINDS[catalog.toolKind(n)]);
    assert.deepStrictEqual(bad, []);
  });

  test('a send or delete tool is never labelled as a harmless read', () => {
    for (const n of catalog.TOOL_NAMES) {
      if (/^(send_|social_send|social_reply|social_create_post|delete_|social_delete)/.test(n)) {
        assert.notStrictEqual(catalog.toolKind(n), 'read', `${n} must not be labelled "Reads"`);
      }
    }
  });

  test('every Social tool lives in the Social area, except deletes', () => {
    for (const n of catalog.TOOL_NAMES.filter(x => x.startsWith('social_'))) {
      const cat = catalog.CATEGORIES.find(c => c.key === catalog.toolCategory(n));
      if (n.startsWith('social_delete')) assert.strictEqual(cat.key, 'delete');
      else assert.strictEqual(cat.area, 'social', `${n} is in ${cat.area}`);
    }
  });

  test('the UI catalog groups every category under exactly one area', () => {
    const ui = catalog.catalogForUi({});
    const listed = ui.areas.flatMap(a => a.categories).sort();
    assert.deepStrictEqual(listed, [...catalog.CATEGORY_KEYS].sort());
    assert.ok(ui.apiAreas.length > 5 && ui.kinds.read);
  });

  test('new Social categories seed OFF on deploy', () => {
    const seeded = catalog.seedCategories({ discovery: true, area_marketing: true, area_admin: true });
    for (const k of ['social_insights', 'social_inbox', 'social_publish', 'social_automations', 'social_agents']) {
      assert.strictEqual(seeded[k], false, `${k} must arrive switched off`);
    }
  });
});

describe('normalizeCategories', () => {
  test('drops keys that are not real categories', () => {
    const out = catalog.normalizeCategories({ templates: true, area_admin: true, bogus: true });
    assert.strictEqual(out.templates, true);
    assert.ok(!('area_admin' in out), 'a stale capability key must not survive as a category');
    assert.ok(!('bogus' in out));
  });

  test('fills every known category, defaulting to false', () => {
    const out = catalog.normalizeCategories({});
    assert.deepStrictEqual(Object.keys(out).sort(), [...catalog.CATEGORY_KEYS].sort());
    assert.deepStrictEqual(Object.values(out).filter(Boolean), []);
  });

  test('coerces to strict booleans', () => {
    const out = catalog.normalizeCategories({ templates: 'true', media: 1, agents: null });
    assert.strictEqual(out.templates, false);
    assert.strictEqual(out.media, false);
    assert.strictEqual(out.agents, false);
  });
});

describe('catalogForUi', () => {
  const ui = catalog.catalogForUi({ templates: true });

  test('reports the real total so Settings cannot show a stale count', () => {
    assert.strictEqual(ui.totalTools, catalog.TOOL_NAMES.length);
    assert.strictEqual(ui.categories.length, catalog.CATEGORIES.length);
  });

  test('each category carries its own tool count and tool list', () => {
    for (const c of ui.categories) {
      assert.strictEqual(c.toolCount, c.tools.length, `${c.key} count disagrees with its own list`);
      assert.ok(c.tools.every(t => t.name && t.summary));
    }
  });

  test('enabled state reflects what was passed in', () => {
    assert.strictEqual(ui.categories.find(c => c.key === 'templates').enabled, true);
    assert.strictEqual(ui.categories.find(c => c.key === 'agents').enabled, false);
  });

  test('the Template Builder category holds the whole template workflow', () => {
    // The category exists so a strategist can hand Claude the entire
    // draft -> submit -> approved loop with one switch. If any of these ever
    // moved elsewhere, that promise would quietly break.
    const names = ui.categories.find(c => c.key === 'templates').tools.map(t => t.name);
    for (const t of ['list_templates', 'get_template', 'create_template', 'submit_template', 'sync_template']) {
      assert.ok(names.includes(t), `${t} should live in Template Builder`);
    }
  });
});
