import { useState, useEffect } from 'react';
import { Megaphone, Kanban, Radio } from 'lucide-react';
import { api } from './api.js';
import { C, FONT } from './constants.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import { loadFunnelConfig } from './hooks/useFunnelConfig.js';
import LoginGate from './components/LoginGate.jsx';
import FeedbackModal from './components/FeedbackModal.jsx';
import Topbar from './components/Topbar.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatsPage from './components/ChatsPage.jsx';
import HomePage from './pages/HomePage.jsx';
import ChatbotBuilderPage from './pages/ChatbotBuilderPage.jsx';
import TemplateBuilderPage from './pages/TemplateBuilderPage.jsx';
import ContactsPage from './pages/ContactsPage.jsx';
import BulkMessagePage from './pages/BulkMessagePage.jsx';
import AdminSettingsPage from './pages/AdminSettingsPage.jsx';
import MediaLibraryPage from './pages/MediaLibraryPage.jsx';
import WaLinksPage from './pages/WaLinksPage.jsx';
import PipelinesPage from './pages/PipelinesPage.jsx';
import AiAgentBuilderPage from './pages/AiAgentBuilderPage.jsx';
// AI Academy — Marketing
import MarketingOverviewPage from './pages/marketing/OverviewPage.jsx';
import CampaignsPage from './pages/marketing/CampaignsPage.jsx';
import CtwaPage from './pages/marketing/CtwaPage.jsx';
import CloPage from './pages/marketing/CloPage.jsx';
import PlaceholderPage from './components/PlaceholderPage.jsx';
// AI Academy — Sales
import SalesPipelinePage from './pages/sales/PipelinePage.jsx';
import FunnelViewerPage from './pages/sales/FunnelViewerPage.jsx';
import LeadsPage from './pages/sales/LeadsPage.jsx';
import BdaPerformancePage from './pages/sales/BdaPerformancePage.jsx';
import ProductsPage from './pages/sales/ProductsPage.jsx';
import PaymentsPage from './pages/sales/PaymentsPage.jsx';
import OnboardingPage from './pages/sales/OnboardingPage.jsx';
// AI Academy — Chats additive
import TeamMembersPage from './pages/TeamMembersPage.jsx';
import LeadFormsPage from './pages/LeadFormsPage.jsx';
import PublicLeadFormPage from './pages/PublicLeadFormPage.jsx';

const VALID_PAGES = new Set([
  'home', 'chatbot-builder', 'template-builder', 'chats',
  'contacts', 'bulk-message', 'admin-settings', 'media-library', 'wa-links',
  'pipelines', 'ai-agent-builder', 'team-members', 'lead-forms',
  // Marketing
  'mkt-overview', 'campaigns', 'ctwa-ads', 'conversion-api', 'clo',
  // Sales
  'sales-pipeline', 'leads', 'bda-performance', 'products', 'payments', 'onboarding',
  'sales-funnel',
]);

// Which header section (Marketing / Sales / Chats) owns each page. The hash is
// the single source of truth — section is derived, so a refresh keeps you in the
// right workspace. Anything not listed belongs to Chats.
const PAGE_SECTION = {
  'mkt-overview': 'marketing', 'campaigns': 'marketing',
  'ctwa-ads': 'marketing', 'conversion-api': 'marketing', 'clo': 'marketing',
  'sales-pipeline': 'sales', 'leads': 'sales',
  'bda-performance': 'sales', 'onboarding': 'sales', 'products': 'sales', 'payments': 'sales',
  'sales-funnel': 'sales',
};
// The landing page when a section tab is clicked.
const SECTION_FIRST_PAGE = { marketing: 'mkt-overview', sales: 'sales-pipeline', chats: 'home' };

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [routeParts, navigate, replaceRoute] = useHashRoute();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const page = VALID_PAGES.has(routeParts[0]) ? routeParts[0] : 'home';
  const subParts = routeParts.slice(1);
  const setPage = (p) => navigate(p);
  // Header workspace tab is derived from the current page, so the hash is the
  // single source of truth (a refresh keeps you in the right workspace).
  // admin-settings keeps whatever section it was reached from — but the tabs are
  // hidden there anyway, so 'chats' is a harmless default.
  const section = PAGE_SECTION[page] || 'chats';
  const changeSection = (s) => navigate(SECTION_FIRST_PAGE[s] || 'home');

  // Path-based public lead-form route (no '#'): WhatsApp/Meta template URL
  // buttons reject '#' fragments ("Invalid parameter"), so per-recipient form
  // links are real paths (/f/<slug>/<token>) that nginx's SPA catch-all serves
  // as index.html. We read slug+token from the pathname here; legacy hash links
  // (#/f/...) still resolve via the check further down.
  const pathForm = typeof window !== 'undefined'
    ? window.location.pathname.match(/^\/f\/([^/]+)(?:\/([^/]+))?\/?$/)
    : null;
  const onPublicFormPath = !!pathForm;

  // Normalize empty hash to #/home so reload always shows a valid URL — but not
  // on a public /f/ path (that would append a stray #/home to the form URL).
  useEffect(() => {
    if (onPublicFormPath) return;
    if (!routeParts[0]) replaceRoute('home');
  }, [routeParts, replaceRoute, onPublicFormPath]);

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
      || (page === 'admin-settings' && allowed.some(p => p.startsWith('admin-settings:')));
    if (!pageOk) {
      replaceRoute('home');
    }
  }, [user, page, replaceRoute]);

  useEffect(() => {
    // Collapse main sidebar by default on automation builder page
    if (page === 'chatbot-builder') {
      setSidebarCollapsed(true);
    }
  }, [page]);

  useEffect(() => {
    api.auth.me()
      .then(({ user }) => { setUser(user); loadFunnelConfig(); })  // warm the funnel-config cache for StageBadge etc.
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  const handleLogout = async () => {
    await api.auth.logout().catch(() => {});
    setUser(null);
    setPage('home');
  };

  // Public Lead Form fill page — reachable with no login (shared link / a
  // WhatsApp template button lands here). Checked before the auth gate below
  // so a visitor never sees the login screen or the "Loading…" spinner.
  if (pathForm) {
    return <PublicLeadFormPage slug={decodeURIComponent(pathForm[1])} token={pathForm[2] ? decodeURIComponent(pathForm[2]) : null} />;
  }
  if (routeParts[0] === 'f' && routeParts[1]) { // legacy hash link (#/f/<slug>/<token>)
    return <PublicLeadFormPage slug={routeParts[1]} token={routeParts[2] || null} />;
  }

  if (checking) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: FONT,
        background: C.pageBg,
      }}>
        <div style={{ fontSize: 13, color: C.textMuted, fontWeight: 500 }}>Loading…</div>
      </div>
    );
  }

  if (!user) {
    return (<><LoginGate onLogin={setUser} /><FeedbackModal /></>);
  }

  // Placeholder main area for the not-yet-built Marketing / Sales workspaces.
  // Admin Settings stays reachable from any section (it isn't section-specific).
  const renderSectionPlaceholder = () => {
    const Icon = section === 'sales' ? Kanban : Megaphone;
    const title = section === 'sales' ? 'Sales' : 'Marketing';
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
      }}>
        <Icon size={44} strokeWidth={1.5} color={C.textMuted} style={{ opacity: 0.45 }} />
        <div style={{ fontSize: 17, fontWeight: 700, color: C.text, fontFamily: FONT }}>
          {title}
        </div>
        <div style={{ fontSize: 13, color: C.textMuted, fontFamily: FONT }}>
          This workspace is empty for now — its pages are coming soon.
        </div>
      </div>
    );
  };

  const renderPage = () => {
    switch (page) {
      case 'home': return <HomePage user={user} onPageChange={setPage} />;
      case 'chats': return <ChatsPage subParts={subParts} navigate={navigate} user={user} />;
      case 'contacts': return <ContactsPage user={user} onNavigate={navigate} />;
      case 'template-builder': return <TemplateBuilderPage subParts={subParts} navigate={navigate} />;
      case 'media-library': return <MediaLibraryPage />;
      case 'bulk-message': return <BulkMessagePage onNavigate={navigate} />;
      case 'chatbot-builder': return <ChatbotBuilderPage subParts={subParts} navigate={navigate} />;
      case 'ai-agent-builder': return <AiAgentBuilderPage user={user} />;
      case 'admin-settings': return <AdminSettingsPage onLogout={handleLogout} onNavigate={setPage} subParts={subParts} navigate={navigate} user={user} />;
      case 'wa-links': return <WaLinksPage subParts={subParts} navigate={navigate} />;
      case 'pipelines': return <PipelinesPage user={user} />;
      case 'team-members': return <TeamMembersPage user={user} />;
      case 'lead-forms': return <LeadFormsPage user={user} subParts={subParts} navigate={navigate} />;
      // Marketing
      case 'mkt-overview': return <MarketingOverviewPage user={user} navigate={navigate} />;
      case 'campaigns': return <CampaignsPage user={user} />;
      case 'ctwa-ads': return <CtwaPage user={user} navigate={navigate} />;
      // Conversions API is not shipped in this release. The tab stays in the nav
      // so the funnel story stays legible; the send path itself is absent.
      case 'conversion-api': return <PlaceholderPage title="Conversion API" icon={Radio}
        subtitle="Send down-funnel conversions back to Meta — Coming Soon" />;
      case 'clo': return <CloPage user={user} subParts={subParts} navigate={navigate} />;
      // Sales
      case 'sales-pipeline': return <SalesPipelinePage user={user} navigate={navigate} />;
      case 'sales-funnel': return <FunnelViewerPage user={user} />;
      case 'leads': return <LeadsPage user={user} subParts={subParts} navigate={navigate} />;
      case 'bda-performance': return <BdaPerformancePage user={user} navigate={navigate} />;
      case 'products': return <ProductsPage user={user} />;
      case 'payments': return <PaymentsPage user={user} navigate={navigate} subParts={subParts} />;
      case 'onboarding': return <OnboardingPage user={user} navigate={navigate} subParts={subParts} />;
      default: return <HomePage user={user} onPageChange={setPage} />;
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      fontFamily: FONT,
      background: C.pageBg,
    }}>
      <Topbar
        user={user}
        onLogout={handleLogout}
        onNavigate={(p) => setPage(p)}
        section={section}
        onSectionChange={changeSection}
        hideSections={page === 'admin-settings'}
      />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {page !== 'admin-settings' && (
          <Sidebar
            activePage={page}
            onPageChange={setPage}
            collapsed={sidebarCollapsed}
            setCollapsed={setSidebarCollapsed}
            user={user}
            section={section}
          />
        )}
        <div style={{ flex: 1, overflow: 'auto', background: C.pageBg, display: 'flex', flexDirection: 'column' }}>
          {renderPage()}
        </div>
      </div>
      <FeedbackModal />
    </div>
  );
}
