// The Social section — ForgeGrowth's pages, running inside ForgeGrowth.
//
// ForgeGrowth owns the shell (top bar, sidebar, login, theme); this component
// owns everything after `#/social/` in the hash. The route grammar is
// ForgeGrowth's own, prefixed:
//
//   #/social                          Overview
//   #/social/<inbox|contacts|automations>
//   #/social/<library|media>          the Content Library hub's two tabs
//   #/social/settings[/<tab>]         Social settings
//   #/social/integrations[/<platform>] Settings → Integrations (connect accounts)
//
// Two routes are PUBLIC and are rendered by App before the login gate:
//   #/social-share/<token>  a shared, read-only report
//   #/social-privacy        the privacy policy (Meta App Review needs a public URL)
import { useState, useEffect } from 'react';
import './theme/social.css';
import { socialRoute } from './nav.js';
import { SOCIAL_TAB_TO_MAIN } from './SocialSettingsPart.jsx';
export { socialNavId } from './nav.js';
import Toast from './Toast.jsx';
import TokenHealthBanner from './components/TokenHealthBanner.jsx';
import HandoffPopup from './components/HandoffPopup.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import InboxPage from './pages/InboxPage.jsx';
import ContactsPage from './pages/ContactsPage.jsx';
import AutomationsPage from './pages/AutomationsPage.jsx';
import LibraryHub from './pages/LibraryHub.jsx';
import PrivacyPolicyPage from './pages/PrivacyPolicyPage.jsx';
import PublicReportPage from './pages/PublicReportPage.jsx';

export default function SocialSection({ subParts, navigate, user }) {
  const [period, setPeriod] = useState('30D');
  const route = socialRoute(subParts);

  // ForgeGrowth's pages navigate with (id, sub): ids are its own view names.
  const go = (id, sub = 'general') => {
    if (id === 'settings') return navigate('admin-settings', SOCIAL_TAB_TO_MAIN[sub] || 'general', 'social');
    if (id === 'integrations') return navigate('admin-settings', 'integrations', 'social');
    if (!id || id === 'overview') return navigate('social');
    return navigate('social', id);
  };

  // The ported pages read `user.role` as admin|member, like ForgeGrowth did.
  const socialUser = user ? { ...user, role: user.role === 'admin' ? 'admin' : 'member' } : user;

  // Social → Settings moved into the one Settings page (social/SocialSettingsPart.jsx).
  // Old links — bookmarks, OAuth returns, "connect in Integrations" banners —
  // land on the matching tab's Social half.
  useEffect(() => {
    if (route.view !== 'settings') return;
    const tab = SOCIAL_TAB_TO_MAIN[route.settingsTab] || 'general';
    const parts = ['admin-settings', tab, 'social'];
    if (tab === 'integrations' && route.platform) parts.push(route.platform);
    window.location.replace('#/' + parts.join('/'));
  }, [route.view, route.settingsTab, route.platform]);

  let page;
  if (route.view === 'settings') {
    page = null;   // redirecting to the one Settings (effect above)
  } else if (route.view === 'inbox') page = <InboxPage user={socialUser} />;
  else if (route.view === 'contacts') page = <ContactsPage user={socialUser} />;
  else if (route.view === 'library') page = <LibraryHub tab={route.libraryTab} onTab={go} user={socialUser} />;
  else if (route.view === 'automations') page = <AutomationsPage user={socialUser} />;
  else page = <OverviewPage period={period} setPeriod={setPeriod} />;

  return (
    <>
      <div className={'social-root' + (route.view === 'settings' ? ' social-root--settings' : '')}>
        {route.view !== 'settings' && <TokenHealthBanner />}
        {page}
      </div>
      <Toast />
      <HandoffPopup user={socialUser} />
    </>
  );
}

// The two public Social pages. Returns an element for a public Social route,
// or null — App renders it before the login gate, the way it does /f/<slug>.
export function socialPublicPage(routeParts = []) {
  if (routeParts[0] === 'social-privacy') {
    return <div className="social-root" style={{ minHeight: 'calc(100vh / var(--fg-zoom, 1))' }}><PrivacyPolicyPage standalone /></div>;
  }
  if (routeParts[0] === 'social-share' && routeParts[1] && /^[a-z0-9]+$/i.test(routeParts[1])) {
    return <div className="social-root" style={{ minHeight: 'calc(100vh / var(--fg-zoom, 1))' }}><PublicReportPage token={routeParts[1]} /></div>;
  }
  return null;
}
