/* Date Night Decider v3.4.3 Hotfix 8 · P2P / WebRTC Infrastructure */
'use strict';

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

const HOST_ROOM_SESSION_KEY = 'dnd_host_room_session_v1';

const GUEST_ROOM_SESSION_KEY = 'dnd_guest_room_session_v1';

function clearGuestRoomSession() {
  try {
    window.sessionStorage.removeItem(GUEST_ROOM_SESSION_KEY);
  } catch (_) {}
}

function readGuestRoomSession() {
  try {
    const saved = JSON.parse(
      window.sessionStorage.getItem(GUEST_ROOM_SESSION_KEY) || 'null'
    );
    if (!saved || saved.version !== 1 ||
        typeof saved.roomCode !== 'string') return null;

    const roomCode = normalizeRoomCode(saved.roomCode);
    return roomCode.length >= 12 ? { version: 1, roomCode } : null;
  } catch (_) {
    return null;
  }
}

function saveGuestRoomSession(rawRoomCode) {
  const roomCode = normalizeRoomCode(rawRoomCode || remoteRoomId || '');
  if (roomCode.length < 12) return;

  try {
    window.sessionStorage.setItem(
      GUEST_ROOM_SESSION_KEY,
      JSON.stringify({ version: 1, roomCode, savedAt: Date.now() })
    );
  } catch (error) {
    console.warn('Could not preserve the guest room for refresh recovery:', error);
  }
}


function clearHostRoomSession() {
  try { window.sessionStorage.removeItem(HOST_ROOM_SESSION_KEY); } catch (_) {}
}

function readHostRoomSession() {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(HOST_ROOM_SESSION_KEY) || 'null');
    if (!saved || saved.version !== 1 || typeof saved.roomCode !== 'string' ||
        normalizeRoomCode(saved.roomCode).length < 12 || !Array.isArray(saved.deck)) {
      return null;
    }
    return saved;
  } catch (_) {
    return null;
  }
}

function saveHostRoomSessionState() {
  if (myPlayerNum !== 1 || !remoteRoomId) return;

  try {
    const budgetEl = document.getElementById('budgetFilter');
    const noMatchesEl = document.getElementById('noMatchesActions');
    const saved = {
      version: 1,
      roomCode: remoteRoomId,
      savedAt: Date.now(),
      deck: p1Deck,
      hostLikedIds: p1Likes.map(card => card.id),
      guestLikedIds: remoteGuestProgressLikes.map(card => card.id),
      guestSwipeIndex: remoteGuestSwipeIndex,
      partnerLikedIds: Array.isArray(remotePartnerLikes)
        ? remotePartnerLikes.map(card => card.id) : null,
      swipeIndex,
      draftItems,
      draftTurn,
      matchResolved: Boolean(remoteMatchResolved),
      winner: window.currentWinner ? sanitizeCard(window.currentWinner) : null,
      categories: [...document.querySelectorAll('.category-choice:checked')].map(el => el.value),
      packs: [...selectedPacks],
      budget: budgetEl ? budgetEl.value : 'all',
      noMatchesVisible: Boolean(noMatchesEl && !noMatchesEl.hidden)
    };
    window.sessionStorage.setItem(HOST_ROOM_SESSION_KEY, JSON.stringify(saved));
  } catch (error) {
    console.warn('Could not preserve the host room for refresh recovery:', error);
  }
}

function restoreHostRoomSessionState(saved) {
  if (!saved || normalizeRoomCode(saved.roomCode) !== remoteRoomId) return false;

  const deck = sanitizeCardDeck(saved.deck);
  if (!deck.length) return false;

  p1Deck = deck;
  p2Deck = [...deck];

  const hostIds = new Set(Array.isArray(saved.hostLikedIds) ? saved.hostLikedIds : []);
  const guestIds = new Set(Array.isArray(saved.guestLikedIds) ? saved.guestLikedIds : []);
  p1Likes = deck.filter(card => hostIds.has(card.id));
  p2Likes = deck.filter(card => guestIds.has(card.id));
  remoteGuestProgressLikes = [...p2Likes];

  const clampIndex = value =>
    Number.isInteger(value) ? Math.max(0, Math.min(value, deck.length)) : 0;

  swipeIndex = clampIndex(saved.swipeIndex);
  swipePlayer = 1;
  remoteGuestSwipeIndex = clampIndex(saved.guestSwipeIndex);
  remoteSubmitSent = false;

  remotePartnerLikes = Array.isArray(saved.partnerLikedIds)
    ? deck.filter(card => new Set(saved.partnerLikedIds).has(card.id))
    : null;

  remoteMatchResolved = Boolean(saved.matchResolved);
  draftItems = Array.isArray(saved.draftItems)
    ? saved.draftItems.map(raw => {
        const card = sanitizeCard(raw);
        return card ? { ...card, banned: Boolean(raw && raw.banned) } : null;
      }).filter(Boolean)
    : [];
  draftTurn = saved.draftTurn === 2 ? 2 : 1;
  window.currentWinner = saved.winner ? sanitizeCard(saved.winner) : null;

  if (Array.isArray(saved.categories)) {
    selectedCategories = saved.categories.filter(value => DEFAULT_CATEGORIES.includes(value));
    document.querySelectorAll('.category-choice').forEach(el => {
      el.checked = selectedCategories.includes(el.value);
    });
  }

  if (Array.isArray(saved.packs)) {
    selectedPacks = [...new Set(saved.packs.filter(id =>
      id === 'starter' ||
      (window.expansionDecks && Object.prototype.hasOwnProperty.call(window.expansionDecks, id))
    ))];
  }

  const budgetEl = document.getElementById('budgetFilter');
  if (budgetEl && ['all', 'free', 'paid'].includes(saved.budget)) {
    budgetEl.value = saved.budget;
  }

  refreshDecks();
  renderPackChoices();
  updateSwipeCard();

  if (window.currentWinner) {
    showModal('Live Room Resumed', window.currentWinner.title, window.currentWinner.detail);
  } else if (saved.noMatchesVisible) {
    showNoMutualMatches();
  } else if (draftItems.length) {
    renderDraftGrid();
    const modal = document.getElementById('votingModal');
    if (modal) modal.classList.add('show');
  }

  saveHostRoomSessionState();
  return true;
}

/* Self-hosted or default PeerJS broker configuration */
const PEER_SIGNALING_CONFIG = {
  host: '',
  port: 443,
  path: '/peerjs',
  secure: true,
  key: 'peerjs'
};

/* Obtain short-lived HMAC relay credentials from backend endpoint */
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
    console.warn('TURN relay config unavailable; falling back to STUN:', error);
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

function buildPeerOptions() {
  const options = { ...PEER_OPTIONS, config: { ...PEER_OPTIONS.config } };
  if (PEER_SIGNALING_CONFIG.host) {
    options.host = PEER_SIGNALING_CONFIG.host;
    options.port = PEER_SIGNALING_CONFIG.port;
    options.path = PEER_SIGNALING_CONFIG.path;
    options.secure = PEER_SIGNALING_CONFIG.secure;
    options.key = PEER_SIGNALING_CONFIG.key;
  }
  return options;
}

function normalizeRoomCode(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
}

function generateRoomCode() {
  try {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return createUniqueId().replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 32);
  }
}

function roomPeerId(code) {
  return `datenight-${code}`;
}

async function copyInviteLink() {
  if (!remoteRoomId || myPlayerNum !== 1 || !peer || !peer.open) {
    showToast('Start a live room and wait until ready before copying invite link.');
    if (!remoteRoomId) openLiveRoomModal('host');
    return;
  }

  const invite = new URL('./index.html', window.location.href);
  invite.search = '';
  invite.hash = '';
  invite.searchParams.set('room', remoteRoomId);
  const link = invite.href;

  const res = await window.DeviceAdapter.shareText('Date Night Decider Invitation', 'Join my Date Night Decider live room:', link);
  if (res.success) {
    if (res.method === 'clipboard') showToast('Invite link copied to clipboard!');
    else showToast('Invite link shared!');
    return;
  }

  window.prompt('Copy this invite link:', link);
}

async function startP2PServer(presetCode = null, recoverySnapshot = null, recoveryAttempt = 0) {
  if (!presetCode) {
    openLiveRoomModal('host');
    return;
  }
  const raw = presetCode;
  if (!raw) return;
  const code = normalizeRoomCode(raw);
  if (code.length < 12) {
    showToast('Use a room code at least 12 characters long.');
    return;
  }

  if (typeof window.Peer !== 'function') {
    showToast('PeerJS did not load. Check your connection and reload.');
    return;
  }

  const dynamicIceServers = await fetchEphemeralIceServers();
  PEER_OPTIONS.config.iceServers = dynamicIceServers;

  cleanupPeerConnection();
  if (!recoverySnapshot) clearHostRoomSession();
  clearGuestRoomSession();

  remoteRoomId = code;
  myPlayerNum = 1;
  currentRoomPeerId = roomPeerId(code);
  connectionState = 'creating';

  const restoring = Boolean(recoverySnapshot && restoreHostRoomSessionState(recoverySnapshot));
  if (recoverySnapshot && !restoring) {
    clearHostRoomSession();
    recoverySnapshot = null;
    recoveryAttempt = 0;
  }
  if (!restoring) resetRemoteRound();
  saveHostRoomSessionState();

  try {
    peer = new Peer(currentRoomPeerId, buildPeerOptions());

    peer.on('disconnected', () => {
      connectionState = 'disconnected';
      try { peer.reconnect(); } catch (_) {}
    });

    peer.on('open', () => {
      connectionState = 'waiting';
      saveHostRoomSessionState();
      showToast(recoverySnapshot
        ? `Host room “${code}” restored. Waiting for your partner to reconnect.`
        : `Room “${code}” ready as Player 1. Share your invite link!`);
      updateConnectionBanner();
    });

    peer.on('connection', incoming => {
      if (conn && conn.open) {
        const heartbeatExpired = Date.now() - lastPongAt > 30000;
        if (!heartbeatExpired) {
          incoming.close();
          showToast('A partner is already connected to this room.');
          return;
        }

        console.warn('Replacing unresponsive live-room connection.');
        const staleConn = conn;
        conn = null;
        try { staleConn.close(); } catch (_) {}
      } else if (conn) {
        const staleConn = conn;
        conn = null;
        try { staleConn.close(); } catch (_) {}
      }

      connectionState = 'connecting';
      conn = incoming;
      setupConnectionHandlers(conn);
      conn.on('open', () => {
        connectionRecoveryAttempts = 0;
        connectionState = 'connected';
        sendRoomState();
        startHeartbeat();
        showToast('Partner connected. Live room synchronized!');
        updateSwipeCard();
      });
    });

    peer.on('error', error => {
      connectionState = 'disconnected';

      if (error.type === 'unavailable-id' && recoverySnapshot) {
        if (recoveryAttempt < 6) {
          showToast('Restoring the host room. Retrying the previous room code…');
          updateConnectionBanner();
          if (!connectionRecoveryTimer) {
            const delay = Math.min(1200 * (recoveryAttempt + 1), 4000);
            connectionRecoveryTimer = window.setTimeout(() => {
              connectionRecoveryTimer = null;
              startP2PServer(code, recoverySnapshot, recoveryAttempt + 1);
            }, delay);
          }
          return;
        }
        showToast('The room code is still occupied. Wait briefly, then refresh to retry recovery.');
      } else if (error.type === 'network' || error.type === 'socket-closed') {
        try { peer.reconnect(); } catch (_) {}
      } else if (error.type === 'unavailable-id') {
        showToast('Room code is in use. Choose another code.');
      } else {
        showToast(`Room error: ${error.type || 'Connection failed'}`);
      }
      updateConnectionBanner();
    });
  } catch (error) {
    connectionState = 'disconnected';
    cleanupPeerConnection();
    showToast('Could not start live room.');
  }
}

async function joinP2PServer(presetCode = null) {
  if (!presetCode) {
    openLiveRoomModal('join');
    return;
  }
  const raw = presetCode;
  if (!raw) return;
  const code = normalizeRoomCode(raw);
  if (code.length < 12) {
    showToast('Enter a room code at least 12 characters long.');
    return;
  }

  if (typeof window.Peer !== 'function') {
    showToast('PeerJS did not load. Check connection and reload.');
    return;
  }

  clearHostRoomSession();
  saveGuestRoomSession(code);

  const dynamicIceServers = await fetchEphemeralIceServers();
  PEER_OPTIONS.config.iceServers = dynamicIceServers;

  cleanupPeerConnection();
  remoteRoomId = code;
  myPlayerNum = 2;
  currentRoomPeerId = roomPeerId(code);
  connectionState = 'connecting';

  try {
    peer = new Peer(buildPeerOptions());

    peer.on('disconnected', () => {
      connectionState = 'disconnected';
      try { peer.reconnect(); } catch (_) {}
    });

    peer.on('open', () => connectGuestToHost());

    peer.on('error', error => {
      connectionState = 'disconnected';

      const retryable = ['peer-unavailable', 'network', 'socket-closed', 'server-error']
        .includes(error.type);

      if (myPlayerNum === 2 && retryable) {
        if (conn && !conn.open) {
          const failedConn = conn;
          conn = null;
          try { failedConn.close(); } catch (_) {}
        }
        console.warn('Temporary guest connection error; retrying:', error.type);
        showToast('Host connection interrupted. Retrying automatically…');
        updateConnectionBanner();
        scheduleGuestReconnect();
        return;
      }

      if (error.type === 'network' || error.type === 'socket-closed') {
        try { peer.reconnect(); } catch (_) {}
      } else {
        showToast(`Join error: ${error.type || 'Could not connect'}`);
      }
      updateConnectionBanner();
    });
  } catch (error) {
    connectionState = 'disconnected';
    cleanupPeerConnection();
    showToast('Could not join live room.');
  }
}

function connectGuestToHost() {
  if (myPlayerNum !== 2 || !remoteRoomId || !peer || peer.destroyed) return;
  if (conn && conn.open) return;

  if (!peer.open || peer.disconnected) {
    scheduleGuestReconnect();
    return;
  }

  const staleConn = conn;
  conn = null;
  if (staleConn) {
    try { staleConn.close(); } catch (_) {}
  }

  let nextConn;
  try {
    nextConn = peer.connect(currentRoomPeerId, { reliable: true });
  } catch (error) {
    console.warn('Could not start guest connection:', error);
    scheduleGuestReconnect();
    return;
  }

  conn = nextConn;
  connectionState = 'connecting';
  setupConnectionHandlers(nextConn);
  updateConnectionBanner();

  nextConn.on('open', () => {
    if (conn !== nextConn) return;

    if (connectionRecoveryTimer) {
      window.clearTimeout(connectionRecoveryTimer);
      connectionRecoveryTimer = null;
    }

    connectionRecoveryAttempts = 0;
    connectionState = 'connected';
    showToast('Connected to room. Synchronizing the latest game state…');
    startHeartbeat();
    sendP2PMessage({ type: 'REQUEST_STATE' });

    if (pendingCompleteEntry) {
      sendP2PMessage({ type: 'COMPLETE_DATE_REQUEST', entry: pendingCompleteEntry });
    }

    updateSwipeCard();
  });

  nextConn.on('error', error => {
    console.warn('Guest data connection error:', error.type || error);
    if (conn !== nextConn || nextConn.open) return;

    conn = null;
    connectionState = 'disconnected';
    try { nextConn.close(); } catch (_) {}
    updateConnectionBanner();
    scheduleGuestReconnect();
  });
}

function scheduleGuestReconnect() {
  if (myPlayerNum !== 2 || !remoteRoomId || !peer || peer.destroyed) return;
  if (conn && conn.open) return;
  if (connectionRecoveryTimer) return;

  if (connectionRecoveryAttempts >= 60) {
    showToast('Automatic reconnection paused. Check the host, then rejoin using the same room code.');
    updateConnectionBanner();
    return;
  }

  connectionRecoveryAttempts++;
  const attempt = connectionRecoveryAttempts;

  connectionState = 'disconnected';
  updateConnectionBanner();

  connectionRecoveryTimer = window.setTimeout(() => {
    connectionRecoveryTimer = null;

    if (myPlayerNum !== 2 || !remoteRoomId || !peer || peer.destroyed) return;
    if (conn && conn.open) return;

    if (peer.disconnected) {
      try { peer.reconnect(); } catch (error) {
        console.warn('Peer signaling reconnect is pending:', error);
      }
    }

    if (!peer.open || peer.disconnected) {
      scheduleGuestReconnect();
      return;
    }

    connectGuestToHost();
  }, Math.min(1000 * attempt, 5000));
}

function startHeartbeat() {
  if (p2HeartbeatTimer) window.clearInterval(p2HeartbeatTimer);
  lastPongAt = Date.now();

  p2HeartbeatTimer = window.setInterval(() => {
    const activeConn = conn;
    if (!activeConn || !activeConn.open) return;

    sendP2PMessage({ type: 'PING', timestamp: Date.now() });

    if (Date.now() - lastPongAt > 30000) {
      console.warn('Live room heartbeat timed out; releasing stale connection.');
      try { activeConn.close(); } catch (_) {}

      // Handle the timeout even if the close event is delayed.
      if (conn === activeConn) {
        conn = null;
        connectionState = 'disconnected';
        remoteSubmitSent = false;
        updateSwipeCard();
        updateConnectionBanner();

        if (myPlayerNum === 2 && remoteRoomId) {
          showToast('Connection lost. Reconnecting to live room...');
          scheduleGuestReconnect();
        }
      }
    }
  }, 10000);
}

function leaveLiveRoom() {
  if (!remoteRoomId) {
    showToast('You are not currently in a live room.');
    return;
  }
  showConfirmModal('Leave Live Room?', 'Return to local single-device play mode?', 'Live Sync', () => {
    clearHostRoomSession();
    clearGuestRoomSession();
    cleanupPeerConnection();
    refreshDecks();
    initMatcher();
    showToast('Returned to local play mode.');
  });
}

function cleanupPeerConnection() {
  if (connectionRecoveryTimer) {
    window.clearTimeout(connectionRecoveryTimer);
    connectionRecoveryTimer = null;
  }
  connectionRecoveryAttempts = 0;
  if (p2HeartbeatTimer) {
    window.clearInterval(p2HeartbeatTimer);
    p2HeartbeatTimer = null;
  }
  try { if (conn) conn.close(); } catch (_) {}
  try { if (peer) peer.destroy(); } catch (_) {}
  conn = null;
  peer = null;
  remoteRoomId = null;
  currentRoomPeerId = null;
  myPlayerNum = 1;
  remoteSubmitSent = false;
  remotePartnerLikes = null;
  remoteGuestProgressLikes = [];
  remoteGuestSwipeIndex = 0;
  remoteMatchResolved = false;
  connectionState = 'disconnected';
  guestRoundId = null;
  pendingCompleteEntry = null;

  const completeButton = document.getElementById('completeDateBtn');
  if (completeButton) completeButton.disabled = !window.currentWinner;

  updateSwipeCard();
}

function sendP2PMessage(payload) {
  saveHostRoomSessionState();
  if (!conn || !conn.open) return false;
  try { conn.send(payload); return true; }
  catch (error) { console.error('P2P send error:', error); return false; }
}

function sendRoomState() {
  saveHostRoomSessionState();
  if (!remoteRoomId || myPlayerNum !== 1 || !conn || !conn.open) return;

  const budgetFilterEl = document.getElementById('budgetFilter');
  sendP2PMessage({
    type: 'SYNC_STATE',
    matcherDeck: p1Deck,
    roundState: {
      swipeIndex,
      swipePlayer,
      likedIds: p1Likes.map(item => item.id),
      matchResolved: Boolean(remoteMatchResolved)
    },
    guestProgress: {
      swipeIndex: remoteGuestSwipeIndex,
      likedIds: remoteGuestProgressLikes.map(item => item.id)
    },
    draftState: draftItems.length ? { items: draftItems, turn: draftTurn } : null,
    winner: window.currentWinner ? sanitizeCard(window.currentWinner) : null,
    hostFilters: {
      categories: [...document.querySelectorAll('.category-choice:checked')].map(input => input.value),
      packs: [...selectedPacks],
      budget: budgetFilterEl ? budgetFilterEl.value : 'all'
    }
  });
}

function tryResolveRemoteMatch() {
  if (!remoteRoomId || myPlayerNum !== 1) return false;
  if (remoteMatchResolved) return false;
  if (!Array.isArray(remotePartnerLikes)) return false;
  if (swipeIndex < p1Deck.length) return false;

  const partnerLikeIds = new Set(remotePartnerLikes.filter(item => item && item.id).map(item => item.id));
  const mutual = p1Likes.filter(item => partnerLikeIds.has(item.id));

  remoteMatchResolved = true;
  handleMatchOutcome(mutual);
  return true;
}

function setupConnectionHandlers(thisConn) {
  if (!thisConn) return;

  thisConn.on('data', message => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'PING') {
      sendP2PMessage({ type: 'PONG', timestamp: Date.now() });
      return;
    }
    if (message.type === 'PONG') {
      lastPongAt = Date.now();
      return;
    }

    if (message.type === 'REQUEST_STATE' && myPlayerNum === 1) {
      sendRoomState();
      return;
    }

    if (message.type === 'SWIPE_PROGRESS') {
      if (myPlayerNum === 1 && message.player === 2) {
        const ids = new Set(Array.isArray(message.likedIds) ? message.likedIds.filter(id => typeof id === 'string') : []);
        remoteGuestProgressLikes = p1Deck.filter(card => ids.has(card.id));
        remoteGuestSwipeIndex = Number.isInteger(message.swipeIndex) ? Math.max(0, Math.min(message.swipeIndex, p1Deck.length)) : remoteGuestSwipeIndex;
        saveHostRoomSessionState();
      }
      return;
    }

    if (message.type === 'SYNC_STATE' && myPlayerNum === 2) {
      if (!Array.isArray(message.matcherDeck)) return;

      const sharedDeck = sanitizeCardDeck(message.matcherDeck);
      p1Deck = [...sharedDeck];
      p2Deck = [...sharedDeck];

      p1Likes = [];
      p2Likes = [];
      swipeIndex = 0;
      swipePlayer = 1;
      remoteSubmitSent = false;
      remotePartnerLikes = null;
      remoteMatchResolved = false;

      if (message.roundState && typeof message.roundState === 'object') {
        const likeIds = new Set(Array.isArray(message.roundState.likedIds) ? message.roundState.likedIds.filter(id => typeof id === 'string') : []);
        p1Likes = sharedDeck.filter(card => likeIds.has(card.id));
        remoteMatchResolved = Boolean(message.roundState.matchResolved);
      }

      const guestProgress = message.guestProgress && typeof message.guestProgress === 'object' ? message.guestProgress : { swipeIndex: 0, likedIds: [] };
      const guestLikeIds = new Set(Array.isArray(guestProgress.likedIds) ? guestProgress.likedIds.filter(id => typeof id === 'string') : []);
      p2Likes = sharedDeck.filter(card => guestLikeIds.has(card.id));
      swipeIndex = Number.isInteger(guestProgress.swipeIndex) ? Math.max(0, Math.min(guestProgress.swipeIndex, sharedDeck.length)) : 0;
      swipePlayer = 2;

      draftItems = message.draftState && Array.isArray(message.draftState.items)
        ? message.draftState.items.map(raw => { const item = sanitizeCard(raw); return item ? { ...item, banned: Boolean(raw && raw.banned) } : null; }).filter(Boolean)
        : [];
      draftTurn = message.draftState && message.draftState.turn === 2 ? 2 : 1;
      window.currentWinner = message.winner ? sanitizeCard(message.winner) : null;

      const decisionModal = document.getElementById('decisionModal');
      const votingModal = document.getElementById('votingModal');
      if (decisionModal) decisionModal.classList.remove('show');
      if (votingModal) votingModal.classList.remove('show');

      if (message.hostFilters && typeof message.hostFilters === 'object') {
        const hostFilters = message.hostFilters;
        if (Array.isArray(hostFilters.categories)) {
          const categorySet = new Set(hostFilters.categories.filter(value => DEFAULT_CATEGORIES.includes(value)));
          document.querySelectorAll('.category-choice').forEach(input => { input.checked = categorySet.has(input.value); });
        }
        if (Array.isArray(hostFilters.packs)) {
          selectedPacks = [...new Set(hostFilters.packs.filter(value => value === 'starter' || Object.prototype.hasOwnProperty.call(expansionDecks, value)))];
          renderPackChoices();
        }
        if (['all', 'free', 'paid'].includes(hostFilters.budget)) {
          const budgetEl = document.getElementById('budgetFilter');
          if (budgetEl) budgetEl.value = hostFilters.budget;
        }
      }

      updateSwipeCard();
      if (window.currentWinner) {
        showModal('Live Room Resumed', window.currentWinner.title, window.currentWinner.detail);
      } else if (draftItems.length) {
        renderDraftGrid();
        const draftModal = document.getElementById('votingModal');
        if (draftModal) draftModal.classList.add('show');
      }
      return;
    }

    if (message.type === 'NEW_ROUND' && myPlayerNum === 2) {
      const decisionModal = document.getElementById('decisionModal');
      const votingModal = document.getElementById('votingModal');
      if (decisionModal) decisionModal.classList.remove('show');
      if (votingModal) votingModal.classList.remove('show');
      window.currentWinner = null;
      remoteSubmitSent = false;
      return;
    }

    if (message.type === 'SUBMIT_SWIPES' && myPlayerNum === 1) {
      remotePartnerLikes = sanitizeCardDeck(message.likedCards);
      remoteGuestProgressLikes = [...remotePartnerLikes];
      remoteGuestSwipeIndex = p1Deck.length;
      saveHostRoomSessionState();
      tryResolveRemoteMatch();
      updateSwipeCard();
      return;
    }

    if (message.type === 'MATCH_WINNER' && myPlayerNum === 2) {
      const winnerId = limitText(message.winnerId, 80);
      const winner = p2Deck.find(item => item.id === winnerId) || fullDeck.find(item => item.id === winnerId);
      if (winner) {
        const votingModal = document.getElementById('votingModal');
        if (votingModal) votingModal.classList.remove('show');
        window.currentWinner = winner;
        showModal('It’s a Match!', winner.title, winner.detail);
      }
      return;
    }

    if (message.type === 'NO_MUTUAL_MATCHES' && myPlayerNum === 2) {
      showNoMutualMatches();
      return;
    }

    if (message.type === 'REQUEST_NEW_ROUND' && myPlayerNum === 1) {
      restartMatcherAfterNoMatch();
      return;
    }

    if (message.type === 'MUTUAL_DRAFT_START' && myPlayerNum === 2) {
      draftItems = sanitizeCardDeck(message.draftItems).map(item => ({ ...item, banned: item.banned === true }));
      draftTurn = Number(message.draftTurn) === 2 ? 2 : 1;
      const actions = document.getElementById('noMatchesActions');
      if (actions) actions.hidden = true;
      const eyebrow = document.getElementById('votingEyebrow');
      const title = document.getElementById('votingModalTitle');
      if (eyebrow) eyebrow.textContent = 'Mutual Match Draft';
      if (title) title.textContent = 'Take Turns Eliminating';
      renderDraftGrid();
      const modal = document.getElementById('votingModal');
      if (modal) modal.classList.add('show');
      return;
    }

    if (message.type === 'BAN_REQUEST' && myPlayerNum === 1) {
      if (draftTurn === 2 && Number.isInteger(message.index)) executeBan(message.index);
      return;
    }

    if (message.type === 'DRAFT_STATE' && myPlayerNum === 2) {
      draftItems = sanitizeCardDeck(message.draftItems).map(item => ({ ...item, banned: item.banned === true }));
      draftTurn = Number(message.draftTurn) === 2 ? 2 : 1;
      renderDraftGrid();
      const remaining = draftItems.filter(item => !item.banned);
      if (remaining.length === 1) {
        window.currentWinner = remaining[0];
        const votingModal = document.getElementById('votingModal');
        if (votingModal) votingModal.classList.remove('show');
        showModal('Winner by Elimination!', remaining[0].title, remaining[0].detail);
      }
      return;
    }

    if (message.type === 'COMPLETE_DATE_REQUEST' && myPlayerNum === 1) {
      const incomingEntry = sanitizeHistoryEntry(message.entry);
      if (!incomingEntry) {
        sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: limitText(message.entry?.syncId, 120), ok: false });
        return;
      }

      const alreadySaved = dateHistory.some(record => record.syncId === incomingEntry.syncId);
      if (alreadySaved) {
        sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: incomingEntry.syncId, ok: true });
        return;
      }

      persistHistoryEntry(incomingEntry, true)
        .then(saved => {
          const ok = Boolean(saved);
          sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: incomingEntry.syncId, ok });
          if (ok) closeModal();
        })
        .catch(() => sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: incomingEntry.syncId, ok: false }));

      return;
    }

    if (message.type === 'COMPLETE_DATE_ACK' && myPlayerNum === 2) {
      if (!pendingCompleteEntry || message.syncId !== pendingCompleteEntry.syncId) return;

      const entry = pendingCompleteEntry;
      pendingCompleteEntry = null;

      const completeButton = document.getElementById('completeDateBtn');
      if (completeButton) completeButton.disabled = !window.currentWinner;

      if (message.ok === true) {
        persistHistoryEntry(entry, false)
          .then(() => { closeModal(); showToast('Date completion confirmed and saved.'); })
          .catch(() => showToast('Could not save confirmed date locally.'));
      } else {
        showToast('The host could not confirm the save.');
      }
      return;
    }

    if (message.type === 'HISTORY_ENTRY' && myPlayerNum === 2 && message.entry) {
      receiveHistoryEntry(message.entry).catch(err => console.error('Could not receive history entry:', err));
    }
  });

  thisConn.on('open', () => {
    conn = thisConn;
    connectionRecoveryAttempts = 0;
    connectionState = 'connected';
    if (myPlayerNum === 2 && pendingCompleteEntry) {
      sendP2PMessage({ type: 'COMPLETE_DATE_REQUEST', entry: pendingCompleteEntry });
    }
    updateSwipeCard();
  });

  thisConn.on('close', () => {
    if (thisConn !== conn) return;
    conn = null;
    connectionState = 'disconnected';
    remoteSubmitSent = false;
    updateSwipeCard();
    if (!remoteRoomId) return;

    if (myPlayerNum === 2) {
      showToast('Connection lost. Reconnecting to live room...');
      scheduleGuestReconnect();
    } else {
      updateConnectionBanner();
    }
  });
}
