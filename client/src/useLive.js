import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { websocketUrl } from './config.js';

/**
 * Subscribes to the server's change-stream feed.
 *
 * There is no polling anywhere in this app. The socket carries machine updates,
 * new alerts, and sales as MongoDB sees them, and the handler passed here runs
 * per event.
 *
 * The connection is authenticated: a browser cannot set headers on a WebSocket
 * handshake, so we fetch a short-lived single-use ticket over the authenticated
 * REST API and spend it on the upgrade. A ticket is worthless in a log by the
 * time anyone reads it, which the session token would not be.
 *
 * Returns `{ connected, degradedTopics }`. `degradedTopics` is non-empty when a
 * change stream on the server has dropped - the UI shows stale rather than
 * claiming to be live over frozen data.
 */
export function useLive(onEvent) {
  const [connected, setConnected] = useState(false);
  const [degradedTopics, setDegradedTopics] = useState([]);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let socket;
    let retry = 0;
    let reconnectTimer;
    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;

      let ticket;
      try {
        ({ ticket } = await api.wsTicket());
      } catch {
        // Not signed in, or the API is down. Back off and try again.
        if (cancelled) return;
        retry += 1;
        reconnectTimer = setTimeout(connect, Math.min(15000, 500 * 2 ** retry));
        return;
      }
      if (cancelled) return;

      // Built from the configured API origin, not window.location: on a split
      // deploy the bundle is served from a different host than the socket.
      socket = new WebSocket(websocketUrl(ticket));

      socket.onopen = () => {
        retry = 0;
        setConnected(true);
      };

      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'event') handlerRef.current?.(msg.topic, msg.payload);
        else if (msg.type === 'hello') setDegradedTopics(msg.degraded ?? []);
        else if (msg.type === 'health') {
          setDegradedTopics(msg.healthy ? msg.degraded ?? [] : [...new Set([...(msg.degraded ?? []), msg.topic])]);
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (cancelled) return;
        retry += 1;
        reconnectTimer = setTimeout(connect, Math.min(15000, 500 * 2 ** retry));
      };

      socket.onerror = () => socket.close();
    };

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      if (!socket) return;
      // Calling close() on a socket that is still CONNECTING aborts the
      // handshake and logs "closed before the connection is established".
      // React StrictMode mounts effects twice in development, so this fires on
      // every mount unless the close is deferred until the socket is open.
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.onopen = () => socket.close();
        socket.onclose = null;
        socket.onerror = null;
      } else {
        socket.close();
      }
    };
  }, []);

  return { connected, degradedTopics };
}
