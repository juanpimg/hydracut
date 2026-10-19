import { useEffect, useState } from 'react';

/**
 * Tiny app-wide announcer used to feed the single polite live region that
 * lives in `MainLayout`.
 *
 * Audit UI-16: the app had **zero** `aria-live` regions, so nothing that
 * happens in the background (a track added, the aspect ratio changed, a clip
 * deleted…) was ever announced to screen-reader users.
 *
 * The export progress lives inside `ExportModal`, which is owned by another
 * worker: it can call `announce(...)` to push its progress into this region.
 */

type Listener = (message: string) => void;

const listeners = new Set<Listener>();
let lastMessage = '';

export interface LiveAnnouncement {
  /** The text exposed to assistive technology. */
  text: string;
  /** Monotonic id, used to force a re-announcement of a repeated message. */
  id: number;
}

let current: LiveAnnouncement = { text: '', id: 0 };

/**
 * Publishes a message to every live region of the app.
 * Empty messages are ignored.
 */
export function announce(message: string): void {
  if (!message || !message.trim()) return;
  // Screen readers do not re-announce an identical string: a zero width space
  // is appended (and removed on the next call) to force the announcement.
  const isRepeat = message === lastMessage;
  lastMessage = message;
  const text = isRepeat ? `${message}\u200B` : message;
  current = { text, id: current.id + 1 };
  listeners.forEach((listener) => listener(text));
}

/** The last message published through {@link announce}. */
export function getLastAnnouncement(): string {
  return lastMessage;
}

/** Subscribes to the announcements. Returns the unsubscribe function. */
export function subscribeLiveAnnouncements(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding: re-renders the caller whenever a new message is published. */
export function useLiveAnnouncement(): LiveAnnouncement {
  const [announcement, setAnnouncement] = useState<LiveAnnouncement>(current);

  useEffect(() => {
    setAnnouncement(current);
    return subscribeLiveAnnouncements((text) => setAnnouncement({ text, id: current.id }));
  }, []);

  return announcement;
}
