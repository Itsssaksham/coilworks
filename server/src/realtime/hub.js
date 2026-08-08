import { WebSocketServer } from 'ws';
import { Machine } from '../models/Machine.js';
import { Alert } from '../models/Alert.js';
import { Sale } from '../models/Sale.js';
import { redeemTicket } from './tickets.js';
import { log } from '../logger.js';

/**
 * Live fan-out from MongoDB change streams to browser WebSocket clients.
 *
 * The dashboard does not poll. MongoDB tails its own oplog via change streams
 * and pushes here; this module fans those events out to subscribers. A telemetry
 * write from a machine reaches every open dashboard in one hop, with no interval
 * timer anywhere in the system.
 *
 * Change streams require a replica set - see db.js, which fails at boot if the
 * connection is to a standalone mongod.
 *
 * Two things make this safe to expose:
 *  - every connection is authenticated (see tickets.js); the feed carries
 *    machine locations, cash levels, and stock, so it is not public data
 *  - every stream is resumable; a dropped stream reconnects from where it left
 *    off rather than dying silently and leaving the dashboard stale
 */

const TOPICS = ['machines', 'alerts', 'sales'];

/** Backoff for change-stream reconnects, in ms. */
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;

export class RealtimeHub {
  constructor() {
    /** @type {Set<import('ws').WebSocket>} */
    this.clients = new Set();
    /** @type {Map<string, {stream: object, resumeToken: object|null, retries: number, timer: any}>} */
    this.watchers = new Map();
    this.closed = false;
  }

  attach(server) {
    // noServer + a manual upgrade handler, so an unauthenticated socket is
    // rejected before the WebSocket handshake completes rather than being
    // accepted and then closed.
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      if (this.closed) return socket.destroy();

      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== '/ws') return socket.destroy();

      const operator = redeemTicket(url.searchParams.get('ticket'));
      if (!operator) {
        log.warn('realtime: rejected unauthenticated upgrade', { ip: req.socket.remoteAddress });
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        ws.operator = operator;
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (socket) => {
      socket.subscriptions = new Set(TOPICS);
      socket.isAlive = true;
      this.clients.add(socket);

      socket.send(
        JSON.stringify({
          type: 'hello',
          topics: TOPICS,
          operator: socket.operator.email,
          degraded: this.degradedTopics(),
          at: new Date(),
        }),
      );

      socket.on('pong', () => { socket.isAlive = true; });

      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'subscribe' && Array.isArray(msg.topics)) {
            socket.subscriptions = new Set(msg.topics.filter((t) => TOPICS.includes(t)));
          }
        } catch {
          // A client sending malformed frames is not worth dropping the socket.
        }
      });

      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
    });

    // Drop sockets that stopped answering pings. Without this, half-open
    // connections accumulate behind proxies and laptops that went to sleep.
    this.heartbeat = setInterval(() => {
      for (const socket of this.clients) {
        if (!socket.isAlive) {
          socket.terminate();
          this.clients.delete(socket);
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }, 30_000);
    this.heartbeat.unref();

    this.#watch('machines', Machine, [], { fullDocument: 'updateLookup' }, (change) => {
      const doc = change.fullDocument;
      if (!doc) return null;
      return {
        op: change.operationType,
        machine: {
          _id: doc._id, code: doc.code, name: doc.name, siteName: doc.siteName,
          status: doc.status, lastSeenAt: doc.lastSeenAt, temperatureC: doc.temperatureC,
          cashCents: doc.cashCents, doorOpen: doc.doorOpen, signalStrength: doc.signalStrength,
          location: doc.location, slots: doc.slots,
        },
      };
    });

    this.#watch('alerts', Alert, [], { fullDocument: 'updateLookup' }, (change) => {
      const doc = change.fullDocument;
      if (!doc) return null;
      return { op: change.operationType, alert: doc };
    });

    // Sales are insert-only; filtering in the pipeline keeps the oplog cursor
    // from waking this process for anything else.
    this.#watch('sales', Sale, [{ $match: { operationType: 'insert' } }], {}, (change) => ({
      op: 'insert',
      sale: change.fullDocument,
    }));

    return this;
  }

  /**
   * Open a resumable change stream for one topic.
   *
   * The resume token is the whole point. Without it, a transient error - a
   * primary election, a network blip, the cursor being killed - would end the
   * stream permanently, and the dashboard would keep rendering stale data with
   * a green "live" indicator. That is worse than an outage, because it lies.
   *
   * On reconnect we pass `startAfter`, which resumes from the event *after* the
   * last one delivered, so nothing is replayed and nothing is skipped.
   */
  #watch(topic, Model, pipeline, options, project) {
    if (this.closed) return;

    const existing = this.watchers.get(topic);
    const resumeToken = existing?.resumeToken ?? null;

    const streamOptions = { ...options };
    if (resumeToken) streamOptions.startAfter = resumeToken;

    let stream;
    try {
      stream = Model.watch(pipeline, streamOptions);
    } catch (err) {
      return this.#scheduleRetry(topic, Model, pipeline, options, project, err);
    }

    this.watchers.set(topic, { stream, resumeToken, retries: existing?.retries ?? 0, timer: null });

    stream.on('change', (change) => {
      const entry = this.watchers.get(topic);
      if (entry) {
        entry.resumeToken = change._id; // advance the checkpoint
        if (entry.retries !== 0) {
          entry.retries = 0;
          this.#announceHealth(topic, true);
        }
      }
      const payload = project(change);
      if (payload) this.broadcast(topic, payload);
    });

    stream.on('error', (err) => {
      // A resume token can be invalidated if the oplog rolled past it. Retrying
      // with it would fail forever, so drop it and restart from now, accepting
      // the gap rather than staying dark.
      const invalidToken = err?.codeName === 'ChangeStreamHistoryLost' || err?.code === 286;
      if (invalidToken) {
        log.warn('realtime: resume token expired, restarting stream from now', { topic });
        const entry = this.watchers.get(topic);
        if (entry) entry.resumeToken = null;
      }
      this.#scheduleRetry(topic, Model, pipeline, options, project, err);
    });

    stream.on('close', () => {
      if (this.closed) return;
      this.#scheduleRetry(topic, Model, pipeline, options, project, new Error('stream closed'));
    });
  }

  #scheduleRetry(topic, Model, pipeline, options, project, err) {
    if (this.closed) return;

    const entry = this.watchers.get(topic) ?? { resumeToken: null, retries: 0 };
    entry.retries += 1;

    // Tell clients the moment a topic goes dark, so the UI can show "stale"
    // instead of a green light over frozen data.
    if (entry.retries === 1) this.#announceHealth(topic, false);

    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (entry.retries - 1));
    log.error('realtime: change stream failed, retrying', {
      topic,
      attempt: entry.retries,
      retryInMs: delay,
      error: err?.message,
    });

    entry.timer = setTimeout(() => this.#watch(topic, Model, pipeline, options, project), delay);
    entry.timer.unref?.();
    this.watchers.set(topic, entry);
  }

  #announceHealth(topic, healthy) {
    const frame = JSON.stringify({
      type: 'health',
      topic,
      healthy,
      degraded: healthy ? this.degradedTopics().filter((t) => t !== topic) : this.degradedTopics(),
      at: new Date(),
    });
    for (const socket of this.clients) {
      if (socket.readyState === socket.OPEN) socket.send(frame);
    }
  }

  /** Topics whose change stream is currently down. */
  degradedTopics() {
    return [...this.watchers.entries()].filter(([, e]) => e.retries > 0).map(([topic]) => topic);
  }

  broadcast(topic, payload) {
    const frame = JSON.stringify({ type: 'event', topic, payload, at: new Date() });
    for (const socket of this.clients) {
      if (socket.readyState !== socket.OPEN) continue;
      if (!socket.subscriptions.has(topic)) continue;
      socket.send(frame);
    }
  }

  get clientCount() {
    return this.clients.size;
  }

  get healthy() {
    return this.degradedTopics().length === 0;
  }

  async close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const entry of this.watchers.values()) {
      clearTimeout(entry.timer);
      await entry.stream?.close?.().catch?.(() => {});
    }
    this.watchers.clear();
    for (const socket of this.clients) socket.terminate();
    this.wss?.close();
  }
}

export const hub = new RealtimeHub();
