// ============================================================
// postTypes.js — Single source of truth for the Composer wizard's
// step 3 (post types per platform) and step 4 (per-type detail fields).
//
// NOTE: The post-type ids here MUST stay in sync with the backend PUBLISH_RULES
// in backend/src/publishService.js — they are the contract between the two.
// ============================================================
import { Image, Film, Circle, Sparkles, Play, Zap, MessageCircle, FileText, PenLine, Images, Newspaper, File, BarChart3 } from "lucide-react";

// ── FIELD registry: fieldId -> control descriptor ──────────────
// control: 'media' | 'text' | 'textarea' | 'tags' | 'select' | 'toggle' | 'url'
export const FIELDS = {
  // media
  media:      { label: "Media",       control: "media",    multi: false, accept: "image/*,video/*", required: true,
                help: "Pick from your Media library or upload new." },
  mediaMulti: { label: "Media",       control: "media",    multi: true,  accept: "image/*,video/*", required: true, max: 10 },
  video:      { label: "Video",       control: "media",    multi: false, accept: "video/*",         required: true, videoOnly: true },
  image:      { label: "Image",       control: "media",    multi: false, accept: "image/*",         required: true, imageOnly: true },
  thumbnail:  { label: "Thumbnail",   control: "media",    multi: false, accept: "image/*",         required: false, imageOnly: true,
                help: "Optional custom cover image." },

  // text
  caption:    { label: "Caption",     control: "textarea", placeholder: "Write a caption…", maxLength: 2200 },
  text:       { label: "Text",        control: "textarea", placeholder: "What's on your mind?", required: true, maxLength: 500 },
  title:      { label: "Title",       control: "text",     placeholder: "Title", required: true, maxLength: 100 },
  description:{ label: "Description", control: "textarea", placeholder: "Description…", maxLength: 5000 },
  articleBody:{ label: "Article body",control: "textarea", placeholder: "Write your article…", required: true, rows: 8 },

  // tags / people / location / audio
  tagPeople:  { label: "Tag people",  control: "tags",     placeholder: "@username — press Enter",
                help: "Single-image posts only. Tags are centered (Instagram's API can't set exact positions)." },
  collaborators:{ label: "Collaborators", control: "tags", placeholder: "@username — press Enter", max: 3,
                help: "Invite up to 3 co-authors (they must accept). Use valid public usernames." },
  altText:    { label: "Alt text",    control: "textarea", placeholder: "Describe the image for accessibility", maxLength: 1000,
                help: "Single-image posts only." },
  hashtags:   { label: "Hashtags",    control: "tags",     placeholder: "#tag — press Enter" },
  location:   { label: "Location",    control: "text",     placeholder: "Add location" },
  audio:      { label: "Audio",       control: "text",     placeholder: "Audio / music name (optional)",
                help: "Names the reel's audio track. Instagram's API can't attach licensed music." },

  // selects
  shareToFeed:{ label: "Also show in Feed", control: "select", default: "yes",
                options: [{ value: "yes", label: "Yes — Feed & Reels" }, { value: "no", label: "Reels tab only" }] },
  commenting: { label: "Commenting",  control: "select",   default: "on",
                options: [{ value: "on", label: "On" }, { value: "off", label: "Turn off comments" }] },
  visibility: { label: "Visibility",  control: "select",   required: true, default: "public",
                options: [{ value: "public", label: "Public" }, { value: "unlisted", label: "Unlisted" }, { value: "private", label: "Private" }] },
  liVisibility:{ label: "Audience",   control: "select",   default: "anyone",
                options: [{ value: "anyone", label: "Anyone" }, { value: "connections", label: "Connections only" }] },

  // link / poll / document
  link:        { label: "Link",          control: "url",  placeholder: "https://…" },
  pollQuestion:{ label: "Poll question", control: "text", placeholder: "Ask a question", required: true, maxLength: 140 },
  pollOptions: { label: "Options",       control: "tags", placeholder: "Add an option — press Enter", required: true, minItems: 2 },
  document:    { label: "Document",      control: "media", multi: false, accept: "image/*,video/*", required: true,
                help: "Document upload uses the media library." },
};

// ── POST_TYPES: platform -> [{ id, label, icon, fields:[fieldId...] }] ──
export const POST_TYPES = {
  instagram: [
    { id: "post",      label: "Post",      icon: Image,    fields: ["mediaMulti", "caption", "altText", "tagPeople", "collaborators", "commenting", "hashtags"] },
    { id: "reel",      label: "Reel",      icon: Film,     fields: ["video", "thumbnail", "caption", "audio", "collaborators", "shareToFeed", "commenting", "hashtags"] },
    { id: "story",     label: "Story",     icon: Circle,   fields: ["media"] },
    { id: "highlight", label: "Highlight", icon: Sparkles, fields: ["mediaMulti", "title", "caption"] },
  ],
  youtube: [
    { id: "video",     label: "Video",          icon: Play,          fields: ["video", "title", "description", "thumbnail", "visibility", "hashtags"] },
    { id: "short",     label: "Short",          icon: Zap,           fields: ["video", "title", "description", "visibility", "hashtags"] },
    { id: "community", label: "Community Post",  icon: MessageCircle, fields: ["text", "image", "visibility"] },
  ],
  facebook: [
    { id: "post",      label: "Post",      icon: FileText, fields: ["text", "mediaMulti", "link", "location"] },
    { id: "reel",      label: "Reel",      icon: Film,     fields: ["video", "text", "audio", "location"] },
    { id: "story",     label: "Story",     icon: Circle,   fields: ["media", "text"] },
  ],
  threads: [
    { id: "text",      label: "Text",      icon: PenLine,  fields: ["text", "link", "tagPeople"] },
    { id: "image",     label: "Image",     icon: Image,    fields: ["image", "text", "tagPeople"] },
    { id: "carousel",  label: "Carousel",  icon: Images,   fields: ["mediaMulti", "text", "tagPeople"] },
  ],
  linkedin: [
    { id: "post",      label: "Post",      icon: FileText,  fields: ["text", "mediaMulti", "link", "liVisibility"] },
    { id: "article",   label: "Article",   icon: Newspaper, fields: ["title", "articleBody", "thumbnail", "liVisibility"] },
    { id: "document",  label: "Document",  icon: File,      fields: ["document", "title", "text", "liVisibility"] },
    { id: "poll",      label: "Poll",      icon: BarChart3, fields: ["pollQuestion", "pollOptions", "text", "liVisibility"] },
  ],
};

// helpers
export const postTypesFor = (platform) => POST_TYPES[platform] || [];
export const postTypeDef  = (platform, typeId) => postTypesFor(platform).find(t => t.id === typeId) || null;
export const fieldDef     = (fieldId) => FIELDS[fieldId];
