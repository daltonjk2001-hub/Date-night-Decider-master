/* Date Night Decider v3.1.2 remediation · Native store / RevenueCat */
'use strict';
const Purchases = (() => {
  if (typeof window === 'undefined') return null;

  const capacitor = window.Capacitor;

  if (capacitor && typeof capacitor.registerPlugin === 'function') {
    try {
      return capacitor.registerPlugin('Purchases');
    } catch (error) {
      console.warn('Could not register RevenueCat Purchases plugin:', error);
    }
  }

  return (capacitor && capacitor.Plugins && capacitor.Plugins.Purchases) ||
    window.Purchases ||
    null;
})();

/* RevenueCat public SDK keys are intentionally placeholders; configure your own platform keys before release. */
const REVENUECAT_API_KEYS = {
  ios: 'appl_REPLACE_WITH_PUBLIC_REVENUECAT_IOS_SDK_KEY',
  android: 'goog_REPLACE_WITH_PUBLIC_REVENUECAT_ANDROID_SDK_KEY'
};
const ENTITLEMENT_IDS = {
  ALL_EXPANSIONS: 'unlocked_expansion_packs',
  'pack-viral': 'expansion_pack_viral',
  'pack-coop': 'expansion_pack_coop',
  'pack-sweet': 'expansion_pack_sweet',
  'pack-quest': 'expansion_pack_quest',
  'pack-arcade': 'expansion_pack_arcade'
};
const PRODUCT_IDS = {
  'pack-viral': 'com.datenightdecider.pack.viral',
  'pack-coop': 'com.datenightdecider.pack.coop',
  'pack-sweet': 'com.datenightdecider.pack.sweet',
  'pack-quest': 'com.datenightdecider.pack.quest',
  'pack-arcade': 'com.datenightdecider.pack.arcade'
};
let purchasesConfigured = false;
let purchasesStatus = 'Purchases are not configured for this build.';

const storeCatalog = [
  { id: 'pack-viral', title: 'Pack 1: Viral Micro-Adventures', type: 'deck', price: '$0.99', desc: 'Seven unusual little adventures that turn ordinary places, objects, and memories into a date.', gradient: 'linear-gradient(135deg, #31103f, #190a24)' },
  { id: 'pack-coop', title: 'Pack 2: Co-Op Worlds & Gaming Challenges', type: 'deck', price: '$0.99', desc: 'Seven cooperative challenges for couples who enjoy digital, tabletop, or creative building games.', gradient: 'linear-gradient(135deg, #064e3b, #022c22)' },
  { id: 'pack-sweet', title: 'Pack 3: Sweet Treat Showdown', type: 'deck', price: '$0.99', desc: 'Seven relaxed dessert challenges, from a complete cookie recipe to quick no-bake creations.', gradient: 'linear-gradient(135deg, #4a1525, #831843)' },
  { id: 'pack-quest', title: 'Pack 4: Around-Town Adventure Quest', type: 'deck', price: '$0.99', desc: 'Seven structured mini-outings with exact missions and free at-home alternatives.', gradient: 'linear-gradient(135deg, #1e293b, #0f172a)' },
  { id: 'pack-arcade', title: 'Pack 5: The Couples Challenge Arcade', type: 'deck', price: '$0.99', desc: 'Seven quick head-to-head or cooperative challenges with simple scoring and zero special equipment.', gradient: 'linear-gradient(135deg, #581c87, #3b0764)' }
];

const expansionDecks = {
  'pack-viral': [
    { id:'viral-01', title:'Three-Stop Photo Safari', detail:'Find three interesting public places nearby and take a photo at each stop.', category:'micro-adventure', budget:'free', location:'out', costEstimate:'Free', duration:'30–45 minutes', equipment:['Phone camera'], mission:'Capture a tiny photo story in three stops.', howToPlay:['Choose a safe, walkable public route with three stops.','At each stop, take one photo that fits a prompt chosen by your partner.','Share the three photos and name your mini photo story.'], atHomeAlternative:'Take a photo safari around your home or yard.', gradient:'linear-gradient(135deg, #0f766e, #164e63)' },
    { id:'viral-02', title:'One-Color Date', detail:'Choose a color and spend the date noticing or creating things that match it.', category:'micro-adventure', budget:'free', location:'home', costEstimate:'Free with what you have', duration:'20–40 minutes', equipment:['Optional phone camera'], mission:'Collect five things that match your chosen color.', howToPlay:['Each player secretly chooses a color; agree on one by a coin toss or quick vote.','Find five safe things that match it, indoors or on a walk.','Pick the most unexpected match and explain why you chose it.'], gradient:'linear-gradient(135deg, #0f766e, #134e4a)' },
    { id:'viral-03', title:'Memory Lane Soundtrack', detail:'Build a mini soundtrack from songs that remind you of different moments in your relationship.', category:'micro-adventure', budget:'free', location:'home', costEstimate:'Free if you have music access', duration:'30 minutes', equipment:['Music app or owned tracks'], mission:'Choose one song for a memory, one for today, and one for your future.', howToPlay:['Take turns naming a memory or moment.','Choose a song that fits it and explain the connection.','Finish by picking a song for an adventure you want to share.'], gradient:'linear-gradient(135deg, #0f766e, #115e59)' },
    { id:'viral-04', title:'Mystery Snack Tasting', detail:'Choose a few familiar snacks and rate them without seeing each other’s rankings.', category:'micro-adventure', budget:'paid', location:'home', costEstimate:'$3–$10 depending on snacks', duration:'20–30 minutes', equipment:['A few snacks','Plates'], mission:'Find your shared favorite and the most surprising flavor.', howToPlay:['Each person selects two or three snacks within the agreed budget.','Taste each one and privately rate it from 1 to 5.','Reveal ratings together and name the shared winner.'], importantRule:'Check allergies and dietary needs first; never use mystery ingredients.', gradient:'linear-gradient(135deg, #0f766e, #0c4a6e)' },
    { id:'viral-05', title:'Tiny Tourist Challenge', detail:'Act like tourists in a familiar area and discover one detail you have never noticed.', category:'micro-adventure', budget:'free', location:'out', costEstimate:'Free; optional treat cost', duration:'30–60 minutes', equipment:['Phone camera optional'], mission:'Find a landmark, a hidden detail, and a place you would bring a visitor.', howToPlay:['Choose a familiar public area.','Each player picks one thing to investigate or photograph.','Share what you noticed and choose one new favorite spot.'], atHomeAlternative:'Explore a room or part of your home you rarely pay attention to.', gradient:'linear-gradient(135deg, #0f766e, #164e63)' },
    { id:'viral-06', title:'No-Scroll Cozy Hour', detail:'Put phones away and invent a relaxed hour using only things already at home.', category:'micro-adventure', budget:'free', location:'home', costEstimate:'Free', duration:'60 minutes', equipment:['A timer optional'], mission:'Create an hour that feels different without buying anything.', howToPlay:['Each person suggests one cozy activity.','Choose a combination such as music, a puzzle, drawing, or a short walk.','Keep phones away except for emergencies and end by sharing the best moment.'], gradient:'linear-gradient(135deg, #0f766e, #134e4a)' },
    { id:'viral-07', title:'Future Postcard Exchange', detail:'Write a postcard-style note to each other from an imagined future trip or milestone.', category:'micro-adventure', budget:'free', location:'home', costEstimate:'Free with paper', duration:'20–30 minutes', equipment:['Paper','Pens'], mission:'Describe a future memory as if it already happened.', howToPlay:['Pick an imaginary destination or future milestone.','Write each other a short postcard with two details you hope to experience.','Read them aloud and choose one idea to make real someday.'], gradient:'linear-gradient(135deg, #0f766e, #134e4a)' }
  ],
  'pack-coop': [
    { id:'coop-01', title:'Co-Op Mission Marathon', detail:'Play a cooperative game and define three team goals before starting.', category:'gaming', budget:'free', location:'home', costEstimate:'Free using a game you own', duration:'30–60 minutes', equipment:['A cooperative video game'], mission:'Complete three team goals without blaming each other for mistakes.', howToPlay:['Choose a cooperative game you both can access.','Set three goals that fit one session.','Celebrate progress after each goal, even if you do not finish all of them.'], gradient:'linear-gradient(135deg, #064e3b, #022c22)' },
    { id:'coop-02', title:'Build-a-World Relay', detail:'Take turns adding to one shared build in a game or with blocks and household craft supplies.', category:'gaming', budget:'free', location:'home', costEstimate:'Free using owned games or supplies', duration:'30–45 minutes', equipment:['Building game, blocks, or craft supplies'], mission:'Build one place that combines both of your ideas.', howToPlay:['Player 1 adds the foundation and explains the idea.','Player 2 adds a new feature without removing the first idea.','Alternate turns until you have a shared creation.'], gradient:'linear-gradient(135deg, #064e3b, #14532d)' },
    { id:'coop-03', title:'Puzzle Partners', detail:'Choose a puzzle game or physical puzzle and solve it together under a relaxed time limit.', category:'gaming', budget:'free', location:'home', costEstimate:'Free using an owned puzzle or game', duration:'20–45 minutes', equipment:['Puzzle or puzzle game'], mission:'Solve one puzzle while explaining your thinking to each other.', howToPlay:['Pick a puzzle suited to both players.','Take turns proposing approaches; the other person gets to test the idea.','If you get stuck, allow one hint and keep going.'], gradient:'linear-gradient(135deg, #064e3b, #022c22)' },
    { id:'coop-04', title:'Co-Op Challenge Wheel', detail:'Write five small game challenges and randomly choose which one to attempt together.', category:'gaming', budget:'free', location:'home', costEstimate:'Free with a game you own', duration:'30 minutes', equipment:['A game you both can access','Paper optional'], mission:'Complete three randomly selected team challenges.', howToPlay:['Write five doable challenges for your chosen game.','Randomly pick one and attempt it as a team.','Repeat until you complete three or agree on a new challenge.'], gradient:'linear-gradient(135deg, #064e3b, #166534)' },
    { id:'coop-05', title:'Board Game Teach-Back', detail:'Choose a board game one of you knows and learn it by having the teacher explain only one step at a time.', category:'board games', budget:'free', location:'home', costEstimate:'Free using a game you own', duration:'30–60 minutes', equipment:['A board or card game'], mission:'Learn a game together without rushing through the rules.', howToPlay:['Choose a game you already own.','The experienced player explains the goal and first turn only.','Play a practice round, then add any remaining rules before the real game.'], gradient:'linear-gradient(135deg, #064e3b, #312e81)' },
    { id:'coop-06', title:'Two-Person Tabletop Campaign', detail:'Create a short, silly story using a tabletop game, cards, dice, or paper prompts.', category:'board games', budget:'free', location:'home', costEstimate:'Free with household materials', duration:'30–45 minutes', equipment:['Paper or cards','Dice optional'], mission:'Make a tiny story with a beginning, twist, and ending.', howToPlay:['Each person invents a character and one goal.','Take turns drawing a card or rolling a die to introduce a complication.','Work together to resolve the story in three scenes.'], gradient:'linear-gradient(135deg, #064e3b, #1e3a8a)' },
    { id:'coop-07', title:'Friendly Rematch League', detail:'Play three short rounds of a game and score the session on teamwork, creativity, and laughs—not just wins.', category:'board games', budget:'free', location:'home', costEstimate:'Free using an owned game', duration:'30–45 minutes', equipment:['A quick game'], mission:'Finish a three-round mini league and award playful titles.', howToPlay:['Choose a game that supports quick rounds.','After each round, give one point for teamwork, one for creativity, and one for the funniest moment.','Total the points and invent a silly award for each player.'], gradient:'linear-gradient(135deg, #064e3b, #312e81)' }
  ],
  'pack-sweet': [
    { id:'sweet-01', title:'Decorate-the-Same Dessert', detail:'Bake or buy a simple dessert base, then decorate two versions from the same set of toppings.', category:'baking', budget:'paid', location:'home', costEstimate:'$5–$12 depending on ingredients', duration:'30–60 minutes', equipment:['Cookies or cupcakes','Simple toppings'], mission:'Make two desserts that look totally different but share the same ingredients.', howToPlay:['Choose a dessert base and agree on toppings.','Decorate each other’s dessert or make one each.','Reveal them together and choose playful award categories.'], importantRule:'Check allergies and keep food preparation hygienic.', gradient:'linear-gradient(135deg, #4a1525, #831843)' },
    { id:'sweet-02', title:'Two-Flavor Cookie Test', detail:'Make one simple cookie dough and split it into two portions with different mix-ins.', category:'baking', budget:'paid', location:'home', costEstimate:'$6–$12 for ingredients', duration:'45–75 minutes', equipment:['Cookie ingredients','Mix-ins'], mission:'Test two flavor combinations and crown the shared favorite.', howToPlay:['Pick a basic cookie recipe.','Divide the dough and add a different mix-in to each half.','Bake safely, taste when cooled, and rate both flavors.'], importantRule:'Check dietary restrictions and follow the recipe’s baking instructions.', gradient:'linear-gradient(135deg, #4a1525, #9f1239)' },
    { id:'sweet-03', title:'No-Bake Sweet Creation', detail:'Create a no-bake dessert using ingredients you already have or choose within a set budget.', category:'baking', budget:'paid', location:'home', costEstimate:'$3–$10 depending on ingredients', duration:'20–35 minutes', equipment:['No-bake dessert ingredients'], mission:'Make a dessert that looks fancy without using the oven.', howToPlay:['Choose a safe no-bake recipe.','Divide tasks so both people contribute.','Plate the dessert and give it a restaurant-style name.'], importantRule:'Keep perishable ingredients refrigerated as needed.', gradient:'linear-gradient(135deg, #4a1525, #701a75)' },
    { id:'sweet-04', title:'Mystery Pantry Bake-Off', detail:'Choose three compatible ingredients from your pantry and use them to inspire a simple baked treat.', category:'baking', budget:'paid', location:'home', costEstimate:'$5–$15 depending on what you have', duration:'45–75 minutes', equipment:['Pantry ingredients','Baking tools'], mission:'Invent a flavor combination that still makes sense as dessert.', howToPlay:['Agree on a small ingredient budget and check what is available.','Choose three inspiration ingredients that work safely together.','Use a reliable recipe as the base and add your twist.'], importantRule:'Do not use unknown ingredients; check allergens and food safety.', gradient:'linear-gradient(135deg, #4a1525, #831843)' },
    { id:'sweet-05', title:'Dessert Plating Contest', detail:'Plate the same dessert in two different styles and present each like a restaurant special.', category:'baking', budget:'paid', location:'home', costEstimate:'$4–$12 depending on dessert', duration:'20–30 minutes', equipment:['Dessert','Plates','Optional fruit or sauce'], mission:'Make an everyday dessert look celebration-worthy.', howToPlay:['Pick one dessert.','Each person plates a portion in their own style.','Present the dish and judge creativity, neatness, and taste.'], gradient:'linear-gradient(135deg, #4a1525, #9f1239)' },
    { id:'sweet-06', title:'Sweet-and-Salty Pairing', detail:'Build a small tasting plate that contrasts sweet and salty flavors.', category:'baking', budget:'paid', location:'home', costEstimate:'$4–$10 depending on snacks', duration:'20–30 minutes', equipment:['A few sweet and salty snacks'], mission:'Find a pairing that tastes better together than separately.', howToPlay:['Choose three small sweet and salty combinations.','Taste each combination and discuss the contrast.','Pick a favorite and write down the winning pairing.'], importantRule:'Check allergies and dietary requirements before tasting.', gradient:'linear-gradient(135deg, #4a1525, #701a75)' },
    { id:'sweet-07', title:'Breakfast-for-Dessert Bake', detail:'Make a sweet breakfast-inspired treat together, such as cinnamon toast bites or baked fruit crumble.', category:'baking', budget:'paid', location:'home', costEstimate:'$5–$12 for ingredients', duration:'30–60 minutes', equipment:['Simple baking ingredients','Oven-safe dish if needed'], mission:'Turn a familiar breakfast flavor into a cozy dessert.', howToPlay:['Choose a recipe that matches your time and equipment.','Split preparation tasks and prepare the treat together.','Serve it as dessert and name your creation.'], importantRule:'Use oven mitts and follow safe cooking temperatures.', gradient:'linear-gradient(135deg, #4a1525, #831843)' }
  ],
  'pack-quest': [
    { id:'questpack-01', title:'Three-Clue Destination Quest', detail:'One partner creates three clues leading to a safe public destination; the other solves them along the way.', category:'quest', budget:'free', location:'out', costEstimate:'Free; optional snack cost', duration:'30–60 minutes', equipment:['Paper or phone notes'], mission:'Reach a destination by solving three simple clues.', howToPlay:['Choose a familiar public route and a safe destination.','Write three clues based on public landmarks.','Take turns solving each clue before moving on.'], importantRule:'Do not trespass or use clues that require unsafe travel.', gradient:'linear-gradient(135deg, #1e293b, #0f172a)' },
    { id:'questpack-02', title:'Local Landmark Bingo', detail:'Make a short bingo card of visible things you might notice during a neighborhood walk.', category:'quest', budget:'free', location:'out', costEstimate:'Free', duration:'30–45 minutes', equipment:['Paper or phone notes'], mission:'Spot five bingo items during a walk together.', howToPlay:['Write nine things visible from public areas, such as a mural, a red door, or a bird.','Walk a safe route and mark each item you spot.','First to five wins, or complete the whole card as a team.'], importantRule:'Stay aware of traffic and surroundings while walking.', gradient:'linear-gradient(135deg, #1e293b, #1d4ed8)' },
    { id:'questpack-03', title:'At-Home Escape Clues', detail:'Build a mini escape-room chain with clues hidden around one room.', category:'quest', budget:'free', location:'home', costEstimate:'Free with household items', duration:'20–40 minutes', equipment:['Paper','Pens','Household objects'], mission:'Solve three linked clues to reveal a final message.', howToPlay:['Choose a final answer or message.','Write three clues that lead to it and place them in ordinary, safe spots.','Let your partner solve the clues, then switch roles.'], importantRule:'Do not lock doors or hide anything near hazards.', gradient:'linear-gradient(135deg, #1e293b, #312e81)' },
    { id:'questpack-04', title:'Secret Compliment Trail', detail:'Leave a sequence of clues that reveal small compliments or favorite memories.', category:'quest', budget:'free', location:'home', costEstimate:'Free with paper', duration:'15–30 minutes', equipment:['Small notes','Pen'], mission:'Make the final clue reveal a thoughtful message.', howToPlay:['Write three sincere compliments or memories.','Attach a simple clue to each note.','Let your partner follow the trail, then swap and repeat.'], gradient:'linear-gradient(135deg, #1e293b, #4c1d95)' },
    { id:'questpack-05', title:'Park Detail Discovery', detail:'Visit a public park and choose a small observation challenge instead of a long hike.', category:'quest', budget:'free', location:'out', costEstimate:'Free', duration:'25–45 minutes', equipment:['Phone camera optional'], mission:'Find a natural pattern, a peaceful spot, and something that makes you smile.', howToPlay:['Choose a park and a comfortable route.','Each player picks one thing to observe without disturbing wildlife or plants.','Share observations and choose your favorite spot.'], importantRule:'Follow park rules and leave plants, animals, and surroundings undisturbed.', gradient:'linear-gradient(135deg, #1e293b, #14532d)' },
    { id:'questpack-06', title:'The $5-or-Free Quest', detail:'Plan a tiny outing that costs no more than five dollars total—or costs nothing.', category:'quest', budget:'free', location:'out', costEstimate:'Free to $5 total', duration:'30–60 minutes', equipment:['None required'], mission:'Find a fun shared experience without breaking the budget.', howToPlay:['Agree on a total spending limit of $0–$5.','Choose a free public destination or an inexpensive shared treat.','At the end, name the best moment that cost nothing.'], importantRule:'Travel costs may vary; keep the agreed budget realistic.', gradient:'linear-gradient(135deg, #1e293b, #0f766e)' },
    { id:'questpack-07', title:'Memory Map Quest', detail:'Draw a tiny map of places that have mattered to your relationship or friendship.', category:'quest', budget:'free', location:'home', costEstimate:'Free with paper', duration:'20–40 minutes', equipment:['Paper','Pens'], mission:'Create a map with three places and the story behind each one.', howToPlay:['Sketch a simple map, real or imaginary.','Mark three meaningful places and add a short memory to each.','Trade maps and ask one question about each place.'], gradient:'linear-gradient(135deg, #1e293b, #312e81)' }
  ],
  'pack-arcade': [
    { id:'arcadepack-01', title:'Paper Ball Bullseye', detail:'Use soft paper balls and a bin to make a three-round target contest.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with scrap paper and a bin', duration:'10–20 minutes', equipment:['Scrap paper','Bin or basket'], mission:'Score points by landing paper balls in the target.', howToPlay:['Place a bin at a safe, agreed distance.','Give each player five paper-ball throws per round.','Play three rounds, moving the target slightly farther away if both agree.'], importantRule:'Use paper only and keep the area clear of fragile items.', gradient:'linear-gradient(135deg, #581c87, #3b0764)' },
    { id:'arcadepack-02', title:'Speed Stack Showdown', detail:'Race to stack and unstack a safe set of cups or lightweight containers.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with cups or containers', duration:'10–15 minutes', equipment:['Lightweight cups or containers'], mission:'Complete three rounds without knocking over the stack.', howToPlay:['Build a simple pyramid with lightweight cups.','Time each player stacking and unstacking it.','Best two of three rounds wins.'], importantRule:'Use lightweight items and a stable surface.', gradient:'linear-gradient(135deg, #581c87, #701a75)' },
    { id:'arcadepack-03', title:'One-Minute Drawing Duel', detail:'Draw the same silly prompt in one minute, then compare the results.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with paper and pens', duration:'10–20 minutes', equipment:['Paper','Pens'], mission:'Create a recognizable drawing under a one-minute timer.', howToPlay:['Choose a prompt such as a dragon, robot, or dream house.','Set a one-minute timer and draw without looking at each other’s work.','Reveal drawings and award points for funniest, most creative, and most recognizable.'], gradient:'linear-gradient(135deg, #581c87, #4c1d95)' },
    { id:'arcadepack-04', title:'Song Intro Challenge', detail:'Play a short intro from music you can legally access and guess the song or artist.', category:'arcade', budget:'free', location:'home', costEstimate:'Free if you have music access', duration:'15–25 minutes', equipment:['Music app or owned tracks'], mission:'Get the most correct guesses across ten songs.', howToPlay:['Each person queues five songs without showing the screen.','Play a few seconds of each intro and let the other guess title or artist.','Award one point per correct answer, then swap roles.'], gradient:'linear-gradient(135deg, #581c87, #312e81)' },
    { id:'arcadepack-05', title:'Memory Tray Challenge', detail:'Study a tray of safe household objects briefly, then see how many each person remembers.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with household objects', duration:'10–20 minutes', equipment:['6–12 safe household objects','Tray or table'], mission:'Remember as many objects as possible after a short look.', howToPlay:['Place 6–12 safe objects on a tray.','Study them for 20 seconds, then cover them.','Write down as many as you remember and switch who arranges the tray.'], importantRule:'Avoid sharp, breakable, or hazardous objects.', gradient:'linear-gradient(135deg, #581c87, #4c1d95)' },
    { id:'arcadepack-06', title:'No-Laugh Challenge', detail:'Take turns telling a harmless silly story or making a funny face while the other tries to keep a straight face.', category:'arcade', budget:'free', location:'home', costEstimate:'Free', duration:'10–15 minutes', equipment:['None'], mission:'Stay serious for one minute, then swap roles.', howToPlay:['Agree on a one-minute round.','Take turns using harmless jokes, funny voices, or expressions.','Award one point each time the other player laughs; low score wins.'], gradient:'linear-gradient(135deg, #581c87, #701a75)' },
    { id:'arcadepack-07', title:'Best-of-Five Quickfire', detail:'Pick five short challenges from this pack and play them as a mini tournament.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with household items', duration:'20–35 minutes', equipment:['Paper and pen optional','Safe household items'], mission:'Earn the most points across five quick challenges.', howToPlay:['Choose five short challenges and agree on fair rules.','Play each challenge once and record a point for each round won.','Total the scores and invent a funny championship title.'], gradient:'linear-gradient(135deg, #581c87, #3b0764)' }
  ]
};


window.expansionDecks = expansionDecks;

function isNativePurchasePlatform() {
  try { return Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()); }
  catch (_) { return false; }
}

function getNativePurchasePlatform() {
  try {
    const platform = window.Capacitor && typeof window.Capacitor.getPlatform === 'function' ? window.Capacitor.getPlatform() : '';
    return platform === 'ios' || platform === 'android' ? platform : '';
  } catch (_) { return ''; }
}

function hasActiveEntitlement(activeEntitlements, entitlementId) {
  const entitlement = activeEntitlements && activeEntitlements[entitlementId];
  return Boolean(entitlement && (entitlement.isActive === undefined || entitlement.isActive === true));
}

function packIdsFromCustomerInfo(customerInfo) {
  const active = customerInfo && customerInfo.entitlements && customerInfo.entitlements.active || {};
  const allPacks = hasActiveEntitlement(active, ENTITLEMENT_IDS.ALL_EXPANSIONS);
  return storeCatalog.filter(pack => allPacks || hasActiveEntitlement(active, ENTITLEMENT_IDS[pack.id])).map(pack => pack.id);
}

async function applyCustomerInfoEntitlements(customerInfo) {
  /* RevenueCat customerInfo is the authority: local storage and backup JSON never grant ownership. */
  const authoritativePacks = packIdsFromCustomerInfo(customerInfo);
  const previousPrefs = savedSelectedPacksPreference;
  unlockedItems = authoritativePacks;
  if (Array.isArray(previousPrefs)) {
    selectedPacks = [...new Set(previousPrefs.filter(id => id === 'starter' || authoritativePacks.includes(id)))];
    if (!selectedPacks.length) selectedPacks = ['starter'];
  } else {
    selectedPacks = ['starter', ...authoritativePacks];
  }
  try {
    if (!useMemoryFallback && db) {
      /* Clear legacy local unlock markers so they cannot later be mistaken for ownership. */
      await db.unlocks.clear();
      await db.settings.put({ key: 'selectedPacks', value: selectedPacks });
    }
  } catch (error) {
    console.warn('Could not save selection preferences after entitlement sync:', error);
  }
  renderPackChoices();
  refreshDecks();
  initMatcher();
  renderLibrary();
  renderStore();
  return authoritativePacks;
}

async function initializePurchases() {
  if (!isNativePurchasePlatform()) {
    purchasesStatus = 'Store purchases and restoration are available only in a configured iOS/Android app. Browser-local unlocks are disabled.';
    renderStore();
    return false;
  }
  if (!Purchases || typeof Purchases.configure !== 'function') {
    purchasesStatus = 'RevenueCat native plugin is missing. Install @revenuecat/purchases-capacitor and sync the native project.';
    console.warn(purchasesStatus);
    renderStore();
    return false;
  }
  const platform = getNativePurchasePlatform();
  const apiKey = platform && REVENUECAT_API_KEYS[platform];
  if (!apiKey || apiKey.includes('REPLACE_WITH_PUBLIC_REVENUECAT')) {
    purchasesStatus = `RevenueCat ${platform || 'platform'} public SDK key is not configured. Purchases remain locked until a valid key is supplied.`;
    console.warn(purchasesStatus);
    renderStore();
    return false;
  }
  try {
    await Purchases.configure({ apiKey });
    purchasesConfigured = true;
    purchasesStatus = 'Connected to App Store / Google Play billing.';
    try {
      const response = await Purchases.getCustomerInfo();
      await applyCustomerInfoEntitlements(response && response.customerInfo ? response.customerInfo : response);
    } catch (error) {
      /* RevenueCat may still return cached customer info after a prior successful fetch; if not, do not trust local flags. */
      console.warn('Could not refresh customer entitlements:', error);
      purchasesStatus = 'Store is configured, but entitlements could not be refreshed. Existing local unlock flags are not trusted.';
    }
    renderStore();
    return true;
  } catch (error) {
    purchasesConfigured = false;
    purchasesStatus = `RevenueCat configuration failed: ${error && error.message ? error.message : 'unknown error'}`;
    console.error(purchasesStatus, error);
    renderStore();
    return false;
  }
}

function renderStore() {
  const grid = getEl('storeGrid');
  const summary = getEl('storeSummary');
  if (!grid) return;
  if (summary) {
    const ownershipCount = unlockedItems.filter(id => expansionDecks[id]).length;
    summary.textContent = `${storeCatalog.length} packs available · ${ownershipCount} verified unlock(s). ${purchasesStatus}`;
  }
  grid.replaceChildren();
  storeCatalog.forEach(item => {
    const unlocked = unlockedItems.includes(item.id);
    const card = document.createElement('article');
    card.className = 'library-item store-tile';
    card.style.background = item.gradient || '#1f122e';
    const category = document.createElement('div');
    category.className = 'library-category';
    category.textContent = `EXPANSION PACK · ${item.price}`;
    const title = document.createElement('div');
    title.className = 'library-title';
    title.textContent = item.title;
    const detail = document.createElement('div');
    detail.className = 'library-detail';
    detail.textContent = item.desc;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `primary-btn${unlocked ? ' secondary-action-btn' : ''}`;
    button.style.marginTop = '10px';
    button.style.padding = '8px 12px';
    button.style.fontSize = '0.8rem';
    button.textContent = unlocked ? '✅ Unlocked & Available' : `🔓 Unlock Pack · ${item.price}`;
    button.addEventListener('click', () => openStorePreview(item.id));
    card.append(category, title, detail, button);
    grid.appendChild(card);
  });
}

function openStorePreview(itemId) {
  const item = storeCatalog.find(entry => entry.id === itemId);
  if (!item) return;
  selectedPreviewItemId = itemId;
  const storeModalTitle = getEl('storeModalTitle'); if (storeModalTitle) storeModalTitle.textContent = item.title;
  const storeModalDesc = getEl('storeModalDesc'); if (storeModalDesc) storeModalDesc.textContent = item.desc;
  const unlocked = unlockedItems.includes(itemId);
  const actionButton = getEl('storeModalActionBtn');
  if (actionButton) {
    actionButton.textContent = unlocked ? 'Already Unlocked' : `Unlock Pack · ${item.price}`;
    actionButton.disabled = unlocked;
  }

  const list = getEl('storeModalCardsList');
  if (list) {
    list.replaceChildren();
    (expansionDecks[itemId] || []).forEach(card => {
      const wrapper = document.createElement('div');
      wrapper.style.background = '#1f122e';
      wrapper.style.border = '1px solid var(--border)';
      wrapper.style.borderRadius = '8px';
      wrapper.style.padding = '8px 10px';
      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:0.65rem;color:var(--gold);font-weight:800;text-transform:uppercase;';
      meta.textContent = `${card.category} · ${card.location} · Budget: ${card.budget}`;
      const title = document.createElement('div');
      title.style.cssText = 'font-size:0.85rem;font-weight:900;color:var(--cream);';
      title.textContent = card.title;
      const detail = document.createElement('div');
      detail.style.cssText = 'font-size:0.75rem;color:var(--muted);';
      detail.textContent = card.detail;
      wrapper.append(meta, title, detail);
      list.appendChild(wrapper);
    });
  }
  const previewModal = getEl('storePreviewModal');
  if (previewModal) previewModal.classList.add('show');
}

function closeStorePreview() {
  const previewModal = getEl('storePreviewModal');
  if (previewModal) previewModal.classList.remove('show');
  selectedPreviewItemId = null;
}

async function actionFromPreviewModal() {
  if (!selectedPreviewItemId) return;
  const itemId = selectedPreviewItemId;
  closeStorePreview();
  await handleStoreAction(itemId);
}

async function handleStoreAction(itemId) {
  if (!storeCatalog.some(pack => pack.id === itemId)) {
    showToast('That expansion pack is not available.');
    return;
  }
  if (unlockedItems.includes(itemId)) {
    showToast('This pack is already unlocked with a verified store entitlement.');
    return;
  }
  if (!isNativePurchasePlatform()) {
    showToast('Browser unlocks are disabled. Purchase this pack from the installed iOS/Android app so store ownership can be verified.');
    return;
  }
  if (!purchasesConfigured || !Purchases) {
    showToast('Store purchases are not configured yet. Check the RevenueCat public SDK key and native plugin setup.');
    return;
  }
  try {
    showToast('Connecting to App Store / Google Play billing…');
    const offeringsResponse = await Purchases.getOfferings();
    const offerings = offeringsResponse && offeringsResponse.offerings ? offeringsResponse.offerings : offeringsResponse;
    const current = offerings && offerings.current;
    if (!current || !Array.isArray(current.availablePackages)) {
      showToast('No store offering is configured. Add the pack products to the current RevenueCat offering.');
      return;
    }
    const productId = PRODUCT_IDS[itemId];
    const pkg = current.availablePackages.find(candidate => candidate && candidate.product && candidate.product.identifier === productId);
    if (!pkg) {
      showToast(`Store product ${productId} was not found in the current RevenueCat offering.`);
      return;
    }
    const purchaseResult = await Purchases.purchasePackage({ aPackage: pkg });
    const customerInfo = purchaseResult && purchaseResult.customerInfo ? purchaseResult.customerInfo : purchaseResult;
    await applyCustomerInfoEntitlements(customerInfo);
    if (!unlockedItems.includes(itemId)) {
      showToast('The purchase returned, but RevenueCat did not report the required pack entitlement. Check product and entitlement mapping in the RevenueCat dashboard.');
      return;
    }
    await triggerHaptic('success');
    showToast('Purchase verified and expansion pack unlocked.');
  } catch (err) {
    if (err && (err.userCancelled || err.code === 'PURCHASE_CANCELLED')) return;
    showToast(`Store transaction failed: ${err && err.message ? err.message : 'Please try again.'}`);
  }
}

async function restorePurchases() {
  if (!isNativePurchasePlatform()) {
    showToast('Restore purchases is available inside the installed iOS/Android app, not the browser PWA.');
    return;
  }
  if (!Purchases || !purchasesConfigured || typeof Purchases.restorePurchases !== 'function') {
    showToast('Restore unavailable: RevenueCat is not configured. Verify the platform SDK key and native plugin.');
    return;
  }
  try {
    showToast('Checking purchases with the app store…');
    const response = await Purchases.restorePurchases();
    const customerInfo = response && response.customerInfo ? response.customerInfo : response;
    const verifiedPacks = await applyCustomerInfoEntitlements(customerInfo);
    const count = verifiedPacks.length;
    if (count > 0) {
      showToast(`Restore successful: ${count} expansion pack(s) are verified on this store account.`);
    } else {
      showToast('Restore completed. No eligible expansion-pack purchases were found for this store account.');
    }
  } catch (err) {
    console.error('Restore purchases failed:', err);
    showToast(`Restore failed. Your purchases were not changed. ${err && err.message ? err.message : 'Check the store account and try again.'}`);
  }
}
