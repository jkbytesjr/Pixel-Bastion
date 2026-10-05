/**
 * How co-op peers talk. The host opens a room under a short code; guests join
 * it. Two implementations: WebRTC through PeerJS (real play: the free public
 * PeerJS service only introduces the players, then data flows directly
 * between browsers) and a BroadcastChannel one between tabs of the same
 * browser, used by the automated test (`?net=local`).
 */

export interface Transport {
  /** Host side: a guest connected / left. */
  onPeerJoin: (peer: string) => void;
  onPeerLeave: (peer: string) => void;
  /** Guest side: the host went away. */
  onClose: () => void;
  onMessage: (peer: string, msg: unknown) => void;
  send(peer: string, msg: unknown): void;
  /** Host: message every guest. Guest: message the host. */
  broadcast(msg: unknown): void;
  close(): void;
}

const PEER_PREFIX = 'pixel-bastion-';

/**
 * How browsers find a way to each other. STUN servers let two computers
 * discover their public addresses and connect directly. When a network
 * blocks that (strict routers, school or work networks, mobile hotspots), a
 * TURN server relays the traffic instead: set one at build time with
 * VITE_TURN_URLS (comma-separated), VITE_TURN_USERNAME and VITE_TURN_CREDENTIAL.
 */
export function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  const urls = (import.meta.env.VITE_TURN_URLS ?? '').split(',').map((u: string) => u.trim()).filter(Boolean);
  if (urls.length) servers.push({ urls, username: import.meta.env.VITE_TURN_USERNAME ?? '', credential: import.meta.env.VITE_TURN_CREDENTIAL ?? '' });
  return servers;
}

/** True when a relay (TURN) server is configured. */
export const hasRelay = () => iceServers().length > 1;

const NO_DIRECT_LINK =
  "Found the host's game, but your two computers couldn't connect. Some networks (school or work Wi-Fi, mobile hotspots, some routers) block direct connections. Try both being on the same home Wi-Fi, or the host trying a different network.";

/** Which transport this page uses (`?net=local` for tests). */
export function useLocalTransport(): boolean {
  return new URLSearchParams(window.location.search).get('net') === 'local';
}

export async function hostRoom(code: string): Promise<Transport> {
  return useLocalTransport() ? localTransport(code, true) : peerTransport(code, true);
}

export async function joinRoom(code: string): Promise<Transport> {
  return useLocalTransport() ? localTransport(code, false) : peerTransport(code, false);
}

const noop = () => {};

function baseTransport(): Transport {
  return { onPeerJoin: noop, onPeerLeave: noop, onClose: noop, onMessage: noop, send: noop, broadcast: noop, close: noop };
}

/** Friendlier errors for the things that actually go wrong. */
function explain(err: unknown, hosting: boolean): Error {
  const type = (err as { type?: string })?.type ?? '';
  if (type === 'peer-unavailable') return new Error('No game with that code. Check the code and that the host is still in the lobby.');
  if (type === 'unavailable-id') return new Error('That room code is taken. Try hosting again.');
  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed')
    return new Error('Could not reach the matchmaking service. Check your internet connection.');
  if (type === 'browser-incompatible') return new Error('This browser does not support online play (WebRTC).');
  return new Error(hosting ? 'Could not open a room.' : 'Could not join that room.');
}

async function peerTransport(code: string, host: boolean): Promise<Transport> {
  // Loaded on demand, so solo players never download it.
  const { Peer } = await import('peerjs');
  const t = baseTransport();
  const conns = new Map<string, import('peerjs').DataConnection>();
  // Guests pick their own random id too: asking the PeerJS service for one is a cross-site
  // request some origins (like GitHub Pages) get blocked on.
  const guestId = `${PEER_PREFIX}g-${code}-${Math.random().toString(36).slice(2, 10)}`;
  const peer = new Peer(host ? PEER_PREFIX + code : guestId, { debug: 0, config: { iceServers: iceServers() } });
  await new Promise<void>((resolve, reject) => {
    peer.once('open', () => resolve());
    peer.once('error', (e) => reject(explain(e, host)));
  });

  const wire = (conn: import('peerjs').DataConnection) => {
    conn.on('data', (data) => t.onMessage(conn.peer, data));
    conn.on('close', () => {
      conns.delete(conn.peer);
      if (host) t.onPeerLeave(conn.peer);
      else t.onClose();
    });
    conn.on('error', () => conn.close());
  };

  if (host) {
    peer.on('connection', (conn) => {
      conn.on('open', () => {
        conns.set(conn.peer, conn);
        wire(conn);
        t.onPeerJoin(conn.peer);
      });
    });
  } else {
    const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
    await new Promise<void>((resolve, reject) => {
      // The room was found (otherwise PeerJS reports peer-unavailable); this means no network path opened.
      const timer = setTimeout(() => reject(new Error(NO_DIRECT_LINK)), hasRelay() ? 25000 : 15000);
      conn.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      peer.once('error', (e) => {
        clearTimeout(timer);
        reject(explain(e, false));
      });
    });
    conns.set(conn.peer, conn);
    wire(conn);
  }
  // Losing the matchmaking connection doesn't end a game in progress; try to get it back for new joiners.
  peer.on('disconnected', () => {
    if (!peer.destroyed) peer.reconnect();
  });

  t.send = (to, msg) => {
    const c = conns.get(to);
    if (c?.open) c.send(msg);
  };
  t.broadcast = (msg) => {
    for (const c of conns.values()) if (c.open) c.send(msg);
  };
  t.close = () => {
    for (const c of conns.values()) c.close();
    peer.destroy();
  };
  return t;
}

/** Same-browser tabs over a BroadcastChannel (for tests). */
async function localTransport(code: string, host: boolean): Promise<Transport> {
  const t = baseTransport();
  const me = host ? 'host' : `guest-${Math.random().toString(36).slice(2, 8)}`;
  const channel = new BroadcastChannel(`pixel-bastion-${code}`);
  const peers = new Set<string>();
  type Packet = { from: string; to: string; kind: 'join' | 'accept' | 'msg' | 'bye'; msg?: unknown };
  const post = (p: Packet) => channel.postMessage(p);
  let accepted: () => void = noop;
  channel.onmessage = (e: MessageEvent<Packet>) => {
    const p = e.data;
    if (p.to !== me && p.to !== '*') return;
    if (host && p.kind === 'join') {
      peers.add(p.from);
      post({ from: me, to: p.from, kind: 'accept' });
      t.onPeerJoin(p.from);
    } else if (!host && p.kind === 'accept') accepted();
    else if (p.kind === 'msg') t.onMessage(p.from, p.msg);
    else if (p.kind === 'bye') {
      if (host && peers.delete(p.from)) t.onPeerLeave(p.from);
      if (!host && p.from === 'host') t.onClose();
    }
  };
  if (!host) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No game with that code.')), 3000);
      accepted = () => {
        clearTimeout(timer);
        resolve();
      };
      post({ from: me, to: 'host', kind: 'join' });
    });
  }
  t.send = (to, msg) => post({ from: me, to, kind: 'msg', msg });
  t.broadcast = (msg) => {
    if (host) for (const p of peers) post({ from: me, to: p, kind: 'msg', msg });
    else post({ from: me, to: 'host', kind: 'msg', msg });
  };
  t.close = () => {
    post({ from: me, to: '*', kind: 'bye' });
    channel.close();
  };
  return t;
}
