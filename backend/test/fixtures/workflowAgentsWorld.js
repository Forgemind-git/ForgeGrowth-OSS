// Seeded world shared by the workflow-agent integration tests: two business numbers,
// two reps (number A moved from Rep A to Rep B 48 hours ago), six leads covering the
// scope rules, a voice note with a transcript, a button tap, a phone-app echo, a
// broadcast template, a double-written Razorpay payment and an attributed ad.
//
// ⚠ `node --test` runs test FILES in parallel against one database, so every test
// file seeds its own world with a distinct one-digit tag. Two files sharing marker
// rows delete each other's data mid-run, and that surfaces as a flaky assertion
// rather than as a collision.

function makeWorld(tag) {
  const T = String(tag);
  if (!/^\d$/.test(T)) throw new Error('world tag must be one digit');
  const NUM_A = `9190000${T}0101`;
  const NUM_B = `9190000${T}0102`;
  const L = {
    hot: `9191000${T}0001`, optedOut: `9191000${T}0002`, dnc: `9191000${T}0003`,
    enrolled: `9191000${T}0004`, onB: `9191000${T}0005`, old: `9191000${T}0006`,
  };
  const P = `wftest${T}`;
  const names = {
    msgPrefix: `${P}.`, template: `${P}_template`, course: `WF Test Course ${T}`, ad: `${P}-ad-1`, waba: `${P}-waba`,
    agentSlug: `${P}-agent`, userPrefix: `${P}_`, payment: `${P}_pay_1`, student: `${P} enrolled`,
  };
  const mid = (s) => `${names.msgPrefix}${s}`;
  const ids = {};
  const now = new Date();
  const ago = (hours) => new Date(now.getTime() - hours * 36e5);

  async function msg(pool, f0) {
    const f = { direction: 'incoming', message_type: 'text', status: 'received', raw_payload: null, send_origin: null, template_id: null, ...f0 };
    await pool.query(
      `INSERT INTO coexistence.chat_history (message_id, wa_number, contact_number, direction, message_type, message_body, status, timestamp, raw_payload, send_origin, template_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [f.id, f.wa, f.to, f.direction, f.message_type, f.body ?? null, f.status, f.at, f.raw_payload ? JSON.stringify(f.raw_payload) : null, f.send_origin, f.template_id]);
  }

  async function cleanup(pool) {
    await pool.query(`DELETE FROM coexistence.workflow_agent_audit WHERE agent_id IN (SELECT id FROM coexistence.workflow_agents WHERE slug LIKE $1)`, [`${P}-%`]);
    await pool.query(`DELETE FROM coexistence.workflow_agents WHERE slug LIKE $1`, [`${P}-%`]);
    await pool.query(`DELETE FROM coexistence.chat_message_artifacts WHERE message_key LIKE $1`, [`${names.msgPrefix}%`]);
    await pool.query(`DELETE FROM coexistence.chat_history WHERE message_id LIKE $1 OR contact_number LIKE $2`, [`${names.msgPrefix}%`, `9191000${T}%`]);
    await pool.query(`DELETE FROM coexistence.rep_teams WHERE name LIKE $1`, [`${P}-%`]);
    await pool.query(`DELETE FROM coexistence.ctwa_referrals WHERE source_id = $1`, [names.ad]);
    await pool.query(`DELETE FROM coexistence.ad_daily_stats WHERE ad_external_id = $1`, [names.ad]);
    await pool.query(`DELETE FROM coexistence.campaign_ads WHERE ad_external_id = $1`, [names.ad]);
    await pool.query(`DELETE FROM coexistence.razorpay_events WHERE payment_id = $1`, [names.payment]);
    await pool.query(`DELETE FROM coexistence.sales_log WHERE student_name = $1`, [names.student]);
    await pool.query(`DELETE FROM coexistence.lead_notes WHERE lead_id IN (SELECT id FROM coexistence.leads WHERE whatsapp_number LIKE $1)`, [`9191000${T}%`]);
    await pool.query(`DELETE FROM coexistence.contacts WHERE contact_number LIKE $1`, [`9191000${T}%`]);
    await pool.query(`DELETE FROM coexistence.leads WHERE whatsapp_number LIKE $1`, [`9191000${T}%`]);
    await pool.query(`DELETE FROM coexistence.courses WHERE name = $1`, [names.course]);
    await pool.query(`DELETE FROM coexistence.message_templates WHERE name = $1`, [names.template]);
    await pool.query(`DELETE FROM coexistence.whatsapp_accounts WHERE waba_id = $1`, [names.waba]);
    await pool.query(`DELETE FROM coexistence.forgecrm_users WHERE username LIKE $1`, [`${names.userPrefix}%`]);
    await pool.query(`DELETE FROM coexistence.tags WHERE id LIKE $1`, [`tag-${P}-%`]);
  }

  async function seed(pool) {
    await cleanup(pool);
    for (const [key, label, order, won, funnel] of [['new', 'New', 1, false, true], ['engaged', 'Engaged', 3, false, true], ['hot', 'Hot', 4, false, true], ['enrolled', 'Enrolled', 5, true, true]]) {
      await pool.query(`INSERT INTO coexistence.funnel_stages (stage_key, label, order_index, is_won, is_funnel) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (stage_key) DO NOTHING`, [key, label, order, won, funnel]);
    }
    const acc = await pool.query(
      `INSERT INTO coexistence.whatsapp_accounts (display_name, display_phone_number, phone_number_id, waba_id, access_token_encrypted)
       VALUES ('WF Test A', $1, $3, $5, 'x'), ('WF Test B', $2, $4, $5, 'x') RETURNING id, display_phone_number`,
      [NUM_A, NUM_B, `${P}-pn-a`, `${P}-pn-b`, names.waba]);
    ids.accA = acc.rows.find(r => r.display_phone_number === NUM_A).id;
    ids.accB = acc.rows.find(r => r.display_phone_number === NUM_B).id;
    const users = await pool.query(
      `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role, is_active)
       VALUES ($1, $2, 'x', 'Rep A', 'sales', TRUE), ($3, $4, 'x', 'Rep B', 'sales', TRUE) RETURNING id, username`,
      [`${names.userPrefix}rep_a`, `${names.userPrefix}rep_a@example.test`, `${names.userPrefix}rep_b`, `${names.userPrefix}rep_b@example.test`]);
    ids.repA = users.rows.find(r => r.username.endsWith('rep_a')).id;
    ids.repB = users.rows.find(r => r.username.endsWith('rep_b')).id;
    // Number A belonged to Rep A until 2 days ago, then moved to Rep B.
    await pool.query(
      `INSERT INTO coexistence.rep_number_assignments (whatsapp_account_id, user_id, valid_from, valid_to) VALUES ($1,$2,$3,$4), ($1,$5,$4,NULL)`,
      [ids.accA, ids.repA, ago(24 * 30), ago(48), ids.repB]);
    const course = await pool.query(`INSERT INTO coexistence.courses (name, default_price_paise, active) VALUES ($1, 500000, TRUE) RETURNING id`, [names.course]);
    ids.course = course.rows[0].id;

    const leadRow = async (num, extra = {}) => {
      const { rows } = await pool.query(
        `INSERT INTO coexistence.leads (whatsapp_number, name, stage, source, opted_out, paid_course, created_at, stage_changed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
        [num, extra.name || 'Test Lead', extra.stage || 'new', extra.source || 'Direct', !!extra.opted_out, extra.paid_course || null, extra.created_at || ago(24 * 5)]);
      return rows[0].id;
    };
    ids.hot = await leadRow(L.hot, { name: 'Priya Sharma', stage: 'hot', source: 'Instagram Ad' });
    ids.optedOut = await leadRow(L.optedOut, { stage: 'new', opted_out: true });
    ids.dnc = await leadRow(L.dnc, { stage: 'engaged' });
    ids.enrolled = await leadRow(L.enrolled, { name: 'Enrolled Person', stage: 'enrolled', paid_course: names.course });
    ids.onB = await leadRow(L.onB, { stage: 'hot' });
    ids.old = await leadRow(L.old, { stage: 'engaged', created_at: ago(24 * 60) });

    for (const [wa, num, tags] of [[NUM_A, L.hot, []], [NUM_A, L.optedOut, []], [NUM_A, L.dnc, [{ id: 'tag-x', name: 'Do not contact', category_id: 'cat-x' }]], [NUM_A, L.enrolled, []], [NUM_B, L.onB, []], [NUM_A, L.old, []]]) {
      await pool.query(`INSERT INTO coexistence.contacts (wa_number, contact_number, tags) VALUES ($1,$2,$3)`, [wa, num, JSON.stringify(tags)]);
    }
    await pool.query(
      `INSERT INTO coexistence.lead_events (lead_id, event_type, from_value, to_value, actor, ts) VALUES
         ($1,'stage_changed',NULL,'new','test',$2), ($1,'stage_changed','new','engaged','test',$3), ($1,'stage_changed','engaged','hot','test',$4)`,
      [ids.hot, ago(24 * 5), ago(24 * 3), ago(24)]);
    const tpl = await pool.query(
      `INSERT INTO coexistence.message_templates (name, category, language, header_type, body, status, whatsapp_account_id, template_type)
       VALUES ($1, 'MARKETING', 'en', 'IMAGE', 'Hi {{1}}', 'APPROVED', $2, 'STANDARD') RETURNING id`, [names.template, ids.accA]);
    ids.tpl = tpl.rows[0].id;

    // Priya's thread on number A, oldest → newest.
    await msg(pool, { id: mid('h1'), wa: NUM_A, to: L.hot, body: 'Hi, interested in the course', at: ago(24 * 5) });
    await msg(pool, { id: mid('h2'), wa: NUM_A, to: L.hot, direction: 'outgoing', body: 'Thanks! Which batch?', status: 'read', raw_payload: { origin: 'outbound' }, at: ago(24 * 5 - 0.1) });
    await msg(pool, { id: mid('h3'), wa: NUM_A, to: L.hot, direction: 'outgoing', message_type: 'template', body: '', status: 'read', send_origin: 'broadcast', template_id: ids.tpl, at: ago(24 * 2) });
    await msg(pool, { id: mid('h4'), wa: NUM_A, to: L.hot, message_type: 'audio', body: 'Audio message', at: ago(20) });
    await msg(pool, { id: mid('h5'), wa: NUM_A, to: L.hot, message_type: 'interactive', body: 'Pay now', at: ago(19) });
    await msg(pool, { id: mid('h6'), wa: NUM_A, to: L.hot, direction: 'outgoing', body: 'Sending the link now', status: 'delivered', raw_payload: { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'smb_message_echoes' }] }] }, at: ago(18) });
    await msg(pool, { id: mid('h7'), wa: NUM_A, to: L.hot, body: 'fees evlo? naalaiku join panlama', at: ago(1) });
    await msg(pool, { id: mid('h8'), wa: NUM_A, to: L.hot, body: 'Is EMI available?', at: ago(0.5) });
    await pool.query(`INSERT INTO coexistence.chat_message_artifacts (source, message_key, kind, text, status, language) VALUES ('chat',$1,'transcript','fees evlo? weekend batch iruka','ok','ta')`, [mid('h4')]);

    await msg(pool, { id: mid('o1'), wa: NUM_A, to: L.optedOut, body: 'fees please', at: ago(2) });
    await msg(pool, { id: mid('d1'), wa: NUM_A, to: L.dnc, body: 'fees please', at: ago(2) });
    await msg(pool, { id: mid('b1'), wa: NUM_B, to: L.onB, body: 'fees for the weekend batch?', at: ago(3) });
    await msg(pool, { id: mid('x1'), wa: NUM_A, to: L.old, body: 'fees? (old)', at: ago(24 * 40) });
    await msg(pool, { id: mid('e1'), wa: NUM_A, to: L.enrolled, body: 'paid', at: ago(24 * 4) });

    // The enrolled lead: one gateway payment written TWICE (the Razorpay double-row) +
    // one manual sales_log row. Price ₹5,000; paid ₹2,000 + ₹1,000.
    await pool.query(
      `INSERT INTO coexistence.razorpay_events (event_type, status, payment_id, amount_paise, matched_lead_id, method, created_at, signature_valid)
       VALUES ('payment.captured','captured',$3,200000,$1,'upi',$2,TRUE), ('order.paid','captured',$3,200000,$1,'upi',$2,TRUE)`,
      [ids.enrolled, ago(24 * 4), names.payment]);
    await pool.query(
      `INSERT INTO coexistence.sales_log (lead_id, student_name, course_id, amount_paise, payment_date, method)
       VALUES ($1, $3, $2, 100000, (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 1, 'Cash')`, [ids.enrolled, ids.course, names.student]);

    await pool.query(`INSERT INTO coexistence.campaign_ads (ad_external_id, campaign_external_id, name, status, spend, leads, impressions, clicks) VALUES ($1,$2,'WF ad','active',100,1,10,2)`, [names.ad, `${P}-cmp`]);
    await pool.query(`INSERT INTO coexistence.ad_daily_stats (ad_external_id, stat_date, spend, impressions, clicks, leads) VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 2, 100, 10, 2, 1)`, [names.ad]);
    await pool.query(`INSERT INTO coexistence.ctwa_referrals (contact_number, lead_id, source_id, source_type, platform, headline, message_id, clicked_at, raw) VALUES ($1,$2,$3,'ad','Instagram','Learn AI',$4,$5,'{}')`, [L.hot, ids.hot, names.ad, mid('h1'), ago(24 * 5)]);

    const ag = await pool.query(`INSERT INTO coexistence.workflow_agents (name, slug) VALUES ('WF test agent', $1) RETURNING id`, [names.agentSlug]);
    ids.agent = ag.rows[0].id;
    return ids;
  }

  return { seed, cleanup, ids, L, NUM_A, NUM_B, now, ago, names, mid, tag: T };
}

module.exports = { makeWorld };
