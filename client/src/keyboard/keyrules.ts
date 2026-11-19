// Which keys may act while the user types, and which keys may start capture (secloop round 7, A-R7-1, A-R7-2).
// No imports: scripts/key-rules.test.mjs runs this file under plain node.

type Keys = { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; code: string; repeat?: boolean }

/** Focus is in a text field: keys there are typing. */
export const typingIn = (el: Element | null) =>
  !!el && ((el as HTMLElement).isContentEditable === true || !!el.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))

/** The only key that accepts an incoming call, shown in the dialog: never while typing, never in its first second. */
export const ACCEPT_KEYS = 'Ctrl+Alt+A'
export const acceptKey = (e: Keys, shownFor: number, typing: boolean) =>
  !typing && !e.repeat && shownFor >= 1000 && (e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.code === 'KeyA'

/** Actions that start capture or unmute (undeafen unmutes too): their key needs Ctrl, Alt or Cmd, or a key that types nothing. */
export const CAPTURE_ACTIONS = ['toggle-mute', 'toggle-deafen', 'toggle-camera', 'toggle-screen']
// keys that never type text (function keys, navigation, media keys)
const NON_PRINTING = /^(F([1-9]|1\d|2[0-4])|Pause|ScrollLock|PrintScreen|Insert|Home|End|PageUp|PageDown|ContextMenu|Help|Media\w+|AudioVolume\w+|Launch\w+|Browser\w+)$/
/** A stored combo ("Ctrl+Alt+Shift+<code>") holds Ctrl, Alt or Cmd (stored as Ctrl), or a key that types nothing. */
export const strongCombo = (combo: string) => {
  const parts = combo.split('+')
  const code = parts.at(-1) ?? ''
  return parts.slice(0, -1).some((m) => m === 'Ctrl' || m === 'Alt') || NON_PRINTING.test(code)
}
/** Whether `combo` may be bound to `action`: capture actions only to strong combos. */
export const bindable = (action: string, combo: string) => !combo || !CAPTURE_ACTIONS.includes(action) || strongCombo(combo)
/** Whether a key event may run a bound action now: while typing, only with Ctrl, Alt or Cmd, or a key that types
 *  nothing (Escape, function keys). */
export const firesWhileTyping = (e: Keys, typing: boolean) => !typing || e.ctrlKey || e.metaKey || e.altKey || e.code === 'Escape' || NON_PRINTING.test(e.code)
