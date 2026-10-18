import ContentLibraryPage from "./ContentLibraryPage.jsx";
import PublishPage from "./PublishPage.jsx";
import MediaPage from "./MediaPage.jsx";
import { UnderlineTabs } from "../components/UI.jsx";

// Content Library = Posts + Publish + Media in one sidebar entry (2026-10-11).
// The tab is the route (#/social/library, #/social/publish, #/social/media), so old links keep working.
const TABS = [
  { id: "library", label: "Posts" },
  { id: "publish", label: "Publish" },
  { id: "media", label: "Media" },
];

export default function LibraryHub({ tab, onTab, user }) {
  return (
    <div>
      <UnderlineTabs value={tab} onChange={onTab} tabs={TABS} style={{ marginBottom: 18 }} />
      {tab === "publish" ? <PublishPage user={user} />
        : tab === "media" ? <MediaPage />
        : <ContentLibraryPage user={user} onPublished={() => onTab("publish")} />}
    </div>
  );
}
