"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "ai-chat-hidden";
// Same-tab listeners: the native "storage" event only fires in *other* tabs,
// so the header and the chat widget would drift apart without this.
const EVENT = "ai-chat-visibility";

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Private mode / blocked site data: fall back to visible.
    return false;
  }
}

/**
 * Per-browser preference for the floating AI assistant button.
 *
 * Starts as `false` on both server and first client render so hydration
 * matches, then syncs from localStorage in an effect.
 */
export function useAiChatVisibility() {
  const [hidden, setHiddenState] = useState(false);

  useEffect(() => {
    const sync = () => setHiddenState(readHidden());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setHidden = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      // Preference simply does not persist; the toggle still works this session.
    }
    setHiddenState(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return { hidden, setHidden };
}
