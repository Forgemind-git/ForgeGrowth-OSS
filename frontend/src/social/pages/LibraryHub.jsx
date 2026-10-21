import ContentLibraryPage from "./ContentLibraryPage.jsx";
import MediaPage from "./MediaPage.jsx";
import { UnderlineTabs } from "../components/UI.jsx";

// Content Library = Posts + Media in one sidebar entry (2026-10-11; Publish
// removed 2026-10-21). The tab is the route (#/social/library, #/social/media);
// an old #/social/publish link lands on Posts.
const TABS = [
  { id: "library", label: "Posts" },
  { id: "media", label: "Media" },
];

export default function LibraryHub({ tab, onTab, user }) {
  return (
    <div>
      <UnderlineTabs value={tab} onChange={onTab} tabs={TABS} style={{ marginBottom: 18 }} />
      {tab === "media" ? <MediaPage /> : <ContentLibraryPage user={user} />}
    </div>
  );
}
