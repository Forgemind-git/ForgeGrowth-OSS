// Catches a render crash in one page instead of losing the whole app.
//
// WHY THIS EXISTS: React unmounts the ENTIRE tree when a render throws and
// nothing catches it, so a single bad line anywhere turned the browser window
// white — no message, no nav, nothing to click. That is exactly how a
// temporal-dead-zone reference in the Bulk Messages list view presented: "the
// tab blanks out".
//
// With this in place the sidebar and header survive, the user gets a sentence
// they can act on, and they can move to another page without reloading.
//
// ⚠ The user NEVER sees the stack trace — that goes to the console for us
// (Forge rule: no stack traces or HTTP codes in the UI). `resetKey` clears the
// error when the route changes, so navigating away actually recovers rather
// than leaving the message stuck on screen.

import { Component } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { C, FONT } from '../constants.js';

export default class PageErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept loud in the console so a real crash is still diagnosable — the point
    // of this boundary is to stop it destroying the UI, not to hide it.
    console.error('[page crash]', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    // Navigating away must clear the error, or the message follows the user to
    // a perfectly healthy page.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '70px 24px', textAlign: 'center', fontFamily: FONT, flex: 1,
      }}>
        <AlertTriangle size={38} color={C.textMuted} strokeWidth={1.5} style={{ opacity: 0.7 }} />
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginTop: 14 }}>
          This page ran into a problem
        </div>
        <div style={{ fontSize: 13, color: C.textSecondary, marginTop: 6, maxWidth: 420, lineHeight: 1.6 }}>
          Nothing was lost. You can try again, or pick another page from the menu on the left.
        </div>
        <button
          onClick={() => this.setState({ error: null })}
          style={{
            marginTop: 18, display: 'inline-flex', alignItems: 'center', gap: 7,
            padding: '9px 16px', borderRadius: 8, border: 'none', background: C.primary,
            color: '#fff', fontSize: 13, fontWeight: 600, fontFamily: FONT, cursor: 'pointer',
          }}>
          <RotateCw size={14} /> Try again
        </button>
      </div>
    );
  }
}
