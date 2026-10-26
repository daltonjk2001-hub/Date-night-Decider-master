/* Date Night Decider v3.4.3 Hotfix 1 · P2P / WebRTC Infrastructure */
'use strict';

import { getResetState } from './db.js';

let p1Deck = [], p2Deck = [], p1Likes = [], p2Likes = [];
let swipePlayer = 1, swipeIndex = 0, draftItems = [], draftTurn = 1;
let peer = null, conn = null, remoteRoomId = null, myPlayerNum = 1, currentRoomPeerId = null;
let remoteSubmitSent = false;
let guestRoundId = null;
let pendingCompleteEntry = null;
let remotePartnerLikes = null;
let remoteGuestProgressLikes = [];
let remoteGuestSwipeIndex = 0;
let remoteMatchResolved = false;
let p2HeartbeatTimer = null;
let connectionState = 'disconnected';
let isDragging = false, startX = 0, currentX = 0, startTime = 0;
let swipeCardEl = null;
let turnRelayUnavailable = true;
let turnFallbackNoticeShown = false;
let lastPongAt = 0;
let connectionRecoveryTimer = null;
let connectionRecoveryAttempts = 0;

const activeAsyncOperations = new Set();

export function trackAsyncOperation(promise) {
  activeAsyncOperations.add(promise);
  promise.finally(() => activeAsyncOperations.delete(promise));
  return promise;
}

export function handleIncomingP2PMessage(event) {
  if (getResetState()) {
    console.warn('Incoming P2P message rejected: Reset in progress.');
    return;
  }

  const opPromise = (async () => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'PEER_SESSION_TERMINATED') {
        await terminateP2PSession(false);
        return;
      }
    } catch (err) {
      console.error('P2P message parsing error:', err);
    }
  })();

  trackAsyncOperation(opPromise);
}

/**
 * Quiesces network interfaces, halts timers, awaits all active async operations, and tears down WebSockets/WebRTC.
 */
export async function terminateP2PSession(notifyPeer = true, drainTimeoutMs = 1500) {
  if (p2HeartbeatTimer) {
    window.clearInterval(p2HeartbeatTimer);
    p2HeartbeatTimer = null;
  }

  if (notifyPeer && conn && conn.open) {
    try {
      conn.send(JSON.stringify({ type: 'PEER_SESSION_TERMINATED' }));
    } catch (err) {
      console.warn('Failed to transmit PEER_SESSION_TERMINATED notification:', err);
    }
  }

  const drainStart = Date.now();
  while (activeAsyncOperations.size > 0 && (Date.now() - drainStart) < drainTimeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  if (activeAsyncOperations.size > 0) {
    console.error('Drain timeout reached with pending async operations.');
    return false;
  }

  let success = true;
  try {
    if (conn) {
      conn.close();
    }
  } catch (err) {
    success = false;
  }
  conn = null;

  try {
    if (peer) {
      peer.destroy();
    }
  } catch (err) {
    success = false;
  }
  peer = null;

  return success;
}

const PEER_SIGNALING_CONFIG = {
  host: '',
  port: 443,
  path: '/peerjs',
  secure: true,
  key: 'peerjs'
};

async function fetchEphemeralIceServers() {
  try {
    const endpoint = new URL('./api/get-ice-servers', window.location.href).toString();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInSeconds: 300 })
    });
    if (!response.ok) throw new Error(`ICE fetch returned status ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.iceServers) || !data.iceServers.some(server => server && server.urls)) {
      throw new Error('ICE endpoint response did not include valid iceServers array.');
    }
    turnRelayUnavailable = !data.iceServers.some(server => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some(url => typeof url === 'string' && /^turns?:/i.test(url));
    });
    if (turnRelayUnavailable && !turnFallbackNoticeShown) {
      turnFallbackNoticeShown = true;
      showToast('TURN relay is not configured. Live sync is best-effort and may fail on some mobile or restrictive networks.', 6500);
    }
    return data.iceServers;
  } catch (error) {
    turnRelayUnavailable = true;
    if (!turnFallbackNoticeShown) {
      turnFallbackNoticeShown = true;
      showToast('TURN relay endpoint unavailable; falling back to public STUN.', 6500);
    }
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
  }
}

let PEER_OPTIONS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
  }
};
