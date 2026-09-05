import { useEffect, useRef, useState } from "react";

/**
 * Live connection to the demo server's SSE stream.
 *
 * Falls back to mock-data mode when the server is unreachable, so the
 * VitePress page still renders a full demo without a running backend.
 */

/**
 * API base for the demo server's SSE stream.
 *
 * - Local dev (vitepress dev): default to the demo server on :3101.
 * - Production build: same-origin relative path — a reverse proxy fronts
 *   both the static docs and the demo server, so no CORS and no mixed content.
 * - Override either with VITE_DEMO_API_BASE (e.g. http://localhost:3101).
 */
const API_BASE =
  import.meta.env?.VITE_DEMO_API_BASE ?? (import.meta.env?.DEV ? "http://localhost:3101" : "");
const EVENT_BUFFER_LIMIT = 6;

export function useDemoStream() {
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [events, setEvents] = useState([]);
  const sourceRef = useRef(null);

  useEffect(() => {
    const source = new EventSource(`${API_BASE}/api/stream`);
    sourceRef.current = source;

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false); // EventSource retries on its own
    source.addEventListener("snapshot", (event) => {
      setConnected(true);
      setSnapshot(JSON.parse(event.data));
    });
    source.addEventListener("event", (event) => {
      const message = JSON.parse(event.data);
      setEvents((previous) => [message, ...previous].slice(0, EVENT_BUFFER_LIMIT));
    });

    return () => {
      source.close();
      setConnected(false);
    };
  }, []);

  function generateBurst(count) {
    return fetch(`${API_BASE}/api/burst`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count }),
    })
      .then((response) => response.ok)
      .catch(() => false);
  }

  return { connected, snapshot, events, generateBurst, apiBase: API_BASE };
}

/** "2s ago" style relative time from an ISO timestamp. */
export function relativeTime(iso) {
  const deltaMs = Date.now() - new Date(iso).getTime();
  if (deltaMs < 1_500) return "now";
  if (deltaMs < 60_000) return `${(deltaMs / 1000).toFixed(1)}s ago`;
  return `${Math.round(deltaMs / 60_000)}m ago`;
}