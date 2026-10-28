'use strict';

/* Date Night Decider — Version 3.4.3 Hotfix 8 Product Engine
   - Native Capacitor Bridge & Adapter Integration
   - RevenueCat & Native In-App Purchase Architecture
   - Hardened WebRTC TURN Relay & Storage Protection */

const getEl = id => document.getElementById(id);

const DEFAULT_CATEGORIES = [
  'baking', 'cooking', 'gaming', 'board games', 'tv', 'movie',
  'micro-adventure', 'quest', 'arcade'
];

function limitText(value, maxLength = 1000) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function sanitizeCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const id = limitText(raw.id, 80);
  const title = limitText(raw.title, 160);
  const category = limitText(raw.category, 40);
  const budget = raw.budget;
  const location = raw.location;

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) return null;
  if (!title) return null;
  if (!DEFAULT_CATEGORIES.includes(category)) return null;
  if (!['free', 'paid'].includes(budget)) return null;
  if (!['home', 'out'].includes(location)) return null;

  const candidateGradient = limitText(raw.gradient, 100);
  const safeGradient = /^linear-gradient\(135deg,\s*#[0-9a-f]{6},\s*#[0-9a-f]{6}\)$/i.test(candidateGradient)
    ? candidateGradient
    : 'linear-gradient(135deg, #31103f, #190a24)';

  const card = {
    id,
    title,
    detail: limitText(raw.detail, 3000),
    category,
    budget,
    location,
    costEstimate: limitText(raw.costEstimate, 120),
    gradient: safeGradient
  };

  if (raw.duration !== undefined) card.duration = limitText(raw.duration, 100);

  if (Array.isArray(raw.equipment)) {
    card.equipment = raw.equipment.slice(0, 20).map(item => limitText(item, 200)).filter(Boolean);
  } else if (typeof raw.equipment === 'string') {
    card.equipment = limitText(raw.equipment, 200);
  }

  if (raw.mission !== undefined) card.mission = limitText(raw.mission, 3000);
  if (raw.atHomeAlternative !== undefined) card.atHomeAlternative = limitText(raw.atHomeAlternative, 1500);
  if (raw.importantRule !== undefined) card.importantRule = limitText(raw.importantRule, 1500);

  if (Array.isArray(raw.howToPlay)) {
    card.howToPlay = raw.howToPlay.slice(0, 20).map(step => limitText(step, 400)).filter(Boolean);
  }

  if (typeof raw.banned === 'boolean') card.banned = raw.banned;
  return card;
}

function sanitizeCardDeck(rawDeck, maxCards = 500) {
  if (!Array.isArray(rawDeck)) return [];
  const output = [];
  const seenIds = new Set();

  rawDeck.slice(0, maxCards).forEach(rawCard => {
    const card = sanitizeCard(rawCard);
    if (!card || seenIds.has(card.id)) return;
    seenIds.add(card.id);
    output.push(card);
  });

  return output;
}

function sanitizeHistoryEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const dateText = limitText(raw.date, 80);
  const time = Date.parse(dateText);
  if (!Number.isFinite(time)) return null;

  const safeRating = value => {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= 5 ? number : null;
  };

  const syncId = limitText(raw.syncId, 120) || createUniqueId();
  const category = DEFAULT_CATEGORIES.includes(raw.category) ? raw.category : 'Date';

  return {
    syncId,
    cardId: limitText(raw.cardId, 80) || null,
    title: limitText(raw.title, 160) || 'Untitled date',
    category,
    detail: limitText(raw.detail, 3000),
    date: new Date(time).toISOString(),
    rating1: safeRating(raw.rating1),
    rating2: safeRating(raw.rating2),
    note: limitText(raw.note, 2000)
  };
}

let deletedBuiltins = new Set();
let unlockedItems = [];
let dateHistory = [];
let appSettings = { theme: 'dark', feedback: 'both' };
let fullDeck = [];
let activeDeck = [];
let selectedPreviewItemId = null;
let selectedCategories = [...DEFAULT_CATEGORIES];
let selectedPacks = ['starter'];
let savedSelectedPacksPreference = null;

function showToast(message, duration = 3500) {
  let container = getEl('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:200;display:grid;gap:8px;pointer-events:none;width:90%;max-width:400px;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.style.cssText = 'background:#241436;border:1px solid var(--gold);color:var(--cream);padding:12px 16px;border-radius:12px;font-size:0.82rem;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,0.85);pointer-events:auto;text-align:center;animation:fadeInOut 0.3s ease;';
  toast.textContent = message;
  container.appendChild(toast);
  window.setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    window.setTimeout(() => toast.remove(), 300);
  }, duration);
}

async function triggerHaptic(type = 'light') {
  if (window.DeviceAdapter) {
    await window.DeviceAdapter.triggerHaptic(type, appSettings.feedback);
  }
}

let audioCtx = null;
let audioGestureSeen = false;

function unlockAudioAfterGesture() {
  if (audioGestureSeen) return;
  audioGestureSeen = true;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch (error) {
    console.debug('Web Audio is unavailable:', error);
  }
}

function playSound(type) {
  if (!['both', 'sound'].includes(appSettings.feedback) || !audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    if (type === 'swipe') {
      osc.frequency.setValueAtTime(350, now);
      osc.frequency.exponentialRampToValueAtTime(120, now + 0.08);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.08);
      osc.start(now); osc.stop(now + 0.08);
    } else if (type === 'ban') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(160, now);
      osc.frequency.exponentialRampToValueAtTime(70, now + 0.1);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.1);
      osc.start(now); osc.stop(now + 0.1);
    } else if (type === 'win') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523, now);
      osc.frequency.setValueAtTime(659, now + 0.1);
      osc.frequency.setValueAtTime(783, now + 0.2);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.35);
      osc.start(now); osc.stop(now + 0.35);
    }
  } catch (err) { console.debug('Sound unavailable:', err); }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

const masterDeck = [
  { id:'baking-01', title:'Apple-Blackberry Lattice Pie', detail:'Make an all-butter pie dough from scratch, roll out a woven lattice top, and fill with fresh apple and blackberry.', category:'baking', budget:'paid', location:'home', costEstimate:'$10–$15 for ingredients', gradient:'linear-gradient(135deg, #4a1525, #831843)' },
  { id:'baking-02', title:'Cream Cheese Danish Batch', detail:'Make laminated pastry dough from scratch, fill with sweet cream cheese and fruit preserves, and bake until golden.', category:'baking', budget:'paid', location:'home', costEstimate:'$8–$12 for ingredients', gradient:'linear-gradient(135deg, #3b1f2b, #701a75)' },
  { id:'cooking-01', title:'Homemade Gourmet Pizza Night', detail:'Stretch homemade dough from scratch, layer with custom sauces, premium cheese, and your favorite toppings.', category:'cooking', budget:'paid', location:'home', costEstimate:'$12–$20 for toppings', gradient:'linear-gradient(135deg, #1e293b, #0f172a)' },
  { id:'cooking-02', title:'Authentic Street Taco Bar', detail:'Prep slow-cooked carnitas or grilled chicken with homemade salsas, fresh cilantro, and warm corn tortillas.', category:'cooking', budget:'paid', location:'home', costEstimate:'$15–$25 for fresh ingredients', gradient:'linear-gradient(135deg, #451a03, #78350f)' },
  { id:'gaming-01', title:'Cozy Split-Screen Co-Op', detail:'Load up a relaxing couch co-op video game and work together to build a shared virtual world or solve puzzles.', category:'gaming', budget:'free', location:'home', costEstimate:'Free (using owned games)', gradient:'linear-gradient(135deg, #064e3b, #022c22)' },
  { id:'gaming-02', title:'Arcade High Score Showdown', detail:'Play classic arcade games or fast-paced party games and battle head-to-head for the top spot.', category:'gaming', budget:'paid', location:'out', costEstimate:'$10–$25 arcade tokens', gradient:'linear-gradient(135deg, #172554, #1e3a8a)' },
  { id:'board-01', title:'Intense Strategy Board Game', detail:'Brew some coffee or tea, clear the table, and dive into a deep tabletop strategy or card drafting game.', category:'board games', budget:'free', location:'home', costEstimate:'Free (using owned games)', gradient:'linear-gradient(135deg, #312e81, #1e1b4b)' },
  { id:'board-02', title:'Fast-Paced Party Card Game', detail:'Pull out a hilarious casual card game for quick laughs and lighthearted competition.', category:'board games', budget:'free', location:'home', costEstimate:'Free (using owned games)', gradient:'linear-gradient(135deg, #581c87, #3b0764)' },
  { id:'tv-01', title:'Nostalgic TV Show Pilot Night', detail:'Rewatch the pilot episodes of your favorite childhood TV series together.', category:'tv', budget:'free', location:'home', costEstimate:'Free on streaming', gradient:'linear-gradient(135deg, #831843, #500724)' },
  { id:'tv-02', title:'Binge-Worthy Mystery Series', detail:'Stream the opening episodes of a gripping new thriller or mystery show.', category:'tv', budget:'free', location:'home', costEstimate:'Free on streaming', gradient:'linear-gradient(135deg, #0f766e, #115e59)' },
  { id:'movie-01', title:'First-Time Epic Adventure', detail:'Stream a critically acclaimed adventure or sci-fi movie that neither of you has ever seen.', category:'movie', budget:'free', location:'home', costEstimate:'Free on streaming', gradient:'linear-gradient(135deg, #31103f, #190a24)' },
  { id:'movie-02', title:'Local Cinema Night Out', detail:'Get dressed up, grab buttery popcorn at the local movie theater, and catch the latest release.', category:'movie', budget:'paid', location:'out', costEstimate:'$20–$40 tickets & snacks', gradient:'linear-gradient(135deg, #6b21a8, #4c1d95)' },
  { id:'micro-01', title:'Photo Scavenger Walk', detail:'Take a short walk and capture photos of five surprising textures, colors, patterns, or tiny details.', category:'micro-adventure', budget:'free', location:'out', costEstimate:'Free', duration:'30–45 minutes', equipment:['Phone camera'], mission:'Find five photos that tell a tiny story about your neighborhood.', howToPlay:['Pick five prompts such as something tiny, something bright, a pattern, a funny sign, and a peaceful spot.','Walk together in a familiar public area and take one photo for each prompt.','Trade phones and choose each other’s favorite photo.'], gradient:'linear-gradient(135deg, #0f766e, #164e63)' },
  { id:'micro-02', title:'Five-Senses Cozy Challenge', detail:'Build a cozy at-home mini-adventure around textures, sounds, scents, tastes, and things you can see.', category:'micro-adventure', budget:'free', location:'home', costEstimate:'Free with household items', duration:'20–30 minutes', equipment:['A few household items'], mission:'Create one small moment for each of the five senses.', howToPlay:['Each person picks two safe household items or experiences.','Take turns guessing an item by sound, texture, scent, or taste only when safe and appropriate.','Finish by choosing the sense that made you laugh most.'], gradient:'linear-gradient(135deg, #0f766e, #134e4a)' },
  { id:'quest-01', title:'Neighborhood Clue Quest', detail:'Create a short, friendly route with clues that lead to a shared destination such as a park, public mural, or favorite snack stop.', category:'quest', budget:'free', location:'out', costEstimate:'Free; optional snack cost', duration:'30–60 minutes', equipment:['Phone notes or paper'], mission:'Solve three clues together before reaching the final stop.', howToPlay:['Choose a familiar, safe route and a public destination.','Write three simple clues based on visible landmarks, not private property.','Take turns reading clues and solving them together.'], importantRule:'Stay in public, accessible areas and follow local rules.', gradient:'linear-gradient(135deg, #1d4ed8, #312e81)' },
  { id:'quest-02', title:'At-Home Treasure Trail', detail:'Hide three small notes or household objects and create clues that lead your partner from one to the next.', category:'quest', budget:'free', location:'home', costEstimate:'Free with household items', duration:'15–30 minutes', equipment:['Paper and pen'], mission:'Make a tiny treasure hunt with a sweet or funny final message.', howToPlay:['One person hides three notes in easy-to-find places.','Write a clue for each location and make the last clue lead to a final message or shared treat.','Switch roles and run the hunt again.'], gradient:'linear-gradient(135deg, #1d4ed8, #172554)' },
  { id:'arcade-01', title:'Best-of-Three Skill Showdown', detail:'Pick three quick, safe household challenges and compete for two wins—or combine scores as a team.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with household items', duration:'15–25 minutes', equipment:['Paper cups or soft household items'], mission:'Play three quick rounds and crown the champion.', howToPlay:['Choose three safe challenges such as paper-ball toss into a bin, cup stacking, or drawing with your non-dominant hand.','Agree on a simple scoring rule before each round.','Winner chooses the next song or snack; then swap roles.'], importantRule:'Use soft objects and clear a safe space before playing.', gradient:'linear-gradient(135deg, #7e22ce, #4c1d95)' },
  { id:'arcade-02', title:'Blind Drawing Guess-Off', detail:'Take turns describing a simple object while the other person draws it without seeing a reference picture.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with paper and pens', duration:'15–20 minutes', equipment:['Paper','Pens or pencils'], mission:'Earn points for accurate guesses and funniest drawings.', howToPlay:['One player privately chooses a simple object and describes its shape in short steps.','The other draws based only on the description.','Reveal the object, award one point for a correct guess and one bonus point for the funniest result, then switch.'], gradient:'linear-gradient(135deg, #7e22ce, #701a75)' }
];

let swipeLocked = false;

const shuffle = array => {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

function createUniqueId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getCardScore(card) {
  let score = 5;
  const matches = dateHistory.filter(h => h.cardId === card.id || (!h.cardId && h.category === card.category));
  const ratings = [];
  matches.forEach(entry => {
    [entry.rating1, entry.rating2].forEach(value => {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1 && n <= 5) ratings.push(n);
    });
  });
  if (ratings.length) {
    const average = ratings.reduce((sum, n) => sum + n, 0) / ratings.length;
    score += (average - 3) * 2;
  }
  return score + Math.random() * 0.5;
}

function renderPackChoices() {
  document.querySelectorAll('.pack-choice').forEach(input => {
    const packId = input.value;
    const unlocked = packId === 'starter' || unlockedItems.includes(packId);
    const selectedByHost = remoteRoomId && myPlayerNum === 2 && selectedPacks.includes(packId);
    input.checked = selectedPacks.includes(packId);
    input.disabled = Boolean(remoteRoomId && myPlayerNum === 2) || (!unlocked && !selectedByHost);

    const status = getEl(`packStatus-${packId}`);
    if (status) {
      status.textContent = packId === 'starter'
        ? 'Included'
        : unlocked
          ? (selectedPacks.includes(packId) ? 'Selected' : 'Unlocked')
          : (selectedByHost ? 'Host selected' : 'Locked · Store');
    }
  });

  const summary = getEl('categorySummary');
  if (summary) {
    const packText = selectedPacks.length === 1 ? '1 pack' : `${selectedPacks.length} packs`;
    summary.textContent = `${packText} selected · ${activeDeck.length} ideas ▾`;
  }
}

function refreshDecks() {
  const libraryCards = [...masterDeck];
  unlockedItems.forEach(packId => {
    if (window.expansionDecks && window.expansionDecks[packId]) {
      libraryCards.push(...window.expansionDecks[packId]);
    }
  });
  fullDeck = libraryCards.filter(item => !deletedBuiltins.has(item.id));

  const checkboxes = document.querySelectorAll('.category-choice');
  if (checkboxes.length) {
    selectedCategories = [...checkboxes].filter(input => input.checked).map(input => input.value);
  }

  if (!(remoteRoomId && myPlayerNum === 2)) {
    selectedPacks = ['starter', ...unlockedItems.filter(id =>
      window.expansionDecks && Array.isArray(window.expansionDecks[id])
    )];
  }
  const chosenCards = [];
  selectedPacks.forEach(packId => {
    if (packId === 'starter') chosenCards.push(...masterDeck);
    else if (window.expansionDecks && Array.isArray(window.expansionDecks[packId])) {
      chosenCards.push(...window.expansionDecks[packId]);
    }
  });

  const budgetFilterEl = getEl('budgetFilter');
  const budget = budgetFilterEl ? budgetFilterEl.value : 'all';
  activeDeck = chosenCards.filter(item => {
    const notDeleted = !deletedBuiltins.has(item.id);
    const categoryMatches = selectedCategories.includes(item.category);
    const budgetMatches = budget === 'all' || item.budget === budget;
    return notDeleted && categoryMatches && budgetMatches;
  });
  activeDeck.sort((a, b) => getCardScore(b) - getCardScore(a));
  renderPackChoices();
}

async function applyPackFilter() {
  const previousPacks = [...selectedPacks];
  const checkedPacks = [...document.querySelectorAll('.pack-choice:checked')].map(input => input.value);
  selectedPacks = [...new Set(checkedPacks.filter(packId =>
    packId === 'starter' || unlockedItems.includes(packId) ||
    (remoteRoomId && myPlayerNum === 2 && previousPacks.includes(packId))
  ))];

  if (!storageFailed && db && !(remoteRoomId && myPlayerNum === 2)) {
    try { await db.settings.put({ key: 'selectedPacks', value: selectedPacks }); }
    catch (err) { console.error('Could not save selected packs:', err); }
  }

  refreshDecks();
  if (remoteRoomId && myPlayerNum === 2) {
    if (getEl('card-library')?.classList.contains('active-mode')) renderLibrary();
    return;
  }

  if (remoteRoomId && myPlayerNum === 1) {
    resetRemoteRound();
    sendRoomState();
  } else {
    initMatcher();
  }
  if (getEl('card-library')?.classList.contains('active-mode')) renderLibrary();
}

async function applyCategoryFilter() {
  selectedCategories = [...document.querySelectorAll('.category-choice:checked')].map(input => input.value);
  if (!storageFailed && db) {
    try { await db.categories.put({ id: 'selectedCats', values: selectedCategories }); }
    catch (err) { console.error('Could not save category filters:', err); }
  }
  refreshDecks();

  if (remoteRoomId && myPlayerNum === 2) {
    if (getEl('card-library')?.classList.contains('active-mode')) renderLibrary();
    return;
  }

  if (remoteRoomId && myPlayerNum === 1) {
    resetRemoteRound();
    sendRoomState();
  } else {
    initMatcher();
  }
  if (getEl('card-library')?.classList.contains('active-mode')) renderLibrary();
}

function setAllCategories(checked) {
  const picker = getEl('categoryPicker');
  if (picker) picker.open = true;
  document.querySelectorAll('.category-choice').forEach(input => { input.checked = checked; });
  applyCategoryFilter();
  if (picker) picker.open = true;
}

function switchGame(mode, button = null) {
  const allowedViews = new Set(['matcher', 'surprise', 'history', 'library', 'store', 'settings']);
  if (!allowedViews.has(mode)) return;

  const picker = getEl('categoryPicker');
  if (picker) picker.open = false;

  const target = getEl(`card-${mode}`);
  if (!target) return;

  document.querySelectorAll('.game-card').forEach(card => card.classList.remove('active-mode'));
  target.classList.add('active-mode');

  const isDecide = mode === 'matcher' || mode === 'surprise';
  const tabKey = isDecide ? 'decide' :
    (mode === 'store' || mode === 'library') ? 'packs' : mode;

  document.querySelectorAll('.app-nav-tab').forEach(tab => {
    const active = tab.dataset.appTab === tabKey;
    tab.classList.toggle('active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });

  document.querySelectorAll('.nav-tab').forEach(tab => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
  });

  const filters = document.querySelector('.filter-bar');
  if (filters) filters.hidden = !isDecide;
  const tracker = document.querySelector('.tracker-strip');
  if (tracker) tracker.hidden = !isDecide;
  const modeNav = document.querySelector('.nav-grid');
  if (modeNav) modeNav.hidden = !isDecide;

  if (mode === 'matcher') updateSwipeCard();
  if (mode === 'library') renderLibrary();
  if (mode === 'history') renderHistory();
  if (mode === 'store' && typeof renderStore === 'function') renderStore();
}

document.addEventListener('click', event => {
  const picker = getEl('categoryPicker');
  if (picker && picker.open && !picker.contains(event.target)) picker.open = false;
});

function currentSwipeDeck() {
  if (remoteRoomId) return myPlayerNum === 1 ? p1Deck : p2Deck;
  return swipePlayer === 1 ? p1Deck : p2Deck;
}

function initMatcher() {
  p1Deck = shuffle(activeDeck);
  p2Deck = [...p1Deck];
  p1Likes = [];
  p2Likes = [];
  swipePlayer = 1;
  swipeIndex = 0;
  remoteSubmitSent = false;
  remotePartnerLikes = null;
  remoteGuestProgressLikes = [];
  remoteGuestSwipeIndex = 0;
  remoteMatchResolved = false;
  window.currentWinner = null;
  draftItems = [];
  draftTurn = 1;
  const votingModal = getEl('votingModal');
  if (votingModal) votingModal.classList.remove('show');
  const noMatchesActions = getEl('noMatchesActions');
  if (noMatchesActions) noMatchesActions.hidden = true;
  updateSwipeCard();
}

function updateConnectionBanner() {
  const statusBanner = getEl('connectionStatusBanner');
  if (!statusBanner) return;

  // Keep the connected state unobtrusive; show the banner again if the
  // connection is waiting, disconnected, or trying to reconnect.
  if (remoteRoomId && conn && conn.open) {
    statusBanner.style.display = 'none';
    statusBanner.textContent = '';
    return;
  }

  if (remoteRoomId) {
    statusBanner.style.display = 'block';
    const signalingNote = PEER_SIGNALING_CONFIG.host ? 'private signaling' : 'public PeerJS signaling';
    const relayNote = turnRelayUnavailable ? ' · STUN-only best effort; some mobile networks may fail' : ' · relay configuration available';
    if (conn && conn.open) {
      statusBanner.className = 'connection-status-banner connected';
      statusBanner.textContent = `🟢 Connected to Room "${remoteRoomId}" (Player ${myPlayerNum}) · ${signalingNote}${relayNote}`;
    } else {
      statusBanner.className = 'connection-status-banner disconnected';
      const disconnectText = connectionState === 'waiting'
        ? 'Waiting for partner to join...'
        : myPlayerNum === 1
          ? 'Partner disconnected — waiting for them to reconnect...'
          : connectionState === 'connecting'
            ? 'Connecting to live room...'
            : 'Disconnected from room. Reconnecting...';
      statusBanner.textContent = `🔴 ${disconnectText} · ${signalingNote}${relayNote}`;
    }
  } else {
    statusBanner.style.display = 'none';
  }
}

function updateSwipeCard() {
  const header = getEl('matcherTurnHeader');
  const cardEl = getEl('swipeCard');
  const metaEl = getEl('cardMeta');
  const venueHint = getEl('venueHintBanner');
  if (!header || !cardEl) return;

  updateConnectionBanner();
  if (typeof saveHostRoomSessionState === 'function') saveHostRoomSessionState();

  const curDeck = currentSwipeDeck();
  if (!curDeck.length) {
    header.textContent = 'No matching date ideas';
    cardEl.style.background = '#1f122e';

    const catEl = getEl('cardCategory');
    if (catEl) catEl.textContent = 'No cards';

    const titleEl = getEl('cardTitle');
    if (titleEl) titleEl.textContent = 'Adjust your packs';

    const detailEl = getEl('cardDetail');
    if (detailEl) {
      if (remoteRoomId && myPlayerNum === 2 && !guestRoundId) {
        detailEl.textContent = 'Waiting for the host to send the shared date deck…';
      } else if (!selectedPacks.length) {
        detailEl.textContent = 'Select at least one pack in Filters & Preferences to start Matcher.';
      } else if (!selectedCategories.length) {
        detailEl.textContent = 'Select at least one category in Filters & Preferences.';
      } else {
        detailEl.textContent = 'No cards match the selected packs, categories, and budget. Choose more packs/categories or select Any Budget.';
      }
    }

    if (metaEl) metaEl.replaceChildren();
    if (venueHint) venueHint.style.display = 'none';
    const announcer = getEl('cardAnnouncer');
    if (announcer) announcer.textContent = 'No matching date ideas. Adjust your packs, categories, or budget filters.';
    return;
  }

  if (remoteRoomId) {
    header.textContent = `Live Room (${remoteRoomId}) · Player ${myPlayerNum} · Card ${Math.min(swipeIndex + 1, curDeck.length)} of ${curDeck.length}`;
  } else {
    header.textContent = `Player ${swipePlayer}'s Turn · Card ${Math.min(swipeIndex + 1, curDeck.length)} of ${curDeck.length}`;
  }

  if (swipeIndex >= curDeck.length) {
    if (remoteRoomId) {
      if (!conn || !conn.open) {
        header.textContent = 'Live room disconnected · Rejoin or check connection';
      } else if (myPlayerNum === 2) {
        if (!remoteSubmitSent) {
          remoteSubmitSent = sendP2PMessage({
            type: 'SUBMIT_SWIPES',
            likedCards: p2Likes
          });
        }
        header.textContent = 'All cards reviewed · Waiting for mutual match result from Host…';
      } else {
        if (tryResolveRemoteMatch()) return;
        header.textContent = remotePartnerLikes !== null
          ? 'Partner finished · Resolving mutual match…'
          : 'All cards reviewed · Waiting for partner to finish…';
      }

      const catEl = getEl('cardCategory'); if (catEl) catEl.textContent = 'Swiping complete';
      const titleEl = getEl('cardTitle'); if (titleEl) titleEl.textContent = 'Waiting for mutual match';
      const detailEl = getEl('cardDetail'); if (detailEl) detailEl.textContent = myPlayerNum === 1
        ? 'Comparing partner selections and opening mutual draft elimination.'
        : 'Your selections have been securely submitted. Waiting for host resolution.';

      cardEl.style.background = '#1f122e';
      if (metaEl) metaEl.replaceChildren();
      if (venueHint) venueHint.style.display = 'none';
      const announcer = getEl('cardAnnouncer');
      if (announcer) announcer.textContent = `Swiping complete. ${header.textContent}`;
      return;
    }

    if (swipePlayer === 1) {
      swipePlayer = 2;
      swipeIndex = 0;
      showToast("Player 1 complete! Pass the phone to Player 2.");
      updateSwipeCard();
    } else {
      const mutual = p1Likes.filter(a => p2Likes.some(b => b.id === a.id));
      handleMatchOutcome(mutual);
    }
    return;
  }

  const item = curDeck[swipeIndex];
  cardEl.style.background = item.gradient || '#1f122e';
  const catEl = getEl('cardCategory'); if (catEl) catEl.textContent = item.category || 'Date idea';
  const titleEl = getEl('cardTitle'); if (titleEl) titleEl.textContent = item.title || 'Untitled date';
  const detailEl = getEl('cardDetail'); if (detailEl) detailEl.textContent = item.detail || '';
  const announcer = getEl('cardAnnouncer');
  if (announcer) announcer.textContent = `${item.category || 'Date idea'}: ${item.title || 'Untitled date'}. ${item.detail || ''}`;

  if (metaEl) {
    const locLabel = item.location === 'home'
      ? '🏠 Stay Home'
      : item.location === 'out'
        ? '🚗 Go Out'
        : '🌐 Either';

    const costPill = document.createElement('span');
    costPill.className = 'meta-pill';
    costPill.textContent = `💰 ${item.budget === 'free' ? 'Free' : (item.costEstimate || 'Paid')}`;

    const locationPill = document.createElement('span');
    locationPill.className = 'meta-pill';
    locationPill.textContent = locLabel;

    metaEl.replaceChildren(costPill, locationPill);
  }

  if (venueHint) venueHint.style.display = item.location === 'out' ? 'block' : 'none';
}

function handleSwipe(liked) {
  if (swipeLocked) return;
  const curDeck = currentSwipeDeck();

  if (remoteRoomId && (!conn || !conn.open)) {
    showToast('The live-room connection is not ready. Reconnect before swiping.');
    return;
  }
  if (!curDeck.length || swipeIndex >= curDeck.length) return;

  swipeLocked = true;
  window.setTimeout(() => { swipeLocked = false; }, 320);

  const likes = remoteRoomId
    ? (myPlayerNum === 1 ? p1Likes : p2Likes)
    : (swipePlayer === 1 ? p1Likes : p2Likes);

  playSound('swipe');
  triggerHaptic('light');
  if (liked) likes.push(curDeck[swipeIndex]);
  swipeIndex += 1;
  if (remoteRoomId && conn && conn.open) {
    const currentLikes = myPlayerNum === 1 ? p1Likes : p2Likes;
    sendP2PMessage({ type: 'SWIPE_PROGRESS', player: myPlayerNum, swipeIndex, likedIds: currentLikes.map(item => item.id) });
  }
  updateSwipeCard();
}

function installSwipeGestures() {
  swipeCardEl = getEl('swipeCard');
  if (!swipeCardEl) return;
  swipeCardEl.addEventListener('mousedown', dragStart);
  swipeCardEl.addEventListener('touchstart', dragStart, { passive: true });

  function dragStart(event) {
    if (swipeLocked) return;
    const deck = currentSwipeDeck();
    if (swipeIndex >= deck.length || (remoteRoomId && (!conn || !conn.open))) return;
    isDragging = true;
    startX = event.type.includes('mouse') ? event.clientX : event.touches[0].clientX;
    currentX = 0;
    startTime = performance.now();
    swipeCardEl.style.transition = 'none';
    window.addEventListener('mousemove', dragMove);
    window.addEventListener('mouseup', dragEnd);
    window.addEventListener('touchmove', dragMove, { passive: true });
    window.addEventListener('touchend', dragEnd);
    window.addEventListener('touchcancel', dragEnd);
  }

  function dragMove(event) {
    if (!isDragging) return;
    const x = event.type.includes('mouse') ? event.clientX : event.touches?.[0]?.clientX;
    if (typeof x !== 'number') return;
    currentX = x - startX;
    swipeCardEl.style.transform = `translateX(${x - startX}px) rotate(${(x - startX) * 0.04}deg)`;
  }

  function dragEnd() {
    if (!isDragging) return;
    isDragging = false;
    window.removeEventListener('mousemove', dragMove);
    window.removeEventListener('mouseup', dragEnd);
    window.removeEventListener('touchmove', dragMove);
    window.removeEventListener('touchend', dragEnd);
    window.removeEventListener('touchcancel', dragEnd);
    swipeCardEl.style.transition = 'transform 0.3s ease, opacity 0.3s ease';

    const elapsed = (performance.now() - startTime) / 1000;
    const velocity = Math.abs(currentX / (elapsed || 0.001));
    const threshold = velocity > 400 ? 40 : 80;
    const wasLike = currentX > threshold;
    const wasPass = currentX < -threshold;
    currentX = 0;

    if (wasLike || wasPass) {
      swipeCardEl.style.transform = `translateX(${wasLike ? 350 : -350}px) rotate(${wasLike ? 25 : -25}deg)`;
      swipeCardEl.style.opacity = '0';
      window.setTimeout(() => {
        handleSwipe(wasLike);
        resetSwipeCard();
      }, 220);
    } else {
      swipeCardEl.style.transform = 'translateX(0) rotate(0)';
    }
  }
}

function resetSwipeCard() {
  if (!swipeCardEl) return;
  swipeCardEl.style.transform = 'translateX(0) rotate(0)';
  swipeCardEl.style.opacity = '1';
}

function handleMatchOutcome(mutual, forcedWinner = null) {
  if (forcedWinner) {
    window.currentWinner = forcedWinner;
    const isMutual = Array.isArray(mutual) && mutual.some(item => item.id === forcedWinner.id);
    showModal(isMutual ? 'It’s a Match!' : 'Date Decided!', forcedWinner.title, forcedWinner.detail);
    return;
  }

  const unique = new Map();
  (Array.isArray(mutual) ? mutual : []).forEach(item => {
    const safe = sanitizeCard(item);
    if (safe) unique.set(safe.id, safe);
  });
  const mutualOptions = [...unique.values()];

  if (mutualOptions.length === 0) {
    if (remoteRoomId && myPlayerNum === 1) sendP2PMessage({ type: 'NO_MUTUAL_MATCHES' });
    showNoMutualMatches();
    return;
  }

  if (mutualOptions.length === 1) {
    const winner = mutualOptions[0];
    window.currentWinner = winner;
    if (remoteRoomId && myPlayerNum === 1) {
      sendP2PMessage({ type: 'MATCH_WINNER', winnerId: winner.id });
    }
    showModal('It’s a Match!', winner.title, winner.detail);
    return;
  }

  startMutualDraft(mutualOptions);
}

function showNoMutualMatches() {
  window.currentWinner = null;
  draftItems = [];

  const modal = getEl('votingModal');
  const eyebrow = getEl('votingEyebrow');
  const title = getEl('votingModalTitle');
  const detail = getEl('votingModalDetail');
  const container = getEl('votingShortlistContainer');
  const actions = getEl('noMatchesActions');
  const draftTurnHeader = getEl('draftTurnHeader');

  if (draftTurnHeader) draftTurnHeader.hidden = true;
  if (eyebrow) eyebrow.textContent = 'No Mutual Matches';
  if (title) title.textContent = 'Nothing Matched This Round';
  if (detail) detail.textContent = 'You both need to like the same idea for it to enter the elimination draft. No unrelated suggestions will be added. Adjust your selected packs or categories and play another round.';
  if (container) container.replaceChildren();
  if (actions) actions.hidden = false;
  if (modal) modal.classList.add('show');
}

function restartMatcherAfterNoMatch() {
  const modal = getEl('votingModal');
  if (modal) modal.classList.remove('show');
  const actions = getEl('noMatchesActions');
  if (actions) actions.hidden = true;

  if (remoteRoomId && myPlayerNum === 2) {
    const sent = sendP2PMessage({ type: 'REQUEST_NEW_ROUND' });
    showToast(sent ? 'Asked the host to restart Matcher with the same packs.' : 'Could not reach the host. Reconnect and try again.');
    return;
  }

  if (remoteRoomId && myPlayerNum === 1) {
    resetRemoteRound();
    sendRoomState();
    showToast('New Matcher round started with the same packs.');
    return;
  }

  initMatcher();
  showToast('New Matcher round started with the same packs.');
}

function requestPackAdjustment() {
  const modal = getEl('votingModal');
  if (modal) modal.classList.remove('show');
  const actions = getEl('noMatchesActions');
  if (actions) actions.hidden = true;

  if (remoteRoomId && myPlayerNum === 2) {
    const sent = sendP2PMessage({ type: 'REQUEST_FILTER_CHANGE' });
    showToast(sent ? 'Asked the host to adjust the selected packs.' : 'Could not reach the host. Reconnect and try again.');
    return;
  }

  const picker = getEl('categoryPicker');
  if (picker) picker.open = true;
  const summary = getEl('categorySummary');
  if (summary) summary.focus();
  showToast('Adjust your selected packs or categories, then start a new round.');
}

function startMutualDraft(items) {
  const unique = new Map();
  (Array.isArray(items) ? items : []).forEach(item => {
    const safe = sanitizeCard(item);
    if (safe) unique.set(safe.id, safe);
  });
  const mutualOptions = [...unique.values()];

  if (mutualOptions.length === 0) {
    showNoMutualMatches();
    return;
  }
  if (mutualOptions.length === 1) {
    handleMatchOutcome(mutualOptions);
    return;
  }

  draftItems = mutualOptions.map(item => ({ ...item, banned: false }));
  draftTurn = 1;
  const actions = getEl('noMatchesActions');
  if (actions) actions.hidden = true;
  const eyebrow = getEl('votingEyebrow');
  const title = getEl('votingModalTitle');
  if (eyebrow) eyebrow.textContent = 'Mutual Match Draft';
  if (title) title.textContent = 'Take Turns Eliminating';
  renderDraftGrid();

  if (remoteRoomId && myPlayerNum === 1) {
    sendP2PMessage({ type: 'MUTUAL_DRAFT_START', draftItems, draftTurn });
  }

  const modal = getEl('votingModal');
  if (modal) modal.classList.add('show');
}

function renderDraftGrid() {
  const header = getEl('draftTurnHeader');
  if (header) {
    header.hidden = false;
    header.textContent = remoteRoomId
      ? `Live Room (${remoteRoomId}) · Player ${draftTurn}'s Turn to Ban`
      : `Player ${draftTurn}'s Turn to Ban`;
  }

  const grid = getEl('votingShortlistContainer');
  if (!grid) return;

  if (!draftItems.length) {
    grid.replaceChildren();
    return;
  }

  const remainingCount = draftItems.filter(item => !item.banned).length;
  const detail = getEl('votingModalDetail');
  if (detail) {
    detail.textContent = `${remainingCount} mutual option${remainingCount === 1 ? '' : 's'} remain. On your turn, eliminate one option; the other player then chooses the next one to eliminate.`;
  }
  const noMatchesActions = getEl('noMatchesActions');
  if (noMatchesActions) noMatchesActions.hidden = true;

  grid.replaceChildren();
  draftItems.forEach((item, index) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `draft-tile${item.banned ? ' banned' : ''}`;
    tile.dataset.cardId = item.id;
    tile.style.background = item.gradient || '#1f122e';
    tile.disabled = Boolean(item.banned);

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.title || 'Untitled date';

    const category = document.createElement('div');
    category.className = 'cat';
    category.textContent = item.category || '';

    tile.append(title, category);

    if (!item.banned) {
      tile.addEventListener('click', () => {
        banItem(index);
      });
    }
    grid.appendChild(tile);
  });
  if (typeof saveHostRoomSessionState === 'function') saveHostRoomSessionState();
}

function executeBan(index) {
  if (!draftItems[index] || draftItems[index].banned) return;
  draftItems[index].banned = true;
  playSound('ban');
  triggerHaptic('heavy');

  const remaining = draftItems.filter(item => !item.banned);
  if (remaining.length > 1) {
    draftTurn = draftTurn === 1 ? 2 : 1;
  }
  renderDraftGrid();

  if (remoteRoomId && myPlayerNum === 1) {
    sendP2PMessage({ type: 'DRAFT_STATE', draftItems, draftTurn });
  }

  if (remaining.length === 1) {
    const winner = remaining[0];
    window.currentWinner = winner;
    const votingModal = getEl('votingModal');
    if (votingModal) votingModal.classList.remove('show');
    showModal('Winner by Elimination!', winner.title, winner.detail);
  }
}

function banItem(index) {
  if (remoteRoomId) {
    if (String(myPlayerNum) !== String(draftTurn)) {
      showToast(`It is currently Player ${draftTurn}'s turn to ban!`);
      return;
    }
    if (myPlayerNum === 2) {
      sendP2PMessage({ type: 'BAN_REQUEST', index });
      return;
    }
  }
  executeBan(index);
}

function surpriseMe() {
  let pool = [...activeDeck];
  const surpriseModeEl = getEl('surpriseMode');
  const mode = surpriseModeEl ? surpriseModeEl.value : 'all';
  if (mode === 'new') {
    pool = pool.filter(item => !dateHistory.some(entry => entry.cardId === item.id || (!entry.cardId && entry.title === item.title)));
  }
  if (!pool.length) {
    window.currentWinner = null;
    showModal('No Matching Dates', 'Try selecting more packs', 'There are no ideas matching your active filters that have not already been completed.');
    return;
  }
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  window.currentWinner = chosen;
  showModal('Your Surprise Date', chosen.title, chosen.detail);
}

function renderLibrary() {
  const librarySearchEl = getEl('librarySearch');
  const libraryCategoryEl = getEl('libraryCategory');
  const query = librarySearchEl ? librarySearchEl.value.trim().toLowerCase() : '';
  const category = libraryCategoryEl ? libraryCategoryEl.value : 'all';
  const list = getEl('libraryList');
  const summary = getEl('librarySummary');
  if (!list) return;
  const items = fullDeck.filter(item =>
    (category === 'all' || item.category === category) &&
    (!query || `${item.title} ${item.detail}`.toLowerCase().includes(query))
  );
  if (summary) summary.textContent = `${fullDeck.length} total ideas · Showing ${items.length}`;
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'library-summary';
    empty.textContent = 'No ideas match your search.';
    list.appendChild(empty);
    return;
  }
  items.forEach(item => {
    const card = document.createElement('article');
    card.className = 'library-item';
    const categoryEl = document.createElement('div');
    categoryEl.className = 'library-category';
    categoryEl.textContent = `${item.category} · Location: ${item.location || 'either'}`;
    const titleEl = document.createElement('div');
    titleEl.className = 'library-title';
    titleEl.textContent = item.title;
    const detailEl = document.createElement('div');
    detailEl.className = 'library-detail';
    detailEl.textContent = item.detail;
    card.append(categoryEl, titleEl, detailEl);
    list.appendChild(card);
  });
}

function renderTracker() {
  const label = getEl('dateGoalStatus');
  const bar = getEl('dateGoalBar');
  const progress = getEl('dateGoalProgress');
  if (!bar || !label) return;

  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const count = dateHistory.filter(entry => new Date(entry.date) >= startOfWeek).length;
  const percent = Math.min(100, count * 100);
  label.textContent = `${count} / 1 Done`;
  bar.style.width = `${percent}%`;
  if (progress) progress.setAttribute('aria-valuenow', String(percent));
}

function renderAnalyticsDashboard() {
  const dashboard = getEl('analyticsDashboard');
  if (!dashboard) return;
  dashboard.replaceChildren();
  if (!dateHistory.length) return;
  const ratings = [];
  dateHistory.forEach(entry => [entry.rating1, entry.rating2].forEach(value => {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 1 && n <= 5) ratings.push(n);
  }));
  const average = ratings.length ? (ratings.reduce((sum, n) => sum + n, 0) / ratings.length).toFixed(1) : '—';
  const card = document.createElement('div');
  card.className = 'stats-card';
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  const completed = document.createElement('div');
  completed.className = 'stat-box';
  completed.innerHTML = `<div class="val">${dateHistory.length}</div><div class="lbl">Completed</div>`;
  const rating = document.createElement('div');
  rating.className = 'stat-box';
  rating.innerHTML = `<div class="val">${escapeHtml(average === '—' ? average : `⭐ ${average}`)}</div><div class="lbl">Average rating</div>`;
  grid.append(completed, rating);
  card.appendChild(grid);
  dashboard.appendChild(card);
}

function renderHistory() {
  renderAnalyticsDashboard();
  renderTracker();
  const list = getEl('historyList');
  const stats = getEl('historyStats');
  if (!list) return;
  if (stats) stats.textContent = `${dateHistory.length} completed dates in scrapbook`;
  list.replaceChildren();
  if (!dateHistory.length) {
    const empty = document.createElement('div');
    empty.className = 'library-summary';
    empty.textContent = 'No dates logged yet. Complete a date to build your scrapbook!';
    list.appendChild(empty);
    return;
  }
  dateHistory.forEach(entry => {
    const row = document.createElement('article');
    row.className = 'library-item';
    const category = document.createElement('div');
    category.className = 'library-category';
    const date = new Date(entry.date);
    category.textContent = `${entry.category || 'Date'} · ${Number.isNaN(date.getTime()) ? 'Date unknown' : date.toLocaleDateString()}`;
    const title = document.createElement('div');
    title.className = 'library-title';
    title.textContent = entry.title || 'Untitled date';
    const detail = document.createElement('div');
    detail.className = 'library-detail';
    const ratingText = entry.rating1 || entry.rating2 ? `Ratings: ${entry.rating1 ?? '—'}/5 & ${entry.rating2 ?? '—'}/5` : '';
    detail.textContent = [entry.note || entry.detail || '', ratingText].filter(Boolean).join(' · ');
    const actions = document.createElement('div');
    actions.className = 'history-entry-actions';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'history-edit-btn';
    editButton.textContent = 'Edit';
    editButton.setAttribute('aria-label', `Edit scrapbook entry ${entry.title || 'Untitled date'}`);
    editButton.addEventListener('click', () => editHistoryEntry(entry.syncId));
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'history-delete-btn';
    deleteButton.textContent = 'Delete';
    deleteButton.setAttribute('aria-label', `Delete scrapbook entry ${entry.title || 'Untitled date'}`);
    deleteButton.addEventListener('click', () => deleteHistoryEntry(entry.syncId));
    actions.append(editButton, deleteButton);
    row.append(category, title, detail, actions);
    list.appendChild(row);
  });
}

async function persistHistoryEntry(entry, broadcast = false) {
  const normalized = sanitizeHistoryEntry(entry);
  if (!normalized) return null;

  const syncId = normalized.syncId;
  const existing = dateHistory.find(record => record.syncId === syncId);
  if (existing) return existing;

  let saved = normalized;

  if (storageFailed) {
    showToast('Storage failure: Your scrapbook entry cannot be saved to disk.');
    return null;
  }

  if (db) {
    try {
      const insertedId = await db.history.add(normalized);
      saved = await db.history.get(insertedId) || normalized;
    } catch (err) {
      console.warn('Could not persist to IndexedDB:', err);
      showToast('Storage error: Entry was not saved to disk.');
      return null;
    }
  }

  dateHistory = [saved, ...dateHistory.filter(item => item.syncId !== saved.syncId)]
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  renderHistory();

  if (broadcast && remoteRoomId && myPlayerNum === 1) {
    sendP2PMessage({ type: 'HISTORY_ENTRY', entry: saved });
  }

  return saved;
}

async function editHistoryEntry(syncId) {
  const entry = dateHistory.find(record => record.syncId === syncId);
  if (!entry) { showToast('That scrapbook entry could not be found.'); return; }
  const nextTitle = window.prompt('Edit date title:', entry.title || 'Untitled date');
  if (nextTitle === null) return;
  const nextNote = window.prompt('Edit memory note:', entry.note || '');
  if (nextNote === null) return;
  const updated = { ...entry, title: limitText(nextTitle, 160) || 'Untitled date', note: limitText(nextNote, 2000) };
  try {
    if (!storageFailed && db) {
      const stored = (await db.history.toArray()).find(record => record.syncId === syncId);
      if (stored && stored.id !== undefined) await db.history.put({ ...stored, ...updated });
    }
    dateHistory = dateHistory.map(record => record.syncId === syncId ? updated : record);
    renderHistory();
    showToast('Scrapbook entry updated.');
  } catch (error) {
    console.error('Scrapbook edit failed:', error);
    showToast('Could not save this edit.');
  }
}

async function deleteHistoryEntry(syncId) {
  const entry = dateHistory.find(record => record.syncId === syncId);
  if (!entry) return;
  showConfirmModal('Delete Scrapbook Entry?', `Delete “${entry.title || 'Untitled date'}” from your scrapbook? This cannot be undone.`, 'Scrapbook', async () => {
    try {
      if (!storageFailed && db) {
        const matches = (await db.history.toArray()).filter(record => record.syncId === syncId);
        for (const record of matches) {
          if (record.id !== undefined) await db.history.delete(record.id);
        }
      }
      dateHistory = dateHistory.filter(record => record.syncId !== syncId);
      renderHistory();
      showToast('Scrapbook entry deleted.');
    } catch (error) {
      console.error('Scrapbook deletion failed:', error);
      showToast('Could not delete this scrapbook entry.');
    }
  });
}

async function receiveHistoryEntry(entry) {
  const normalized = sanitizeHistoryEntry(entry);
  if (!normalized) return null;
  if (dateHistory.some(record => record.syncId === normalized.syncId)) return null;
  return persistHistoryEntry(normalized, false);
}

async function applyTheme(theme) {
  appSettings.theme = ['dark', 'ocean'].includes(theme) ? theme : 'dark';
  document.documentElement.dataset.theme = appSettings.theme === 'dark' ? '' : appSettings.theme;
  const select = getEl('themeSelect');
  if (select) select.value = appSettings.theme;
  if (!storageFailed && db) {
    try { await db.settings.put({ key: 'appSettings', value: appSettings }); }
    catch (err) { console.error('Could not save theme:', err); }
  }
}

async function saveFeedbackSettings(value) {
  appSettings.feedback = ['both', 'sound', 'vibration', 'off'].includes(value) ? value : 'both';
  if (!storageFailed && db) {
    try { await db.settings.put({ key: 'appSettings', value: appSettings }); }
    catch (err) { console.error('Could not save feedback preference:', err); }
  }
}

async function shareCurrentDate() {
  const item = window.currentWinner;
  if (!item) { showToast('Choose a date idea first.'); return; }
  const text = `💞 Date Night Decider: ${item.title}\n${item.detail}`;

  const res = await window.DeviceAdapter.shareText('Date Night Decider', text, window.location.href);
  if (res.success) {
    if (res.method === 'clipboard') showToast('Date idea copied to clipboard!');
    else showToast('Shared: ' + item.title);
  } else {
    showToast('Shared: ' + item.title);
  }
}

function openCurrentCardMap() {
  const item = window.currentWinner;
  if (!item) return;
  if (item.location !== 'out') {
    showToast('This is an at-home date; no map is needed. Check the date instructions.');
    return;
  }
  const query = `${item.title} near me`;
  window.open(
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
    '_blank',
    'noopener,noreferrer'
  );
}

function startSelectedDate() {
  const item = window.currentWinner;
  if (!item) return;
  showToast(`Starting date: ${item.title}! Have a wonderful time.`);
  if (item.location === 'out') {
    openCurrentCardMap();
  } else {
    showToast('At-home date selected—no map will be opened.');
  }
}

async function exportBackup() {
  const data = {
    version: "3.4.3-hotfix8",
    deletedBuiltins: [...deletedBuiltins],
    dateHistory,
    settings: appSettings,
    selectedPacks: [...selectedPacks],
    selectedCategories: [...document.querySelectorAll(".category-choice:checked")].map(input => input.value)
  };
  const backupText = JSON.stringify(data, null, 2);

  try {
    const capacitor = window.Capacitor;
    if (capacitor && typeof capacitor.isNativePlatform === "function" && capacitor.isNativePlatform()) {
      if (
        typeof capacitor.isPluginAvailable === "function" &&
        !capacitor.isPluginAvailable("FileSharer")
      ) {
        throw new Error("Native file-save plugin is unavailable. Sync and rebuild Android.");
      }

      const plugins = capacitor.Plugins || {};
      const fileSharer = window.__DND_BACKUP_FILESHARER__ ||
        plugins.FileSharer ||
        (typeof capacitor.registerPlugin === "function"
          ? capacitor.registerPlugin("FileSharer")
          : null);

      if (!fileSharer || typeof fileSharer.save !== "function") {
        throw new Error("Native file-save API is unavailable.");
      }

      const bytes = new TextEncoder().encode(backupText);
      let binary = "";
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
      }

      const saved = await fileSharer.save({
        filename: "date-night-backup.json",
        contentType: "application/json",
        base64Data: btoa(binary),
        android: {
          saveDirectory: "downloads",
          relativePath: "Download/Date Night Decider"
        }
      });

      if (!saved) {
        throw new Error("The file-save plugin did not confirm a save.");
      }

      showToast("Backup saved to Downloads/Date Night Decider/date-night-backup.json.");
      return;
    }

    const blob = new Blob([backupText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "date-night-backup.json";
    document.body.appendChild(anchor);

    try {
      anchor.click();
      showToast("Backup download requested.");
    } finally {
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  } catch (error) {
    console.error("Backup export failed:", error);
    showToast("Backup export failed. Please try again.");
  }
}

function importBackupFile(event) {
  const file = event && event.target && event.target.files ? event.target.files[0] : null;
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    showToast('Backup file is too large. Choose a JSON backup no larger than 10 MB.');
    event.target.value = '';
    return;
  }

  const reader = new FileReader();

  reader.onload = async () => {
    try {
      const data = JSON.parse(String(reader.result || ''));
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Backup must be a JSON object.');
      }
      if (typeof data.version !== 'string' || !Array.isArray(data.dateHistory)) {
        throw new Error('Invalid or unsupported backup file structure/version.');
      }

      const importedSettings = {
        theme: ['dark', 'ocean'].includes(data.settings?.theme) ? data.settings.theme : appSettings.theme,
        feedback: ['both', 'sound', 'vibration', 'off'].includes(data.settings?.feedback) ? data.settings.feedback : appSettings.feedback
      };

      const seenHistorySyncIds = new Set();
      const importedHistory = data.dateHistory
        .slice(0, 5000)
        .map(sanitizeHistoryEntry)
        .filter(entry => {
          if (!entry || seenHistorySyncIds.has(entry.syncId)) return false;
          seenHistorySyncIds.add(entry.syncId);
          return true;
        })
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      const importedUnlocks = [...new Set(unlockedItems.filter(id => typeof id === 'string' && window.expansionDecks && window.expansionDecks[id]))];
      const requestedPacks = Array.isArray(data.selectedPacks) ? data.selectedPacks : ['starter', ...importedUnlocks];
      const importedPacks = [...new Set(requestedPacks.filter(id => id === 'starter' || importedUnlocks.includes(id)))];

      const knownCardIds = new Set([
        ...masterDeck,
        ...(window.expansionDecks ? Object.values(window.expansionDecks).flat() : [])
      ].map(card => card.id));

      const importedDeleted = [...new Set(
        (Array.isArray(data.deletedBuiltins) ? data.deletedBuiltins : [...deletedBuiltins])
          .filter(id => typeof id === 'string' && knownCardIds.has(id))
      )];

      const importedCategories = [...new Set(
        (Array.isArray(data.selectedCategories) ? data.selectedCategories : selectedCategories)
          .filter(value => typeof value === 'string' && DEFAULT_CATEGORIES.includes(value))
      )];

      if (!storageFailed && db) {
        await window.DNDStorage.withDatabaseTransaction(
          [
            db.settings,
            db.customDeck,
            db.deletedBuiltins,
            db.categories,
            db.history,
            db.unlocks
          ],
          async () => {
            await db.settings.clear();
            await db.settings.put({ key: 'appSettings', value: importedSettings });
            await db.settings.put({ key: 'selectedPacks', value: importedPacks });
            await db.customDeck.clear();
            await db.deletedBuiltins.clear();
            if (importedDeleted.length) {
              await db.deletedBuiltins.bulkPut(importedDeleted.map(id => ({ id })));
            }
            await db.categories.clear();
            await db.categories.put({ id: 'selectedCats', values: importedCategories });
            await db.history.clear();
            if (importedHistory.length) {
              await db.history.bulkAdd(importedHistory);
            }
            await db.unlocks.clear();
            if (importedUnlocks.length) {
              await db.unlocks.bulkPut(importedUnlocks.map(id => ({ id })));
            }
          }
        );
      }

      appSettings = importedSettings;
      dateHistory = importedHistory;
      unlockedItems = importedUnlocks;
      selectedPacks = importedPacks;
      deletedBuiltins = new Set(importedDeleted);
      selectedCategories = importedCategories;

      document.querySelectorAll('.category-choice').forEach(input => {
        input.checked = selectedCategories.includes(input.value);
      });

      renderPackChoices();
      refreshDecks();
      await applyTheme(appSettings.theme || 'dark');
      initMatcher();
      renderHistory();
      if (typeof renderStore === 'function') renderStore();
      renderLibrary();
      showToast('Backup restored successfully.');
    } catch (error) {
      console.error('Backup import failed:', error);
      showToast('Backup was not restored.');
    } finally {
      event.target.value = '';
    }
  };

  reader.readAsText(file);
}

async function clearAllData() {
  showConfirmModal('Clear Application Data?', 'This permanently clears local scrapbook entries, filters, theme, and feedback settings. Verified store purchases are not deleted and can be restored. This cannot be undone.', 'Danger Zone', async () => { await executeClearAllData(); });
}

function resetInMemoryAfterClear() {
  deletedBuiltins = new Set();
  dateHistory = [];
  window.currentWinner = null;
  selectedPreviewItemId = null;
  swipeLocked = false;
  document.querySelectorAll('.modal-overlay.show').forEach(modal => modal.classList.remove('show'));
  appSettings = { theme: 'dark', feedback: 'both' };
  selectedCategories = [...DEFAULT_CATEGORIES];
  savedSelectedPacksPreference = null;
  selectedPacks = ['starter', ...unlockedItems];
  activeDeck = [];
  fullDeck = [];
  p1Deck = [];
  p2Deck = [];
  p1Likes = [];
  p2Likes = [];
  swipeIndex = 0;
  swipePlayer = 1;
  draftItems = [];
  draftTurn = 1;
  p1Rating = 5;
  p2Rating = 5;
  document.querySelectorAll('.category-choice').forEach(input => { input.checked = true; });
  const budget = getEl('budgetFilter'); if (budget) budget.value = 'all';
  const feedback = getEl('feedbackSelect'); if (feedback) feedback.value = 'both';
  const theme = getEl('themeSelect'); if (theme) theme.value = 'dark';
}

async function executeClearAllData({ broadcast = true } = {}) {
  if (window.__dndClearDataInProgress) return;
  window.__dndClearDataInProgress = true;
  let fenceRequested = false;
  let resetCompleted = false;

  try {
    const storage = window.DNDStorage;
    if (!storage || typeof storage.clearPersistentStorage !== 'function') {
      throw new Error('The verified persistent-storage reset coordinator is unavailable.');
    }
    if (typeof window.beginP2PResetFence !== 'function' ||
        typeof window.releaseP2PResetFence !== 'function' ||
        typeof window.endLiveRoomGracefully !== 'function') {
      throw new Error('Required reset or live-room shutdown support is unavailable.');
    }

    // Stop new room activity first; persist the reset intent before awaiting
    // graceful room shutdown by running shutdown inside the coordinator hook.
    window.beginP2PResetFence();
    fenceRequested = true;

    const diagnostics = await storage.clearPersistentStorage({
      beforeClear: async () => {
        const roomEnd = await window.endLiveRoomGracefully('reset');
        if (roomEnd && roomEnd.notified && !roomEnd.acknowledged) {
          console.warn('Live-room shutdown was not acknowledged before reset; remote retry suppression is not confirmed.');
        }
      }
    });

    if (!diagnostics || diagnostics.resetCompleted !== true) {
      const reasons = Array.isArray(diagnostics && diagnostics.errors) ? diagnostics.errors.join(' ') : '';
      throw new Error('The persistent reset was not verified as complete. ' + reasons);
    }
    resetCompleted = true;

    if (broadcast && typeof dataResetChannel !== 'undefined' && dataResetChannel) {
      dataResetChannel.postMessage({ type: 'CLEAR_ALL_DATA' });
    }
    // Reload this tab too: rebuild in-memory state from the now-empty database
    // and re-check external purchase entitlements rather than keeping stale state.
    window.location.reload();
  } catch (err) {
    console.error('Failed to complete coordinated local-data reset:', err);
    showToast('Clear was not confirmed complete. If recovery is pending, the app will reload to retry it.');

    let pending = true;
    try {
      const storage = window.DNDStorage;
      pending = !storage ||
        typeof storage.hasPendingResetMarker !== 'function' ||
        storage.hasPendingResetMarker();
    } catch (_) {
      pending = true;
    }

    if (resetCompleted || pending) {
      window.setTimeout(() => window.location.reload(), 0);
      return;
    }

    if (fenceRequested) {
      window.releaseP2PResetFence();
    }
    window.__dndClearDataInProgress = false;
  }
}

function triggerConfetti() {
  const canvas = getEl('confettiCanvas');
  if (!canvas) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const particles = Array.from({ length: 50 }, () => ({
    x: width / 2, y: height / 2,
    vx: (Math.random() - 0.5) * 10,
    vy: (Math.random() - 0.5) * 10 - 2,
    color: ['#ff3b6c', '#f6c941', '#ffffff'][Math.floor(Math.random() * 3)],
    size: Math.random() * 5 + 3, life: 80
  }));
  function render() {
    context.clearRect(0, 0, width, height);
    let alive = false;
    particles.forEach(particle => {
      if (particle.life <= 0) return;
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.vy += 0.2;
      particle.life -= 1;
      alive = true;
      context.fillStyle = particle.color;
      context.fillRect(particle.x, particle.y, particle.size, particle.size);
    });
    if (alive) requestAnimationFrame(render);
    else context.clearRect(0, 0, width, height);
  }
  render();
}

function showModal(eyebrow, title, detail) {
  playSound('win');
  triggerHaptic('success');
  triggerConfetti();

  const ebEl = getEl('modalEyebrow'); if (ebEl) ebEl.textContent = eyebrow;
  const nameEl = getEl('modalIdeaName'); if (nameEl) nameEl.textContent = title || 'Date Idea';

  const winner = window.currentWinner;
  const detailEl = getEl('modalIdeaDetail');
  if (!detailEl) return;

  if (winner && (winner.mission || winner.howToPlay)) {
    let html = `<p style="margin-bottom:12px;font-weight:600;color:var(--cream);">${escapeHtml(winner.mission || detail)}</p>`;

    if (winner.duration || winner.costEstimate || winner.equipment) {
      html += `<div style="background:rgba(255,255,255,0.05);padding:10px;border-radius:10px;margin-bottom:12px;text-align:left;font-size:0.78rem;">`;
      if (winner.duration) html += `<div>⏱ <strong>Duration:</strong> ${escapeHtml(winner.duration)}</div>`;
      if (winner.costEstimate) html += `<div>💵 <strong>Estimated Cost:</strong> ${escapeHtml(winner.costEstimate)}</div>`;
      if (winner.equipment) html += `<div>🧰 <strong>Needs:</strong> ${escapeHtml(Array.isArray(winner.equipment) ? winner.equipment.join(', ') : winner.equipment)}</div>`;
      html += `</div>`;
    }

    if (Array.isArray(winner.howToPlay) && winner.howToPlay.length) {
      html += `<div style="text-align:left;margin-bottom:12px;"><strong style="color:var(--gold);font-size:0.8rem;text-transform:uppercase;">🎮 Instructions</strong><ol style="margin-left:18px;font-size:0.78rem;color:var(--muted);margin-top:4px;">`;
      winner.howToPlay.forEach(step => { html += `<li>${escapeHtml(step)}</li>`; });
      html += `</ol></div>`;
    }

    if (winner.importantRule) {
      html += `<div style="text-align:left;font-size:0.75rem;color:#f87171;"><strong style="color:#ef4444;">❤️ Important Rule:</strong> ${escapeHtml(winner.importantRule)}</div>`;
    }

    detailEl.innerHTML = html;
  } else {
    detailEl.textContent = detail || '';
  }

  const mapButton = getEl('mapDirectionsBtn');
  if (mapButton) mapButton.style.display = winner && winner.location === 'out' ? 'block' : 'none';

  const completeButton = getEl('completeDateBtn');
  if (completeButton) completeButton.disabled = !winner;

  const decisionModal = getEl('decisionModal');
  if (decisionModal) decisionModal.classList.add('show');
  if (typeof saveHostRoomSessionState === 'function') saveHostRoomSessionState();
}

function resetRemoteRound() {
  p1Deck = shuffle(activeDeck);
  p2Deck = [...p1Deck];
  p1Likes = [];
  p2Likes = [];
  swipeIndex = 0;
  swipePlayer = 1;
  remoteSubmitSent = false;
  remotePartnerLikes = null;
  remoteGuestProgressLikes = [];
  remoteGuestSwipeIndex = 0;
  remoteMatchResolved = false;
  window.currentWinner = null;
  draftItems = [];
  draftTurn = 1;
  updateSwipeCard();
}

function closeModal() {
  const decisionModal = getEl('decisionModal');
  if (decisionModal) decisionModal.classList.remove('show');
  if (remoteRoomId) {
    if (myPlayerNum === 1) {
      window.currentWinner = null;
      resetRemoteRound();
      sendRoomState();
      if (conn && conn.open) {
        sendP2PMessage({ type: 'NEW_ROUND' });
      }
    }
  } else {
    initMatcher();
  }
}

function validRating(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

async function completeCurrentDate() {
  const item = window.currentWinner;
  if (!item) { closeModal(); return; }

  setRating(1, validRating(p1Rating) || 5);
  setRating(2, validRating(p2Rating) || 5);

  const noteInput = getEl('logDateNoteInput');
  if (noteInput) noteInput.value = '';

  const titleEl = getEl('logDateItemTitle');
  if (titleEl) titleEl.textContent = item.title || 'Untitled date';

  const modal = getEl('logDateModal');
  if (modal) modal.classList.add('show');
}

function downloadCalendarEvent() {
  const item = window.currentWinner;
  if (!item) { showToast('Choose a date idea first.'); return; }

  const dateInput = getEl('calendarDateInput');
  if (dateInput) {
    const today = new Date();
    const defaultDateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    dateInput.value = defaultDateStr;
  }
  const modal = getEl('calendarModal');
  if (modal) modal.classList.add('show');
}

async function loadAppData() {
  try {
    if (!storageFailed && db) {
      const settingsRecord = await db.settings.get('appSettings');
      if (settingsRecord?.value && typeof settingsRecord.value === 'object') {
        appSettings = {
          theme: ['dark', 'ocean'].includes(settingsRecord.value.theme) ? settingsRecord.value.theme : 'dark',
          feedback: ['both', 'sound', 'vibration', 'off'].includes(settingsRecord.value.feedback) ? settingsRecord.value.feedback : 'both'
        };
      }

      const deletedRecords = await db.deletedBuiltins.toArray();
      deletedBuiltins = new Set(deletedRecords.map(record => record.id));
      dateHistory = (await db.history.orderBy('date').reverse().toArray())
        .map(sanitizeHistoryEntry)
        .filter(Boolean);

      const selectedPacksRecord = await db.settings.get('selectedPacks');
      savedSelectedPacksPreference = Array.isArray(selectedPacksRecord?.value)
        ? [...new Set(selectedPacksRecord.value.filter(id => id === 'starter' || (window.expansionDecks && Object.prototype.hasOwnProperty.call(window.expansionDecks, id))))]
        : null;
      selectedPacks = Array.isArray(savedSelectedPacksPreference)
        ? [...new Set(savedSelectedPacksPreference.filter(id => id === 'starter'))]
        : ['starter'];

      const categoryRecord = await db.categories.get('selectedCats');
      selectedCategories = Array.isArray(categoryRecord?.values)
        ? categoryRecord.values.filter(value => DEFAULT_CATEGORIES.includes(value))
        : [...DEFAULT_CATEGORIES];
    }
  } catch (error) {
    console.warn('Saved data could not be loaded from IndexedDB:', error);
  }

  document.querySelectorAll('.category-choice').forEach(input => {
    input.checked = selectedCategories.includes(input.value);
  });
  const feedbackSelect = getEl('feedbackSelect');
  if (feedbackSelect) feedbackSelect.value = appSettings.feedback;

  renderPackChoices();
  refreshDecks();
  initMatcher();
  renderLibrary();
  renderHistory();
  if (typeof renderStore === 'function') renderStore();
  await applyTheme(appSettings.theme || 'dark');
  renderStorageWarning();

  if (typeof initializePurchases === 'function') {
    await initializePurchases();
  }

  if (window.DeviceAdapter) {
    await window.DeviceAdapter.hideSplashScreen();
  }

  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');

  if (roomParam) {
    window.setTimeout(() => {
      const code = normalizeRoomCode(roomParam);
      if (code) joinP2PServer(code);
    }, 500);
  } else {
    const savedGuestSession = readGuestRoomSession();
    if (savedGuestSession) {
      window.setTimeout(() => {
        joinP2PServer(savedGuestSession.roomCode);
      }, 700);
    } else {
      const savedHostSession = readHostRoomSession();
      if (savedHostSession) {
        window.setTimeout(() => {
          startP2PServer(savedHostSession.roomCode, savedHostSession, 0);
        }, 700);
      }
    }
  }
}

let dataResetChannel = null;
try {
  if ('BroadcastChannel' in window) {
    dataResetChannel = new BroadcastChannel('date-night-decider-data-events');
    dataResetChannel.addEventListener('message', async event => {
      if (!event.data || event.data.type !== 'CLEAR_ALL_DATA') return;
      await resetOtherTabAfterClear();
    });
  }
} catch (error) {
  console.warn('Cross-tab data reset notifications unavailable:', error);
}

async function resetOtherTabAfterClear() {
  // sessionStorage is tab-scoped: the originating tab cannot clear this tab's saved room.
  try { cleanupPeerConnection(); } catch (_) {}
  try {
    const storage = window.DNDStorage;
    if (!storage || typeof storage.clearCurrentTabSessionStorage !== 'function') {
      throw new Error('Per-tab session reset coordinator is unavailable.');
    }
    storage.clearCurrentTabSessionStorage();
  } catch (error) {
    // Keep this tab blocked. Startup generation checks will retry session cleanup on reload.
    renderStorageHardeningBlocker(error);
    return;
  }
  window.location.reload();
}

function handleIncomingInviteFromUrl() {
  const inviteUrl = new URL(window.location.href);
  const rawCode = inviteUrl.searchParams.get('room');
  if (!rawCode) return;

  inviteUrl.searchParams.delete('room');
  const nextUrl = inviteUrl.pathname + inviteUrl.search + inviteUrl.hash;
  window.history.replaceState(window.history.state, document.title, nextUrl);

  const code = normalizeRoomCode(rawCode).replace(/^datenight-/, '');
  if (code.length < 12) {
    showToast('This invitation link contains an invalid room code.');
    return;
  }

  const joinInput = getEl('joinCodeInput');
  if (joinInput) joinInput.value = code;
  switchLiveRoomTab('join');

  const modal = getEl('liveRoomModal');
  if (modal) modal.classList.add('show');
  showToast('Invitation detected. Review code and tap Connect.');
}

function renderStorageHardeningBlocker(error) {
  console.error('Date Night Decider startup blocked by storage recovery:', error);
  if (!document.body) return;

  let banner = document.getElementById('storageHardeningBlocker');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'storageHardeningBlocker';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = 'position:relative;z-index:2147483647;margin:16px;padding:16px;border:2px solid #b91c1c;border-radius:12px;background:#450a0a;color:#fff;font:16px/1.5 sans-serif;';
    document.body.insertBefore(banner, document.body.firstChild);
  }
  banner.textContent = 'Date Night Decider has blocked startup because database recovery could not be verified. Do not continue editing. Resolve the storage problem and reload. Details: ' + String(error && error.message || error || 'Unknown storage error');
  document.querySelectorAll('button, input, select, textarea').forEach(control => { control.disabled = true; });
  document.addEventListener('click', event => {
    if (!banner.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('keydown', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

async function initializeStorageAndLoad() {
  if (window.dbReady && typeof window.dbReady.then === 'function') {
    await window.dbReady;
  }
  const storage = window.DNDStorage;
  if (!storage || typeof storage.captureCurrentGeneration !== 'function' ||
      typeof storage.hasPendingResetMarker !== 'function') {
    throw new Error('The database storage-hardening API is unavailable.');
  }

  if (storage.hasPendingResetMarker()) {
    const recovery = await storage.clearPersistentStorage();
    if (!recovery || recovery.resetCompleted !== true) {
      const reasons = Array.isArray(recovery && recovery.errors) ? recovery.errors.join(' ') : '';
      throw new Error('Interrupted reset recovery did not complete. ' + reasons);
    }
  }

  // Capture the durable generation before loading state or allowing normal writes.
  const currentGeneration = storage.captureCurrentGeneration();

  // sessionStorage is per-tab and survives a page reload. If this tab belongs to
  // an older reset generation (or predates this guard), clear old room/session keys
  // before loadAppData can attempt an automatic P2P reconnect.
  const sessionGenerationKey = 'dnd_session_state_generation';
  let priorSessionGeneration;
  try {
    priorSessionGeneration = sessionStorage.getItem(sessionGenerationKey);
  } catch (error) {
    throw new Error('Per-tab session state could not be verified: ' + (error.message || error));
  }
  if (priorSessionGeneration !== String(currentGeneration)) {
    storage.clearCurrentTabSessionStorage();
  }
  try {
    sessionStorage.setItem(sessionGenerationKey, String(currentGeneration));
    if (sessionStorage.getItem(sessionGenerationKey) !== String(currentGeneration)) {
      throw new Error('Session generation verification failed.');
    }
  } catch (error) {
    throw new Error('Per-tab session generation could not be recorded: ' + (error.message || error));
  }

  await loadAppData();
  await handleIncomingInviteFromUrl();
}

function initializeApp() {
  if (typeof installDelegatedActions === 'function') installDelegatedActions();
  if (typeof installModalAccessibility === 'function') installModalAccessibility();
  installSwipeGestures();
  renderStorageWarning();

  if (window.DeviceAdapter) {
    window.DeviceAdapter.registerBackButtonHandler(() => {
      const openModals = document.querySelectorAll('.modal-overlay.show');
      if (openModals.length) {
        openModals.forEach(m => m.classList.remove('show'));
      }
    });
  }

  window.addEventListener('pointerdown', unlockAudioAfterGesture, { once: true, passive: true });
  window.addEventListener('keydown', unlockAudioAfterGesture, { once: true });

  const swipeCard = getEl('swipeCard');
  swipeCard?.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); handleSwipe(false); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); handleSwipe(true); }
  });

  const categoryPicker = getEl('categoryPicker');
  const categorySummary = getEl('categorySummary');
  if (categoryPicker && categorySummary) {
    const syncExpandedState = () => categorySummary.setAttribute('aria-expanded', String(categoryPicker.open));
    categoryPicker.addEventListener('toggle', syncExpandedState);
    syncExpandedState();
  }
  initializeStorageAndLoad()
    .catch(renderStorageHardeningBlocker);
}

if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', initializeApp, { once: true });
else initializeApp();

function registerServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./service-worker.js?v=3.4.3-hotfix8').catch(error => console.warn('Service worker registration failed:', error));
  }
}
if (document.readyState === 'complete') registerServiceWorker();
else window.addEventListener('load', registerServiceWorker, { once: true });

let p1Rating = 5, p2Rating = 5;

function setRating(player, val) {
  if (player === 1) {
    p1Rating = val;
    const label = getEl('p1RatingVal'); if (label) label.textContent = String(val);
    const container = getEl('p1StarRating');
    if (container) {
      container.querySelectorAll('.star-btn').forEach((btn, idx) => {
        btn.classList.toggle('active', idx < val);
      });
    }
  } else if (player === 2) {
    p2Rating = val;
    const label = getEl('p2RatingVal'); if (label) label.textContent = String(val);
    const container = getEl('p2StarRating');
    if (container) {
      container.querySelectorAll('.star-btn').forEach((btn, idx) => {
        btn.classList.toggle('active', idx < val);
      });
    }
  }
}

function closeLogDateModal() {
  const modal = getEl('logDateModal');
  if (modal) modal.classList.remove('show');
}

async function saveLoggedDate() {
  const item = window.currentWinner;
  if (!item) { closeLogDateModal(); return; }

  const noteInput = getEl('logDateNoteInput');
  const note = noteInput ? limitText(noteInput.value, 2000) : '';

  const entry = sanitizeHistoryEntry({
    syncId: createUniqueId(),
    cardId: item.id || null,
    title: item.title || 'Untitled date',
    category: item.category || 'Date',
    detail: item.detail || '',
    date: new Date().toISOString(),
    rating1: p1Rating,
    rating2: p2Rating,
    note
  });

  if (!entry) {
    showToast('This date entry could not be validated.');
    return;
  }

  closeLogDateModal();

  try {
    if (remoteRoomId && myPlayerNum === 2) {
      if (!conn || !conn.open) {
        await persistHistoryEntry(entry, false);
        closeModal();
        showToast('Saved on this device only (offline).');
        return;
      }
      pendingCompleteEntry = entry;
      const sent = sendP2PMessage({ type: 'COMPLETE_DATE_REQUEST', entry });
      if (!sent) {
        pendingCompleteEntry = null;
        await persistHistoryEntry(entry, false);
        closeModal();
        showToast('Saved on this device only.');
        return;
      }
      const completeButton = getEl('completeDateBtn');
      if (completeButton) completeButton.disabled = true;
      showToast('Waiting for host confirmation...');
      return;
    }

    const saved = await persistHistoryEntry(entry, true);
    if (saved) {
      closeModal();
      showToast('Date saved to scrapbook! ⭐');
    }
  } catch (error) {
    console.error('Could not save completed date:', error);
    showToast('The date could not be saved.');
  }
}

function closeCalendarModal() {
  const modal = getEl('calendarModal');
  if (modal) modal.classList.remove('show');
}

function generateAndDownloadCalendar() {
  const item = window.currentWinner;
  if (!item) { closeCalendarModal(); return; }

  const dateInput = getEl('calendarDateInput');
  const timeInput = getEl('calendarTimeInput');
  const userDate = dateInput ? dateInput.value : '';
  const userTime = timeInput ? timeInput.value : '19:00';

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(userDate);
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(userTime);

  if (!dateMatch || !timeMatch) {
    showToast('Select a valid date and start time.');
    return;
  }

  const start = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), Number(timeMatch[1]), Number(timeMatch[2]));
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const formatUtc = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const icsEscape = val => String(val || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Date Night Decider//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${createUniqueId()}@datenightdecider`, `DTSTAMP:${formatUtc(new Date())}`,
    `SUMMARY:${icsEscape(`Date: ${item.title}`)}`, `DESCRIPTION:${icsEscape(item.detail)}`,
    `DTSTART:${formatUtc(start)}`, `DTEND:${formatUtc(end)}`, 'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');

  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'date-night.ics';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  closeCalendarModal();
  showToast('Calendar event downloaded!');
}

function openLiveRoomModal(initialTab = 'host') {
  switchLiveRoomTab(initialTab);
  if (initialTab === 'host') {
    generateNewHostCode();
  }
  const modal = getEl('liveRoomModal');
  if (modal) modal.classList.add('show');
}

function closeLiveRoomModal() {
  const modal = getEl('liveRoomModal');
  if (modal) modal.classList.remove('show');
}

function switchLiveRoomTab(tab) {
  const tabHost = getEl('tabHostRoom');
  const tabJoin = getEl('tabJoinRoom');
  const secHost = getEl('hostRoomSection');
  const secJoin = getEl('joinRoomSection');

  if (tabHost && tabJoin && secHost && secJoin) {
    tabHost.classList.toggle('active', tab === 'host');
    tabJoin.classList.toggle('active', tab === 'join');
    secHost.style.display = tab === 'host' ? 'block' : 'none';
    secJoin.style.display = tab === 'join' ? 'block' : 'none';
  }
}

function generateNewHostCode() {
  const input = getEl('hostCodeInput');
  if (input) {
    input.value = generateRoomCode();
  }
}

function confirmStartHost() {
  const input = getEl('hostCodeInput');
  const code = input ? input.value : '';
  closeLiveRoomModal();
  startP2PServer(code);
}

function confirmJoinRoom() {
  const input = getEl('joinCodeInput');
  const code = input ? input.value.trim() : '';
  if (!code) {
    showToast('Please enter a room code.');
    return;
  }
  closeLiveRoomModal();
  joinP2PServer(code);
}

let onConfirmAction = null;

function showConfirmModal(title, message, badgeText = 'Confirmation', onConfirm = null) {
  const titleEl = getEl('confirmModalTitle'); if (titleEl) titleEl.textContent = title;
  const msgEl = getEl('confirmModalMessage'); if (msgEl) msgEl.textContent = message;
  const badgeEl = getEl('confirmModalBadge'); if (badgeEl) badgeEl.textContent = badgeText;
  onConfirmAction = onConfirm;
  const modal = getEl('confirmModal');
  if (modal) modal.classList.add('show');
}

function closeConfirmModal() {
  const modal = getEl('confirmModal');
  if (modal) modal.classList.remove('show');
  onConfirmAction = null;
}

function handleConfirmYes() {
  const action = onConfirmAction;
  closeConfirmModal();
  if (typeof action === 'function') action();
}

function openLegalModal(tab = 'privacy') {
  switchLegalTab(tab);
  const modal = getEl('legalModal');
  if (modal) modal.classList.add('show');
}

function closeLegalModal() {
  const modal = getEl('legalModal');
  if (modal) modal.classList.remove('show');
}

function switchLegalTab(tab) {
  const tabP = getEl('tabPrivacy');
  const tabS = getEl('tabSupport');
  const secP = getEl('legalPrivacyContent');
  const secS = getEl('legalSupportContent');

  if (tabP && tabS && secP && secS) {
    tabP.classList.toggle('active', tab === 'privacy');
    tabS.classList.toggle('active', tab === 'support');
    secP.style.display = tab === 'privacy' ? 'block' : 'none';
    secS.style.display = tab === 'support' ? 'block' : 'none';
  }
}
