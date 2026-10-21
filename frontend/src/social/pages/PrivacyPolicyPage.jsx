import { C, FONT, MONO, T } from '../constants.js';
import { PageHeader } from '../components/UI.jsx';

// A readable document on the pane: h2 26/780, body 15/450 secondary, no rules.
const Section = ({ title, children }) => (
  <div style={{ marginBottom: 36 }}>
    <h2 style={{ ...T.h2, color: C.text, margin: '0 0 12px', fontFamily: FONT }}>{title}</h2>
    <div style={{ ...T.body, lineHeight: 1.6, color: C.textSecondary }}>{children}</div>
  </div>
);

const P = ({ children }) => <p style={{ margin: '0 0 10px' }}>{children}</p>;

const Ul = ({ items }) => (
  <ul style={{ paddingLeft: 22, margin: '0 0 10px' }}>
    {items.map((item, i) => <li key={i} style={{ marginBottom: 6 }}>{item}</li>)}
  </ul>
);

const Code = ({ children }) => (
  <code style={{ background: C.surface, padding: '2px 8px', borderRadius: 12, fontSize: 13, fontFamily: MONO, color: C.text }}>{children}</code>
);

export default function PrivacyPolicyPage({ standalone = false }) {
  const body = (
    <div style={{ fontFamily: FONT, color: C.text }}>
      {standalone && (
        <div style={{ marginBottom: 28, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>
            <span style={{ color: C.text }}>Forge</span>
            <span style={{ color: C.primary }}>Social</span>
          </div>
        </div>
      )}

      <PageHeader title="Privacy Policy" sub={<span style={{ ...T.small, color: C.textMuted }}>Last updated: May 10, 2026 &nbsp;·&nbsp; Effective: May 10, 2026</span>} />

      <Section title="1. Overview">
        <P>ForgeGrowth is a social media analytics dashboard operated by the organisation that runs this install ("we", "our", "us"). This Privacy Policy explains how we collect, use, and protect information when you use ForgeGrowth to connect and analyse your social media accounts.</P>
        <P>ForgeGrowth is an internal business tool. Access is restricted to that organisation's authorised team members only.</P>
      </Section>

      <Section title="2. Information We Collect">
        <P><strong>Account information:</strong> Username and hashed password for dashboard login. We do not store plaintext passwords.</P>
        <P><strong>Social platform credentials:</strong> OAuth access tokens for connected Instagram accounts. Tokens are stored encrypted in our database and are never shared with third parties.</P>
        <P><strong>Analytics data:</strong> Metrics pulled from connected social platforms — including follower counts, impressions, reach, engagement, post performance, and audience data. This data is read-only and used solely for display inside the dashboard.</P>
        <P><strong>Session data:</strong> An httpOnly JWT cookie is set when you sign in. It is used only to authenticate your session and expires automatically.</P>
      </Section>

      <Section title="3. Connected Social Platforms">
        <P>When you connect a social account, ForgeGrowth requests read-only access to analytics data. We access the following platform via its official API:</P>
        <Ul items={[
          'Instagram — via Instagram Graph API (Meta)',
        ]} />
        <P>We only request the minimum permissions required to retrieve analytics. We do not post content, send messages, or modify any social account data on your behalf without your explicit action.</P>
        <P>The platform's own privacy policy applies to how it handles your data before it reaches us:</P>
        <Ul items={[
          'Meta (Instagram): https://www.facebook.com/privacy/policy',
        ]} />
      </Section>

      <Section title="4. How We Use Your Information">
        <Ul items={[
          'To display analytics, metrics, and content performance inside the ForgeGrowth dashboard',
          'To authenticate your session and maintain access to protected features',
          'To refresh access tokens before they expire, ensuring uninterrupted analytics access',
          'To identify and troubleshoot integration issues',
        ]} />
        <P>We do not sell, rent, or share your data or your social platform credentials with any third party.</P>
      </Section>

      <Section title="5. Data Storage and Security">
        <P>All data is stored on the server this install runs on, operated by the organisation that hosts it. The server is accessible only to that organisation's authorised personnel. Database credentials and social platform tokens are stored with access controls and are not exposed in source code or public repositories.</P>
        <P>Session tokens are stored in httpOnly, Secure cookies — they are inaccessible to JavaScript and protected against XSS attacks.</P>
        <P>Social platform OAuth tokens are stored in a private PostgreSQL database. Access to this database is restricted to the application process only.</P>
      </Section>

      <Section title="6. Data Retention">
        <P>Social platform tokens are retained until you disconnect the platform via the Integrations page or an admin removes them. Analytics metrics are not permanently stored — they are fetched on demand from the platform APIs and cached temporarily (up to 15 minutes) in memory only.</P>
        <P>User accounts persist until removed by an administrator.</P>
      </Section>

      <Section title="7. Your Rights">
        <P>As an authorised user of this internal tool, you may:</P>
        <Ul items={[
          'Request removal of your account',
          'Disconnect any connected social platform at any time via the Integrations page',
          'Request a copy of any personal data we hold',
        ]} />
        <P>For any data requests, contact the administrator of this install.</P>
      </Section>

      <Section title="8. Cookies">
        <P>ForgeGrowth uses a single httpOnly session cookie (<Code>forgesocial_token</Code>) to maintain your login session. No third-party cookies or tracking scripts are used.</P>
      </Section>

      <Section title="9. Changes to This Policy">
        <P>We may update this policy as the platform evolves. The "Last updated" date at the top of this page reflects when changes were last made. Continued use of ForgeGrowth after changes constitutes acceptance of the revised policy.</P>
      </Section>

      <Section title="10. Contact">
        <P>For questions about this Privacy Policy or data practices, contact:</P>
        <Ul items={[
          'The administrator of this install (the organisation that operates it)',
          `Platform URL: ${window.location.origin}`,
        ]} />
      </Section>
    </div>
  );

  if (standalone) {
    // Public #/social-privacy: a floating card column on the page ground, no shell.
    return (
      <div style={{ minHeight: 'calc(100vh / var(--fg-zoom, 1))', background: C.pageBg, fontFamily: FONT, padding: '40px 24px 80px', boxSizing: 'border-box' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', background: C.card, borderRadius: 24, padding: 40, boxShadow: C.shadowSm }}>
          {body}
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 860, paddingBottom: 40 }}>
      {body}
    </div>
  );
}
