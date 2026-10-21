// Output → Markdown, for the Results inbox, email and webhooks.
// A Lead Signal output gets a purpose-built layout; anything else gets a generic,
// schema-agnostic rendering so a custom agent's output is still readable.

const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const titleCase = (k) => String(k).replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

function isLeadSignal(output) {
  return output && Array.isArray(output.reps) && output.team_summary && typeof output.team_summary === 'object';
}

function renderLeadSignal(o) {
  const lines = [`# Lead signals — ${o.run_date || ''}`.trim(), ''];
  const s = o.team_summary || {};
  lines.push(`**Team:** ${s.hot ?? 0} hot · ${s.warm ?? 0} warm · ${s.watch ?? 0} watch · ${s.slipping ?? 0} slipping`, '');
  if (Array.isArray(s.top_reasons_not_buying) && s.top_reasons_not_buying.length) {
    lines.push('**Top reasons they are not buying**');
    for (const r of s.top_reasons_not_buying) lines.push(`- ${titleCase(r.reason)} (${r.count ?? 0})${r.example_quote ? ` — “${r.example_quote}”` : ''}`);
    lines.push('');
  }
  if (Array.isArray(s.reps_with_unanswered_hot_leads) && s.reps_with_unanswered_hot_leads.length) {
    lines.push(`**Reps with unanswered hot leads:** ${s.reps_with_unanswered_hot_leads.join(', ')}`, '');
  }
  for (const rep of o.reps || []) {
    lines.push(`## ${rep.rep_name || 'Unassigned'} (${(rep.leads || []).length})`, '');
    (rep.leads || []).forEach((l, i) => {
      lines.push(`${i + 1}. **${l.name_masked || l.contact_id}** — ${String(l.label || '').toUpperCase()} ${l.score ?? ''} · ${l.stage || ''}${l.product ? ` · ${l.product}` : ''}`);
      if (l.reason) lines.push(`   ${l.reason}`);
      for (const e of l.evidence || []) lines.push(`   > “${e.quote}” (${e.at || e.message_id})`);
      if (l.blocker && l.blocker !== 'none') lines.push(`   Blocker: ${titleCase(l.blocker)}`);
      if (l.best_contact_time) lines.push(`   Best time: ${l.best_contact_time}`);
      if (l.suggested_template) lines.push(`   Template: ${l.suggested_template}`);
      if (l.suggested_message) lines.push(`   Suggested: ${l.suggested_message}`);
      lines.push('');
    });
  }
  if (Array.isArray(o.data_gaps) && o.data_gaps.length) {
    lines.push('## Data gaps');
    for (const g of o.data_gaps) lines.push(`- ${g}`);
  }
  return lines.join('\n').trim();
}

function renderValue(value, depth) {
  if (value == null) return '—';
  if (Array.isArray(value)) {
    if (!value.length) return '—';
    const flat = value.every(v => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => x == null || typeof x !== 'object'));
    if (flat && depth < 3) {
      const cols = [...new Set(value.flatMap(v => Object.keys(v)))].slice(0, 8);
      return [`| ${cols.map(titleCase).join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...value.map(v => `| ${cols.map(c => esc(v[c])).join(' | ')} |`)].join('\n');
    }
    return value.map(v => (v && typeof v === 'object' ? `- ${renderValue(v, depth + 1).replace(/\n/g, '\n  ')}` : `- ${v}`)).join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => (v && typeof v === 'object'
      ? `**${titleCase(k)}**\n${renderValue(v, depth + 1)}`
      : `**${titleCase(k)}:** ${v == null ? '—' : v}`)).join('\n');
  }
  return String(value);
}

function renderGeneric(o, agentName) {
  if (!o || typeof o !== 'object') return String(o ?? '');
  const lines = [`# ${agentName || 'Agent result'}`, ''];
  for (const [k, v] of Object.entries(o)) {
    lines.push(`## ${titleCase(k)}`, renderValue(v, 0), '');
  }
  return lines.join('\n').trim();
}

function renderMarkdown(output, { agentName } = {}) {
  return isLeadSignal(output) ? renderLeadSignal(output) : renderGeneric(output, agentName);
}

module.exports = { renderMarkdown, isLeadSignal };
