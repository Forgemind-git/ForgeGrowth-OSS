// Opt-in demo seed for the AI Academy Dashboard. NOT a migration — run once by
// hand so Marketing/Sales/Chats dashboards render on the fresh ForgeGrowth
// instance. Idempotent: guarded by a marker resource so re-running is a no-op.
// Wipe before real data lands:  DELETE FROM coexistence.leads; (cascades events)
//
// Run:  docker exec -i forgegrowth-backend node scripts/seed-academy.js
//   or: cd backend && node scripts/seed-academy.js   (with DB env set)

const pool = require('../src/db');

const SOURCES = ['CTWA Ad', 'Instagram', 'YouTube', 'Referral', 'Webinar', 'WhatsApp Direct'];
const CITIES = ['Bengaluru', 'Mumbai', 'Delhi', 'Hyderabad', 'Pune', 'Chennai', 'Kolkata', 'Jaipur'];
const ROLES = ['Student', 'Working Professional', 'Freelancer', 'Business Owner', 'Job Seeker'];
const GOALS = ['Get a job', 'Start freelancing', 'Build a product', 'Upskill', 'Career switch'];
const STAGES = ['new', 'contacted', 'engaged', 'hot', 'enrolled', 'cold_lost'];
// Weighted distribution so the funnel looks realistic (fat top, thin bottom).
const STAGE_WEIGHTS = ['new', 'new', 'new', 'contacted', 'contacted', 'contacted', 'engaged', 'engaged', 'hot', 'hot', 'enrolled', 'cold_lost'];
const NAMES = ['Aarav Sharma', 'Diya Patel', 'Vihaan Reddy', 'Ananya Iyer', 'Arjun Nair', 'Saanvi Rao', 'Reyansh Gupta', 'Ishaan Menon', 'Aadhya Singh', 'Kabir Khanna', 'Myra Joshi', 'Vivaan Das', 'Anika Bose', 'Advait Kulkarni', 'Kiara Shah', 'Rudra Pillai', 'Navya Malhotra', 'Shaurya Verma', 'Riya Chatterjee', 'Aryan Kapoor', 'Sara Fernandes', 'Dhruv Agarwal', 'Zara Sheikh', 'Ayaan Mirza', 'Prisha Reddy', 'Ved Bhatt', 'Aisha Qureshi', 'Krish Mehta', 'Tara Menon', 'Neil DSouza', 'Ira Saxena', 'Yuvan Raj', 'Meera Pillai', 'Om Prakash', 'Anvi Deshpande', 'Rehan Ali', 'Nitya Hegde', 'Laksh Jain', 'Pihu Sinha', 'Kian Thomas'];

const pick = (arr, i) => arr[i % arr.length];
const rand = (n) => Math.floor(Math.random() * n);
const daysAgo = (d) => new Date(Date.now() - d * 86400000);

async function alreadySeeded() {
  const { rows } = await pool.query(
    `SELECT 1 FROM coexistence.resources WHERE title = '__academy_seed_marker__' LIMIT 1`
  );
  return rows.length > 0;
}

async function main() {
  if (await alreadySeeded()) {
    console.log('[seed] already seeded (marker present) — skipping. Delete the __academy_seed_marker__ resource to re-seed.');
    process.exit(0);
  }
  console.log('[seed] seeding AI Academy demo data…');

  // ── team members (BDAs) ─────────────────────────────────────────────────────
  const bdas = [
    { name: 'Priya Menon', role: 'Senior BDA' },
    { name: 'Rohit Sharma', role: 'BDA' },
    { name: 'Sneha Kapoor', role: 'BDA' },
    { name: 'Amit Verma', role: 'BDA' },
    { name: 'Kavya Nair', role: 'Junior BDA' },
    { name: 'Farhan Ali', role: 'Junior BDA' },
  ];
  const bdaIds = [];
  for (let i = 0; i < bdas.length; i++) {
    const id = `bda-seed-${i + 1}`;
    await pool.query(
      `INSERT INTO coexistence.team_members (id, name, role, whatsapp_agent_id, active, phone_number)
       VALUES ($1,$2,$3,$4,TRUE,$5)
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, active = TRUE`,
      [id, bdas[i].name, bdas[i].role, `agent-${900000000 + i}`, `+9198765${43210 + i}`]
    );
    bdaIds.push(id);
  }

  // ── campaigns ───────────────────────────────────────────────────────────────
  const campaigns = [
    { name: 'Meta CTWA — Job Seekers', platform: 'CTWA Ad', spend: 48000, leads: 320, enr: 22, source: 'ctwa' },
    { name: 'YouTube Pre-roll — Free Class', platform: 'YouTube', spend: 32000, leads: 180, enr: 11, source: 'manual' },
    { name: 'Instagram Reels Boost', platform: 'Instagram', spend: 21000, leads: 140, enr: 7, source: 'manual' },
    { name: 'Referral Rewards Q3', platform: 'Referral', spend: 9000, leads: 60, enr: 9, source: 'manual' },
  ];
  for (const c of campaigns) {
    await pool.query(
      `INSERT INTO coexistence.campaigns (name, platform, status, spend, leads_generated, enrollments, start_date, end_date, source)
       VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8)`,
      [c.name, c.platform, c.spend, c.leads, c.enr, daysAgo(45), daysAgo(1), c.source]
    );
  }

  // ── webinars ────────────────────────────────────────────────────────────────
  const webinars = [
    { batch: 'Batch 12 — Aug Cohort', when: daysAgo(-4), reg: 210, att: 0, ns: 0 },
    { batch: 'Batch 11 — Jul Cohort', when: daysAgo(10), reg: 240, att: 156, ns: 84 },
    { batch: 'Batch 10 — Jun Cohort', when: daysAgo(38), reg: 190, att: 132, ns: 58 },
  ];
  const webinarIds = [];
  for (const w of webinars) {
    const { rows } = await pool.query(
      `INSERT INTO coexistence.webinars (batch_name, date, landing_page_url, registrations, attended, no_shows)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [w.batch, w.when, `https://academy.example.com/${w.batch.split(' ')[0].toLowerCase()}${w.batch.split(' ')[1]}`, w.reg, w.att, w.ns]
    );
    webinarIds.push(Number(rows[0].id));
  }

  // ── resources: Content Library (static) ─────────────────────────────────────
  const content = [
    { title: 'AI Career Roadmap 2026 (PDF)', type: 'PDF', stages: ['new', 'contacted'], phrases: ['roadmap', 'career'], opens: 420, sends: 610, clicks: 380, replies: 210 },
    { title: 'Free Masterclass Replay', type: 'Video', stages: ['engaged'], phrases: ['replay', 'masterclass'], opens: 260, sends: 340, clicks: 190, replies: 150 },
    { title: 'Student Success Stories', type: 'Testimonial', stages: ['hot'], phrases: ['testimonial', 'reviews', 'success'], opens: 180, sends: 220, clicks: 120, replies: 96 },
    { title: 'Curriculum Overview', type: 'PDF', stages: ['contacted', 'engaged'], phrases: ['curriculum', 'syllabus'], opens: 340, sends: 500, clicks: 260, replies: 140 },
    { title: 'Placement Report (PDF)', type: 'PDF', stages: ['hot'], phrases: ['placement', 'salary', 'jobs'], opens: 300, sends: 360, clicks: 220, replies: 175 },
    { title: 'Demo Project Walkthrough', type: 'Video', stages: ['engaged', 'hot'], phrases: ['demo', 'project'], opens: 150, sends: 280, clicks: 100, replies: 80 },
    { title: 'Scholarship & EMI Options', type: 'Link', stages: ['hot'], phrases: ['emi', 'scholarship', 'discount'], opens: 220, sends: 260, clicks: 180, replies: 140 },
    { title: 'Community Guidelines', type: 'Community', stages: ['enrolled'], phrases: ['community', 'group rules'], opens: 90, sends: 120, clicks: 40, replies: 20 },
    { title: 'Alumni Panel Recording', type: 'Video', stages: ['engaged'], phrases: ['alumni'], opens: 110, sends: 200, clicks: 70, replies: 55 },
  ];
  for (const r of content) {
    await pool.query(
      `INSERT INTO coexistence.resources (title, type, stage_tags, file_url, is_dynamic, trigger_phrases, applicable_stage, opens, clicks, sends, replies_after_send)
       VALUES ($1,$2,$3,$4,FALSE,$5,$6,$7,$8,$9,$10)`,
      [r.title, r.type, JSON.stringify(r.stages), 'https://drive.google.com/file/d/demo', JSON.stringify(r.phrases), r.stages[0], r.opens, r.clicks, r.sends, r.replies]
    );
  }

  // ── resources: Live Links (dynamic, change every batch) ─────────────────────
  const liveLinks = [
    { title: 'Current Webinar Link + Date', type: 'Calendar', url: 'https://zoom.us/j/aug-batch-12', phrases: ['webinar link', 'join class', 'session'] },
    { title: 'Current Payment Link', type: 'Payment', url: 'https://rzp.io/l/academy-aug', phrases: ['pay', 'payment link', 'enroll'] },
    { title: 'Current Batch Group Link', type: 'Community', url: 'https://chat.whatsapp.com/BatchGroupAug', phrases: ['group link', 'community', 'batch group'] },
  ];
  for (const r of liveLinks) {
    await pool.query(
      `INSERT INTO coexistence.resources (title, type, stage_tags, file_url, is_dynamic, trigger_phrases, applicable_stage)
       VALUES ($1,$2,$3,$4,TRUE,$5,$6)`,
      [r.title, r.type, JSON.stringify(['hot', 'enrolled']), r.url, JSON.stringify(r.phrases), 'hot']
    );
  }

  // ── collect fields ──────────────────────────────────────────────────────────
  const collectFields = [
    { stage: 'new', label: 'Full Name', type: 'Text', maps: 'name', by: 'bot', ord: 0 },
    { stage: 'new', label: 'City', type: 'Text', maps: 'city', by: 'bot', ord: 1 },
    { stage: 'contacted', label: 'Goal', type: 'Choice', maps: 'goal', by: 'bot', ord: 2 },
    { stage: 'contacted', label: 'Current Role', type: 'Choice', maps: 'role', by: 'bot', ord: 3 },
    { stage: 'enrolled', label: 'Payment Screenshot', type: 'Document', maps: null, by: 'BDA', ord: 4 },
    { stage: 'enrolled', label: 'ZIP Code', type: 'Text', maps: 'zip', by: 'webhook', ord: 5 },
  ];
  for (const f of collectFields) {
    await pool.query(
      `INSERT INTO coexistence.collect_fields (stage, label, field_type, maps_to_lead_column, collected_by, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [f.stage, f.label, f.type, f.maps, f.by, f.ord]
    );
  }

  // ── leads ───────────────────────────────────────────────────────────────────
  const leadIds = [];
  for (let i = 0; i < NAMES.length; i++) {
    const stage = pick(STAGE_WEIGHTS, i + rand(3));
    const score = stage === 'enrolled' ? 78 + rand(22)
      : stage === 'hot' ? 55 + rand(20)
      : stage === 'engaged' ? 30 + rand(20)
      : stage === 'cold_lost' ? rand(20)
      : rand(30);
    const bda = pick(bdaIds, i);
    const source = pick(SOURCES, i + rand(2));
    const followUps = stage === 'cold_lost' ? 3 : rand(3);
    const createdDaysAgo = 5 + rand(55);
    const { rows } = await pool.query(
      `INSERT INTO coexistence.leads
        (name, whatsapp_number, email, city, role, source, goal, webinar_slot, referred_by,
         stage, score, assigned_bda, follow_up_count, last_inbound_at, last_outbound_at, last_activity_at,
         stage_changed_at, has_whatsapp_thread, created_at, updated_at,
         payment_date, form_status, zip, state, batch_assigned, tool_access, batch_group_added, prebatch_reminder_sent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,TRUE,$18,$18,
               $19,$20,$21,$22,$23,$24,$25,$26)
       ON CONFLICT (whatsapp_number) DO NOTHING
       RETURNING id`,
      [
        NAMES[i], `9190000${String(1000 + i).padStart(4, '0')}`,
        `${NAMES[i].split(' ')[0].toLowerCase()}@example.com`,
        pick(CITIES, i), pick(ROLES, i), source, pick(GOALS, i),
        i % 3 === 0 ? pick(webinars, i).batch : null,
        source === 'Referral' ? pick(NAMES, i + 5) : null,
        stage, score, bda, followUps,
        daysAgo(rand(5)), daysAgo(rand(3)), daysAgo(rand(4)), daysAgo(rand(20)),
        daysAgo(createdDaysAgo),
        stage === 'enrolled' ? daysAgo(rand(20)) : null,
        stage === 'enrolled' ? (i % 2 ? 'complete' : 'pending') : 'pending',
        stage === 'enrolled' ? String(560000 + rand(40000)) : null,
        stage === 'enrolled' ? pick(['KA', 'MH', 'DL', 'TS', 'TN'], i) : null,
        stage === 'enrolled' ? pick(webinars, i).batch : null,
        stage === 'enrolled' && i % 2 === 0, stage === 'enrolled' && i % 3 === 0, stage === 'enrolled' && i % 2 === 0,
      ]
    );
    if (rows[0]) {
      leadIds.push(Number(rows[0].id));
      // lead_events: a stage-changed audit row
      await pool.query(
        `INSERT INTO coexistence.lead_events (lead_id, event_type, from_value, to_value, actor, ts)
         VALUES ($1,'stage_changed',NULL,$2,'seed',$3)`,
        [rows[0].id, stage, daysAgo(rand(20))]
      );
      if (score > 50) {
        await pool.query(
          `INSERT INTO coexistence.lead_events (lead_id, event_type, from_value, to_value, actor, ts)
           VALUES ($1,'score_changed','0',$2,'auto:passive-scorer',$3)`,
          [rows[0].id, String(score), daysAgo(rand(10))]
        );
      }
    }
  }

  // ── webinar registrations ───────────────────────────────────────────────────
  for (let i = 0; i < leadIds.length; i++) {
    if (i % 2 !== 0) continue; // ~half register
    const wid = pick(webinarIds, i);
    const attended = i % 3 !== 0;
    await pool.query(
      `INSERT INTO coexistence.webinar_registrations (lead_id, webinar_id, attended, attendance_form_submitted, reminded)
       VALUES ($1,$2,$3,$4,TRUE)
       ON CONFLICT (lead_id, webinar_id) DO NOTHING`,
      [leadIds[i], wid, attended, attended && i % 2 === 0]
    );
  }

  // ── bda activity log ────────────────────────────────────────────────────────
  const actions = ['message_sent', 'trigger_fired', 'stage_note'];
  const phrases = ['pay', 'curriculum', 'placement', 'webinar link', 'demo', 'emi'];
  for (let i = 0; i < 220; i++) {
    const bda = pick(bdaIds, i);
    const leadId = leadIds.length ? pick(leadIds, i + rand(leadIds.length)) : null;
    const action = pick(actions, i + rand(3));
    await pool.query(
      `INSERT INTO coexistence.bda_activity_log (ts, bda, lead_id, action, trigger_phrase, response_time_seconds)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        daysAgo(rand(14)), bda, leadId, action,
        action === 'trigger_fired' ? pick(phrases, i) : null,
        action === 'message_sent' ? 30 + rand(3600) : null,
      ]
    );
  }

  // ── marker (guards re-seed) ─────────────────────────────────────────────────
  await pool.query(
    `INSERT INTO coexistence.resources (title, type, is_dynamic, is_retired)
     VALUES ('__academy_seed_marker__', 'Link', FALSE, TRUE)`
  );

  console.log(`[seed] done: ${bdaIds.length} BDAs, ${campaigns.length} campaigns, ${webinarIds.length} webinars, ${leadIds.length} leads, ${content.length + liveLinks.length} resources, 220 activity rows.`);
  process.exit(0);
}

main().catch(err => {
  console.error('[seed] error:', err);
  process.exit(1);
});
