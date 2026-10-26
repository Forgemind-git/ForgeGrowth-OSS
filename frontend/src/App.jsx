import { useIsPhone } from './lib/useIsPhone.js';
import { useState, useEffect, useRef } from 'react';
import { api } from './api.js';
import { C, FONT } from './constants.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import { loadFunnelConfig } from './hooks/useFunnelConfig.js';
import { loadFieldRegistry } from './hooks/useFieldRegistry.js';
import LoginGate from './components/LoginGate.jsx';
import FeedbackModal from './components/FeedbackModal.jsx';
import PageErrorBoundary from './components/PageErrorBoundary.jsx';
import Topbar from './components/Topbar.jsx';
import AutomationHub, { hubOf } from './components/AutomationHub.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatsPage from './components/ChatsPage.jsx';
import HomePage from './pages/HomePage.jsx';
import ChatbotBuilderPage from './pages/ChatbotBuilderPage.jsx';
import TemplateBuilderPage from './pages/TemplateBuilderPage.jsx';
import BulkMessagePage from './pages/BulkMessagePage.jsx';
import AdminSettingsPage from './pages/AdminSettingsPage.jsx';
import MediaLibraryPage from './pages/MediaLibraryPage.jsx';
import PipelinesPage from './pages/PipelinesPage.jsx';
import AiAgentBuilderPage from './pages/AiAgentBuilderPage.jsx';
import MessageCostsPage from './pages/MessageCostsPage.jsx';
// AI Academy — Sales
import LeadsHubPage from './pages/sales/LeadsHubPage.jsx';
// Workflow agents (migration 121) — Claude agents over the CRM's data.
import WorkflowAgentsPage from './pages/workflowAgents/WorkflowAgentsPage.jsx';
import WorkflowApprovalsPage from './pages/workflowAgents/ApprovalsPage.jsx';
import MyListPage from './pages/sales/MyListPage.jsx';
import { PAGE_ALIASES } from './components/Sidebar.jsx';
// AI Academy — Chats additive
// Social — the ported ForgeSocial app, its own header tab (2026-10-11).
import SocialSection, { socialNavId, socialPublicPage } from './social/SocialSection.jsx';

const VALID_PAGES = new Set([
  'home', 'chatbot-builder', 'template-builder', 'chats',
  'bulk-message', 'admin-settings', 'media-library',
  'pipelines', 'ai-agent-builder',
  // Sales — 'sales-pipeline' and 'sales-funnel' are legacy keys kept so old
  // links and any stored permission override keep resolving; both land on the
  // Leads hub. 'bda-performance' and 'contacts' were removed with their pages,
  // and 'chat-analyzer' with the Chat Analyzer (2026-10-21).
  'sales-pipeline', 'leads',
  'sales-funnel',
  // Message costs — a full-width dashboard; its configuration lives in
  // Admin Settings -> Message Costs.
  'message-costs',
  // Workflow agents: the agents + builder, the approvals queue, a rep's worklist.
  'workflow-agents', 'workflow-agent-approvals', 'follow-ups',
  // Social — one page key; everything after #/social/ is the Social section's own route.
  'social',
]);

// Which header section (Social / Sales) owns each page. The hash is the
// single source of truth — section is DERIVED, so a refresh keeps you in the
// right workspace. Everything that is not Social IS Sales, so a new Sales page
// cannot be forgotten here and land in the wrong workspace.
const sectionOf = (page) => (page === 'social' ? 'social' : 'sales');

// The landing page when a section tab is clicked. Sales opens on the Leads hub,
// which itself opens on the Funnel; Home stays the login landing page and is
// reachable from the pinned item above the groups.
const SECTION_FIRST_PAGE = { sales: 'leads', social: 'social' };

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [routeParts, navigate, replaceRoute] = useHashRoute();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const page = VALID_PAGES.has(routeParts[0]) ? routeParts[0] : 'home';
  const subParts = routeParts.slice(1);
  // A Social sidebar id is a full route ('social/inbox'), so split it into parts.
  const setPage = (p) => navigate(...String(p).split('/'));
  // Header workspace tab is derived from the current page, so the hash is the
  // single source of truth (a refresh keeps you in the right workspace).
  // admin-settings keeps whatever section it was reached from — but the tabs are
  // hidden there anyway, so 'chats' is a harmless default.
  const section = sectionOf(page);
  // The nav key the sidebar and the tab hubs work on: a Social view is its
  // full route ('social/<view>'), everything else its page key.
  const navKey = page === 'social' ? socialNavId(subParts) : page;
  const changeSection = (s) => navigate(SECTION_FIRST_PAGE[s] || 'home');

  // Normalize empty hash to #/home so reload always shows a valid URL.
  useEffect(() => {
    if (!routeParts[0]) replaceRoute('home');
  }, [routeParts, replaceRoute]);

  // Page-level guard: redirect non-admin users away from pages they can't see.
  // `user.pages` is loaded by /api/auth/me and contains every page key the
  // user's role + permissions grant. Admin bypasses the check.
  // Special case: 'admin-settings' is gated via 'admin-settings:<tab>' entries,
  // so the page is allowed if any such entry is present.
  useEffect(() => {
    if (!user) return;
    if (user.role === 'admin') return;
    const allowed = Array.isArray(user.pages) ? user.pages : [];
    const pageOk =
      page === 'home'
      || allowed.includes(page)
      || (PAGE_ALIASES[page] || []).some(k => allowed.includes(k))
      || (page === 'admin-settings' && allowed.some(p => p.startsWith('admin-settings:') || p === 'social'));
    if (!pageOk) {
      replaceRoute('home');
    }
  }, [user, page, replaceRoute]);

  // The automation builder wants the room, so the sidebar collapses on the way
  // in — and RESTORES on the way out.
  //
  // ⚠ It used to only collapse. That left you in the 68px rail for the rest of
  // the session after one visit to Automations, with no automatic way back, and
  // now that every destination lives in the Sales section's groups it hid the
  // whole structure rather than just the Chats nav. A manual collapse is still
  // respected: `pinned` remembers what the operator chose BEFORE the builder took
  // over, so leaving restores their preference rather than forcing it open.
  //
  // A phone gets the same rail: the full 248px sidebar left ~90px for the page
  // at 390px wide, which made every page — and the reps' "My leads today" list,
  // which is meant to be used on a phone — unreadable. Desktop is unchanged.
  const pinnedCollapse = useRef(false);
  // Only the flow CANVAS (#/chatbot-builder/<id>) takes the rail — the Flows
  // list is now the Automations hub's landing tab and keeps the full sidebar.
  const inBuilder = page === 'chatbot-builder' && !!subParts[0] && subParts[0] !== 'folder';
  // A phone has no side nav at all — the bottom tab bar replaces it (below).
  const phone = useIsPhone();
  const forceRail = inBuilder;
  useEffect(() => {
    if (forceRail) {
      setSidebarCollapsed(prev => { pinnedCollapse.current = prev; return true; });
    } else {
      setSidebarCollapsed(pinnedCollapse.current);
    }
  }, [forceRail]);

  useEffect(() => {
    api.auth.me()
      .then(({ user }) => { setUser(user); loadFunnelConfig(); loadFieldRegistry(); })  // warm the funnel + field-registry caches
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  // Return hop for the MCP connector's OAuth consent screen.
  //
  // ⚠ Claude sends the operator to /api/mcp/oauth/authorize as a CROSS-SITE
  // navigation, and our session cookie is SameSite=Strict — so the browser
  // withholds it and that page cannot tell a signed-in operator from a stranger.
  // It therefore bounces here with `?next=<the authorize path>`. Going back from
  // our own origin is SAME-SITE, the cookie is sent, and consent renders.
  // Without this the operator loops forever: sign in, land on Home, retry from
  // Claude, get the sign-in page again.
  //
  // ⚠ `next` is attacker-reachable (it is just a query param), so it is accepted
  // ONLY as a relative path addressing this one route — never as an absolute
  // URL, which would make this an open redirect.
  useEffect(() => {
    if (!user) return;
    const next = new URLSearchParams(window.location.search).get('next');
    if (!next || !next.startsWith('/api/mcp/oauth/authorize')) return;
    window.location.replace(next);
  }, [user]);

  const handleLogout = async () => {
    await api.auth.logout().catch(() => {});
    setUser(null);
    setPage('home');
  };

  // Social's public pages: a shared report link and the privacy policy.
  const socialPublic = socialPublicPage(routeParts);
  if (socialPublic) return socialPublic;

  if (checking) {
    return (
      <div style={{
        minHeight: 'calc(100vh / var(--fg-zoom, 1))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: FONT,
        background: C.pageBg,
      }}>
        <div style={{ fontSize: 15, color: C.textMuted, fontWeight: 500 }}>Loading…</div>
      </div>
    );
  }

  if (!user) {
    return (<><LoginGate onLogin={setUser} /><FeedbackModal /></>);
  }

  const renderPage = () => {
    switch (page) {
      case 'home': return <HomePage user={user} onPageChange={setPage} />;
      case 'chats': return <ChatsPage subParts={subParts} navigate={navigate} user={user} />;
      case 'template-builder': return <TemplateBuilderPage subParts={subParts} navigate={navigate} />;
      case 'media-library': return <MediaLibraryPage />;
      case 'bulk-message': return <BulkMessagePage onNavigate={navigate} user={user} />;
      case 'chatbot-builder': return <ChatbotBuilderPage subParts={subParts} navigate={navigate} />;
      case 'ai-agent-builder': return <AiAgentBuilderPage user={user} navigate={navigate} />;
      case 'admin-settings': return <AdminSettingsPage onLogout={handleLogout} onNavigate={setPage} subParts={subParts} navigate={navigate} user={user} />;
      case 'pipelines': return <PipelinesPage user={user} />;
      // Sales — one unified Leads tab. `sales-pipeline` / `sales-funnel` are
      // legacy hashes kept so old links and permission grants keep resolving;
      // they open the hub on the matching view. Pipeline is no longer a tab of
      // its own — it is the BOARD view of All Leads — so the old pipeline hash
      // now lands there rather than on a tab that does not exist.
      case 'sales-pipeline': return <LeadsHubPage user={user} navigate={navigate} subParts={['list', 'board']} />;
      case 'sales-funnel': return <LeadsHubPage user={user} navigate={navigate} subParts={[]} />;
      case 'leads': return <LeadsHubPage user={user} navigate={navigate} subParts={subParts} />;
      case 'message-costs': return <MessageCostsPage user={user} navigate={navigate} subParts={subParts} />;
      // subParts: [] list · ['settings'] · [agentId, tab, runId?]
      case 'workflow-agents': return <WorkflowAgentsPage user={user} navigate={navigate} subParts={subParts} />;
      case 'workflow-agent-approvals': return <WorkflowApprovalsPage user={user} navigate={navigate} />;
      case 'follow-ups': return <MyListPage user={user} navigate={navigate} subParts={subParts} />;
      // opens one thread while the nav item stays highlighted.
      case 'social': return <SocialSection user={user} navigate={navigate} subParts={subParts} />;
      default: return <HomePage user={user} onPageChange={setPage} />;
    }
  };

  return (
    // THE SHELL — panels FLOAT on the page ground with a gutter all round, and
    // never touch the viewport edge. `.fc-app` owns the gutter and the only
    // `overflow: hidden` in the layout, so the PAGE never scrolls; the content
    // pane scrolls inside itself. Both are in styles/forge.css rather than
    // inline, because the header, the two panes and the gutter have to agree on
    // one set of numbers and a literal in three files is how they stop agreeing.
    <div className={`fc-app fc-ui${phone && page !== 'admin-settings' ? ' fc-has-tabbar' : ''}`} style={{ fontFamily: FONT }}>
      <Topbar
        user={user}
        onLogout={handleLogout}
        onNavigate={(p) => setPage(p)}
        navigate={navigate}
        section={section}
        onSectionChange={changeSection}
        hideSections={page === 'admin-settings'}
      />
      <div className="fc-body">
        {page !== 'admin-settings' && !phone && (
          <Sidebar
            activePage={page === 'sales-pipeline' || page === 'sales-funnel' ? 'leads' : hubOf(navKey) ? hubOf(navKey).id : navKey}
            onPageChange={setPage}
            collapsed={sidebarCollapsed}
            setCollapsed={setSidebarCollapsed}
            user={user}
            section={section}
          />
        )}
        <main className="fc-pane fc-content">
          {/* One page crashing must not take the whole app down. Keyed on the
              route so navigating away clears the error instead of pinning it. */}
          <PageErrorBoundary resetKey={routeParts.join('/')}>
            {hubOf(navKey)
              ? <AutomationHub page={navKey} user={user} navigate={navigate} hidden={inBuilder}>{renderPage()}</AutomationHub>
              : renderPage()}
          </PageErrorBoundary>
        </main>
      </div>
      {phone && page !== 'admin-settings' && (
        <Sidebar
          variant="bottom"
          activePage={page === 'sales-pipeline' || page === 'sales-funnel' ? 'leads' : hubOf(navKey) ? hubOf(navKey).id : navKey}
          onPageChange={setPage}
          user={user}
          section={section}
        />
      )}
      <FeedbackModal />
    </div>
  );
}
