// ─────────────────────────────────────────────
// Nutrition OS — Google Apps Script Backend
// ─────────────────────────────────────────────
//
// WHAT THIS FILE IS
//   The web app behind index.html. Every request: doGet/doPost → handleRequest → resolve the
//   household (registry + PIN or Google session) → one action in the big switch → JSON back.
//   Data lives in Google Sheets: one spreadsheet per household, plus ONE shared library
//   spreadsheet (dishes, ingredients, measures) that every household reads.
//
// SECTIONS (search for the text)
//   SHEETS = {            every tab and its columns (APPEND columns, never insert)
//   function handleRequest  routing, owner lock, the action switch
//   ALL_READERS           what one sync (getAll) returns; must match the client's merge
//   MACRO FOUNDATION      ingredients, measures, portion maths, adding dishes/ingredients
//   Cook next, shared     the house menu list (add-only) + who is building it (claimCookNext)
//   Inventory / Meal Log  shelf, logging, edit/delete
//   DISH MATCHING         free text → a library dish, aliases, cleanup
//   STOCK DEDUCTION       what a logged meal takes off the shelf (idempotent, reversible)
//   The Menu / sweep      decided dishes; auto-log after the slot ends
//   GOOGLE SIGN-IN        sessions, accounts, memberships
//   MULTI-TENANCY         registry, PIN check, createHousehold
//   Instrumentation       Events tab and the six-check test (getChecks)
//
// RULES (each one is a bug that already shipped once)
//   1. Read and write library tabs by HEADER NAME (ingredientCols_), never by position.
//   2. Never setValue() into DishCatalog/DishIngredients formula columns; go through dishCatalogRow_.
//   3. Dates read from a sheet go through asISODate()/istDay_(); IST is 'Asia/Kolkata', always.
//   4. A new sync reader goes into ALL_READERS AND the client's syncAll merge.
//   5. Setup must run inside an ordinary request (setupSheets), never as a run-once function.
//   6. This file never calls Claude and holds no API key.
//   7. A request with no household name is refused. There is no "default kitchen" any more.
//   8. A PIN is compared in ONE place (checkPin_), which also counts wrong tries and locks.

// This household's own data. Every household gets its own copy of this
// spreadsheet — nothing here is shareable.
//
// v4.0 (multi-tenant): SHEET_ID is no longer THE household — it is the DEFAULT
// one. A request that carries no `hh` parameter still lands here, which is what
// keeps the original household working unchanged after this deploy and lets the
// old HTML and the new HTML run against the same backend during the beta.
const SHEET_ID = '1_pF2BYHEiHKjDXdTnokTePktOxgncws1EU1O8wTgux8';

// The registry: one row per beta household, mapping a household ID to the
// spreadsheet that holds its data. You own every one of those spreadsheets, so
// onboarding costs a friend nothing and you can actually debug what broke.
//
// v4.4: this lives in the MAIN spreadsheet as a tab called `Registry`, created by
// hand. It used to be a separate file plus a setupRegistry() function, which was
// two things that could silently be wrong — an ID that didn't resolve, or a setup
// function running in a different Apps Script project than the deployed one — with
// no way to tell which. A tab you can look at beats a setup step you have to trust.
//
// It is opened by ID and never through ssFor(), so it is not household data and
// does not travel when a household does. If the original house ever moves to its
// own fresh spreadsheet, this must STOP being an alias for SHEET_ID and point at
// whichever file the Registry tab actually lives in.
const REGISTRY_SHEET_ID = SHEET_ID;

// Resolved per request by resolveHousehold_(). Never read directly — ssFor()
// owns it, so a household is chosen in exactly one place.
var _activeSheetId_ = SHEET_ID;
var _activeHousehold_ = 'default';

// The shared food library: dish identities, nutrition, prep requirements. None of
// it is household-specific — the macros for Rajma Chawal are the same in every
// kitchen — so it belongs in ONE spreadsheet that every household reads from.
// v4.7. Now genuinely separate. Paste the ID of the shared library spreadsheet
// below. Leaving it as SHEET_ID still works — the library simply lives inside the
// household sheet as before — but every household then keeps a PRIVATE copy of
// facts that are true everywhere, which is the thing this constant exists to fix.
//
// To split: create a new blank spreadsheet, copy its ID out of the URL
// (docs.google.com/spreadsheets/d/<THIS PART>/edit), paste it here, then run
// migrateLibrary() once from the Apps Script editor.
// v4.11. Reported by the `whoami` action, so a deploy can be verified without opening the editor.
const CODE_VERSION = 'v4.25';

const LIBRARY_SHEET_ID = '1JPwxAoT6ZpzNvskOszHApfaRq9ntYeih6A3TT4Z0o3Q';   // nutrition-library.xlsx, uploaded to Drive

const SHEETS = {
  // v4.22. IngID and Brand appended (never inserted): the link to the shared Ingredients library, and
  // the brand text split off the typed name. Item stays exactly what was typed, so it is still the key.
  Inventory:      ['Item', 'Quantity', 'Unit', 'LastUpdated', 'UpdatedBy', 'IngID', 'Brand'],
  // LogID and Source are appended, never inserted — inserting a column ahead of an
  // existing one silently corrupts every historical row (this has bitten the project
  // twice). LogID is the stable handle that makes a logged meal editable/deletable;
  // Source records how it got here ('manual' | 'menu' | 'auto') so an auto-logged
  // meal can be told apart from one a person actually tapped.
  // Portion and PortionFactor are appended (see the rule above). Portion is the text
  // the cook was told; PortionFactor is the multiplier applied to the dish's stored
  // macros for THIS serving. Factor 1 (or blank) means a standard serving, so every
  // historical row keeps meaning exactly what it meant before.
  // v4.7. Qty and Measure APPENDED. They are the real portion now — "2" and
  // "Katori, standard" — from which grams and macros are computed. Portion and
  // PortionFactor are KEPT and still written: an older client reads them, and a
  // row logged before this change has only them. PortionFactor is now DERIVED
  // (grams / one-serving grams) rather than typed, so the two can never disagree.
  // v4.8. Portion and PortionFactor DELETED. A portion is Qty + Measure now — "2"
  // and "Katori, standard" — and grams and macros are computed from those against
  // the library. The old pair were a sentence and a multiplier, neither of which
  // could be checked against anything.
  MealLog:        ['Date', 'MealName', 'MealType', 'LoggedBy', 'Notes', 'DishID', 'LogID', 'Source', 'Qty', 'Measure'],
  GroceryOrders:  ['Date', 'Item', 'Quantity', 'OrderedBy', 'AppName'],
  Macros:         ['Person', 'Calories', 'Protein', 'Carbs', 'Fat', 'Weight', 'Fiber'],
  Workouts:       ['Date', 'Person', 'Exercise', 'MuscleGroup', 'Sets', 'TotalVolume', 'CaloriesBurned', 'LoggedAt'],
  // Picks is APPENDED (never inserted — a column inserted ahead of Favourites is what
  // once made two people's favourite food display as a timestamp). It holds the taste
  // picker's structured choices as JSON: {like:[], avoid:[], style:[]}. Likes/Dislikes
  // stay as the free-text overflow for anything the picker doesn't offer.
  Preferences:    ['Person', 'Diet', 'Likes', 'Dislikes', 'Allergies', 'Favourites', 'UpdatedAt', 'Picks'],
  Feedback:       ['Date', 'Person', 'Message', 'Screen', 'Version', 'Photo'],
  // Household-level settings, one row per key. A tab rather than columns because the
  // set of keys keeps growing and a wide sheet would need a migration each time.
  // ONLY genuinely shared facts belong here — the region the food comes from, the
  // cook's name and language. Anything device- or session-scoped (which prompts have
  // been dismissed today) stays in localStorage where it belongs.
  Household:      ['Key', 'Value', 'UpdatedAt', 'UpdatedBy'],
  // CookKnows records whether the cook can already make this dish: '' (unknown),
  // 'yes' or 'no'. It is the repertoire signal the menu ranks on — a dish she
  // can't make is a dish the household can't actually eat, however good it sounds.
  // v4.8. DishMacros DELETED. It mixed two unrelated things: guessed nutrition, which
  // the library now computes, and how well the cook makes a dish — and that half was
  // ALREADY duplicated in CookSkills below. So nothing needed rescuing: the ratings
  // that matter have been written to CookSkills by rateDish/setCookKnows all along.
  // Adding a DishRatings tab here would have rebuilt the exact duplication being removed.
  // The canonical dish registry. DishMacros/MealLog keep dish *display* names
  // for readability in the Sheet; DishID is the stable join key everything
  // else should match on, so "Paneer Bhurji" / "paneer ki bhurji" / a vision-
  // scan variant all resolve to one row instead of silently fragmenting.
  // IngredientRefs is reserved and left blank until the ingredient catalog
  // (inventory-side canonicalization) is built — see HANDOFF "open items".
  // v4.7. The dish universe. Was six identity columns; now carries the whole
  // cooking-math model ported from nutrition-os-library.xlsx.
  //
  // Only SEVEN of these are inputs a human (or Claude) writes:
  //   DishID, CanonicalName, Aliases, Hindi, Region, Status, ClassID
  // plus three optional overrides: EvapOverride, Pieces, Servings.
  // EVERYTHING ELSE IS A LIVE FORMULA. Never setValue() into columns I, K, L, M,
  // N, O, Q, R, S, T, U, V-AE, AG-AL — writing a number there destroys the
  // formula and the cell stops tracking its inputs forever. That is the whole
  // point of the rebuild: fix one ingredient's grams and every macro downstream
  // moves by itself.
  //
  // The chain: DishIngredients holds raw grams per dish → SUMIFS totals them here
  // → YieldGrams = TotalRawGrams x (1 - EvapPct) accounts for water boiled off →
  // GramsPerStdKatori = BulkDensity x FillFactor x 150ml turns a katori into grams.
  // Density and evaporation come from DishClasses, not from per-dish guesses.
  //
  // InputConfidence is APPENDED (see the never-insert rule above) and records how
  // the seven inputs got here: 'confirmed' (a human wrote them) or 'estimated'
  // (Claude guessed the class and ingredients during migration). The client shows
  // estimated dishes differently so a guess is never mistaken for a measurement.
  DishCatalog:    ['DishID', 'CanonicalName', 'Aliases', 'Hindi', 'Region', 'Status',
                   'CreatedAt', 'ClassID', 'Class', 'EvapOverride', 'ServedAs',
                   'TotalRawGrams', 'WaterGrams', 'EvapPct', 'YieldGrams', 'Pieces',
                   'GramsPerPiece', 'BulkDensity', 'FillFactor', 'GramsPerStdKatori',
                   'KatoriPerBatch', 'KcalBatch', 'ProteinBatch', 'CarbsBatch',
                   'FatBatch', 'FibreBatch', 'Kcal100g', 'Protein100g', 'Carbs100g',
                   'Fat100g', 'Fibre100g', 'Servings', 'KcalServing', 'ProteinServing',
                   'CarbsServing', 'FatServing', 'FibreServing', 'ServingLabel',
                   'InputConfidence',
                   // v4.8. Moved here from the deleted DishLibrary. Prep is a fact about
                   // the DISH, not about one household — rajma needs soaking in every
                   // kitchen — so it belongs in the shared library. Losing this breaks
                   // the soak-ahead reminder, which is check #3 of the six-check test.
                   // Common flags everyday home cooking, so the menu can warn that a
                   // dish will need teaching.
                   'PrepNote', 'PrepHours', 'Common'],

  // v4.7. The density layer. A katori of thin dal and a katori of fried snack are
  // the same VOLUME and wildly different WEIGHTS, and no public dataset carries
  // this for Indian food — it is the difference between a portion multiplier that
  // means something and one that multiplies a guess.
  //
  // BulkDensity is g/ml of the cooked dish as it sits in the katori. FillFactor is
  // how much of the katori actually holds food (0.88 = the usual not-quite-to-the-
  // brim serve; 1.0 where pieces mound above the rim and cancel the shortfall).
  // BulkDensity = 0 means COUNTED, not weightless: rotis and eggs are served per
  // piece, so ServedAs flips to 'piece' and the katori maths is skipped entirely.
  // DefaultEvapPct is the fraction of raw weight lost to steam, overridable per
  // dish via DishCatalog.EvapOverride.
  //
  // These 24 rows were tuned against real HealthifyMe readings — do not "round them
  // off". Confidence records how well: Low means the number is a considered guess
  // awaiting a scale.
  DishClasses:    ['ClassID', 'Class', 'Description', 'BulkDensity', 'FillFactor',
                   'DefaultEvapPct', 'GramsPerStdKatori', 'Confidence'],

  // v4.7. What each dish is actually made of, one row per ingredient, in RAW grams
  // as they go into the pot. This is the only table a person edits to change a
  // dish's nutrition — the five macro columns are formulas that scale the
  // Ingredients per-100g values by RawGrams, and DishCatalog sums them.
  //
  // 'water' is a real ingredient row here and must stay one: it carries no macros
  // but it is what makes TotalRawGrams honest, and WaterGrams reads it back out.
  DishIngredients: ['DishID', 'Dish', 'IngID', 'Ingredient', 'RawGrams',
                    'Kcal', 'Protein', 'Carbs', 'Fat', 'Fiber'],

  // v4.8. DishLibrary DELETED. It held per-dish macros that DishCatalog now
  // computes from ingredients, and prep notes that moved into DishCatalog above.
  // Keeping it would have meant two tables answering "how many calories is this",
  // which is how they drift apart without anyone noticing.

  // v4.11. One row per alias ever added to a dish: what text, for which dish, HOW it was
  // matched (normalised | stem | hindi | claude | user | cleanup), by which household, and
  // whether it awaits review (ReviewStatus: ok | pending | removed). The Aliases cell on
  // DishCatalog is the live truth both sides read; this is the audit trail, because a
  // pipe-separated cell cannot say who added "dal tadka" or why, and a wrong alias is
  // shared by every household. Lives in the LIBRARY, so it is listed in LIBRARY_SHEETS.
  AliasLog:       ['Alias', 'DishID', 'CanonicalName', 'Method', 'Source', 'AddedBy', 'AddedAt',
                   'ReviewStatus', 'Note'],

  // ── Household ──
  // v4.12. One row per logged meal that touched (or tried to touch) the stock list, keyed by
  // LogID. It is what makes deduction idempotent and reversible: Status is applied | pending
  // (the dish was not in the dish list yet) | skipped (ate out) | reversed, and Detail is the
  // JSON receipt: what came off which shelf row, what could not, and why. Household data.
  InventoryLog:   ['LogID', 'Dish', 'Person', 'DishID', 'Status', 'Detail', 'At', 'Note'],

  // What THIS household's cook can make and how well it comes out. Never shared:
  // one cook's repertoire says nothing about another's.
  // Source (appended, v4.2) separates how a dish got into the repertoire:
  // 'seeded' means someone tapped it in the onboarding grid, anything else means
  // it got here through use. Check 6 asks whether the app LEARNED, and without
  // this column a household that taps twenty chips at setup passes the check at
  // minute five while having taught the app nothing.
  CookSkills:     ['DishID', 'Dish', 'CookKnows', 'CookRating', 'RatingCount', 'UpdatedBy', 'UpdatedAt', 'Source'],

  // Dishes someone wants cooked "sometime" — the saved-for-later pile, not a plan
  // and not a log. Deliberately household data, not library: wanting rajma on
  // Thursday says nothing about anyone else's kitchen. Kept out of MealLog for the
  // same reason a basket isn't a receipt — anything leaking in there would corrupt
  // both today's macros and the two-day repeat rule.
  Wishlist:       ['Dish', 'AddedBy', 'AddedAt'],

  // ── The Menu: what has actually been FINALISED ─────────────────────────────
  // Cook next is a waiter making recommendations; Menu is the order that was
  // placed. One row per person per dish, which is what makes the two operations
  // that matter cheap: "+1" is an inserted row, "leave" is a deleted one, and the
  // auto-log sweep is one row → one MealLog entry with no fan-out logic anywhere.
  //
  // Rows arrive three ways, all identical once here — Source only records the
  // provenance: 'plan' (materialised from a fixed menu), 'pick' (someone chose it
  // off Cook next) or 'join' (+1 onto someone else's dish).
  //
  // Status is the idempotency guard for the sweep: only 'open' rows are ever
  // logged, and the sweep flips them to 'logged' inside a lock, so two phones
  // syncing at the same second cannot double-log the same meal.
  // Portion is APPENDED. It carries the plan's serving size ("2 roti + 1 katori")
  // through to the cook order and the log, so a planned meal's macros mean something
  // more than a generic per-serving guess.
  // v4.7. Qty/Measure appended, same reasoning as MealLog.
  Menu:           ['MenuID', 'Date', 'Slot', 'Dish', 'Person', 'Source', 'Status', 'LogID', 'AddedBy', 'AddedAt', 'Qty', 'Measure', 'Note'],

  // The fixed-menu template for one person. Deliberately NOT the schedule itself:
  // approving a plan materialises Menu rows for each day, and a same-day swap edits
  // that Menu row while this template stays untouched — so "change Tuesday's lunch
  // just this once" cannot quietly rewrite the rotation. Plan holds JSON:
  // [{ day:0, slots:{ breakfast:'Poha', lunch:'Rajma Chawal', snack:'', dinner:'…' } }, …]
  // ── Cook next, shared (v3.12) ──────────────────────────────────────────────
  // The menu used to live only in one device's memory. Each flatmate opening the
  // app generated their OWN household menu, so three phones showed three different
  // answers to "what is the household eating tonight" — for food cooked once, in
  // one kitchen. Three Claude calls to disagree with each other.
  //
  // Now it is one shared list per (Date, Slot, Scope), stored per-dish rather than
  // as a blob. Per-dish rows are what make the chosen rule enforceable: anyone may
  // ADD, nobody may replace. A blob would make every write a whole-list overwrite
  // and the last phone to sync would silently erase someone else's additions.
  //
  // Scope is 'shared' or a person's name. A personal menu ("just for me") is the
  // same machinery with a different scope, so nothing downstream needs to care.
  CookNext:       ['ID', 'Date', 'Slot', 'Scope', 'Dish', 'For', 'Protein', 'Portion',
                   'Missing', 'Hints', 'Prep', 'PrepHours', 'AddedBy', 'AddedAt'],

  MealPlans:      ['Person', 'Mode', 'StartDate', 'Days', 'RepeatGap', 'Notes', 'Plan', 'Status', 'UpdatedAt'],

  // ── The macro foundation (v3.7) ────────────────────────────────────────────
  // Three tabs that together replace "ask Claude what a dish costs" with
  // arithmetic. All three are LIBRARY data: an ingredient's composition and the
  // weight of a katori are facts about the world, not about this household.
  //
  // Ingredients: lab values from ICMR-NIN's IFCT 2017, per 100 g EDIBLE PORTION
  // in the state named. State is the thing that silently ruins everything if
  // ignored — 100 g raw rice is ~356 kcal and becomes ~250 g cooked, so reading a
  // raw row as though it were cooked triples a katori of chawal. Seeded once from
  // Ingredients-seed.csv; regenerate with build-ingredients.js rather than editing
  // rows by hand, or the next regeneration silently reverts the edit.
  // Common: 'yes' = the canonical row a lookup should land on, 'variant' = a real
  // but more-qualified IFCT sample kept for reference, 'no' = out of household scope.
  // Aliases is the bridge between IFCT's formal names and what a household or a
  // delivery app actually says — "Bengal gram" is what nobody types and "chana dal"
  // is what everybody types. Semicolon-separated, curated by hand in
  // build-ingredients.js, and attached to the canonical row only: an alias on two
  // rows makes the lookup ambiguous again, which is the bug this table exists to kill.
  // v4.7. Density and Confidence appended (never inserted). Density is g/ml for the
  // raw ingredient, used where a recipe is written in spoons rather than grams.
  Ingredients:    ['IngID', 'Name', 'FullName', 'Hindi', 'Aliases', 'Group', 'State',
                   'Kcal', 'Protein', 'Carbs', 'Fat', 'Fiber', 'Common', 'Source',
                   'Density', 'Confidence',
                   // v4.12. APPENDED. Grams in ONE piece, for ingredients counted in pieces
                   // (an egg, a slice). Without it "6 pcs" cannot be converted to grams and
                   // the meal cannot take it off the shelf. Blank means "not counted in pieces".
                   'PieceGrams'],

  // v4.7. REDEFINED. Measures is now pure geometry: how many millilitres a utensil
  // holds. It no longer knows anything about food.
  //
  // The old shape keyed on (Measure, FoodClass) and stored grams directly, which
  // meant every new dish class needed a new row per utensil — a combinatorial
  // table nobody could keep complete. Density moved to DishClasses instead, so
  // grams are now DERIVED: volume x density x fill. Fifteen utensils and
  // twenty-four classes replace what would have been 360 hand-maintained rows.
  //
  // Type 'count' with VolumeML 0 marks the counted case (roti, egg, samosa),
  // where volume is meaningless and portions are whole pieces.
  Measures:       ['Measure', 'Hindi', 'Type', 'VolumeML', 'Note'],

  // v4.8. Recipes DELETED. DishIngredients is the single source of truth for what
  // a dish contains, and it is formula-backed rather than a JSON blob in a cell.

  // v4.0. The beta's instrumentation. Four of the six checks are answerable from
  // this tab alone, which is the whole point — the 14-day test never ran solo, so
  // it runs across ten households instead and reports itself.
  //
  // Event is one of: app_open, menu_view, menu_generated, dish_logged,
  // prep_shown, cook_order_played. Detail carries the dish or slot where one
  // applies. Day is stored separately from Timestamp so a check can group by
  // local date without re-parsing timestamps in every reader.
  Events:         ['Timestamp', 'Day', 'Person', 'Event', 'Detail', 'Version']
};

// Which spreadsheet each sheet belongs to. Everything not listed is household data.
// Ingredients/Measures/Recipes are library: what is in a chana dal and what a katori
// weighs are facts about the world, not about one house. That is also what makes
// onboarding a second household cheap — they inherit the whole macro foundation.
// v4.7: DishClasses and DishIngredients join the library. Omitting them here is a
// SILENT bug, not a loud one — ssFor() would route them to the household sheet and
// every house would quietly grow its own private copy of the food model.
const LIBRARY_SHEETS = ['DishCatalog', 'DishClasses', 'DishIngredients', 'Ingredients', 'Measures', 'AliasLog'];

const OWNER_ONLY_ACTIONS_ = ['setMeasure', 'seedTable', 'seedIngredientPieces', 'mergeDishes', 'updateDishAliases',
  'cleanupBareDishes', 'resetSchema', 'migrateDishCatalog', 'canonicaliseInventory', 'privatizeFeedback'];

// Returns an error object when the caller is not the owner, else null. The key is never in the
// code or the app: it lives in Project Settings > Script properties.
function requireOwner_(body) {
  const key = PropertiesService.getScriptProperties().getProperty('OWNER_KEY');
  if (!key) return { error: 'Owner only. No owner key is set on this backend, so this action is locked.' };
  const given = String((body && body.ownerKey) || '');
  let diff = given.length === key.length ? 0 : 1;
  for (let i = 0; i < key.length; i++) diff |= (key.charCodeAt(i) ^ (given.charCodeAt(i) || 0));
  return diff === 0 ? null : { error: 'Owner only. That key is not right.' };
}

function doGet(e)  { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  try {
    const action = e.parameter.action || (e.postData ? JSON.parse(e.postData.contents).action : null);
    const body   = e.postData ? JSON.parse(e.postData.contents) : {};

    // v4.0. Resolution happens BEFORE setupSheets, because setupSheets writes to
    // whichever spreadsheet is active — running it first would create tabs in the
    // default household on every request from every user.
    // v4.24. Google sign-in. A session token (issued by authGoogle after Google's own ID token is
    // verified) says WHO is calling. It is checked first; everything below works as before.
    _authEmail_ = '';
    const sess = e.parameter.sess || body.sess;
    if (sess) {
      _authEmail_ = verifySession_(sess);
      if (!_authEmail_ && authOn_() && action !== 'authGoogle') return jsonResponse({ error: 'Session expired' });
    }
    if (action === 'authGoogle') return jsonResponse(authGoogle(body));
    if (action === 'myHouseholds') return jsonResponse(myHouseholds());
    if (action === 'joinHousehold') return jsonResponse(joinHousehold(body));
    if (action === 'createHousehold') return jsonResponse(createHousehold(body));
    // Must run BEFORE resolveHousehold_. A stale cached PIN blocks resolution, so
    // an action that needs resolving first could never be the thing that clears it.
    if (action === 'clearRegistryCache') return jsonResponse(clearRegistryCache());
    if (action === 'unlockHousehold') return jsonResponse(unlockHousehold(body));

    const auth = resolveHousehold_(e.parameter.hh || body.hh, e.parameter.pin || body.pin, _authEmail_);
    if (auth.error) return jsonResponse(auth);

    setupSheets();

    // v4.23. Actions that change EXISTING shared-library data (measures, ingredient tables, dish
    // merges and aliases, schema) are owner-only: they need `ownerKey`, which matches the Script
    // Property OWNER_KEY. Closed by default: with no key set, nobody can run them. The app's own
    // flows (adding a new dish, ingredient or alias, logging, planning) do not need the key.
    if (OWNER_ONLY_ACTIONS_.indexOf(action) > -1) {
      const denied = requireOwner_(body);
      if (denied) return jsonResponse(denied);
    }

    let result;
    switch (action) {
      case 'logEvent':            result = logEvent(body);                break;
      case 'getChecks':           result = getChecks(body);               break;
      case 'linkPerson':          result = linkPerson(body);              break;
      case 'whoami':              result = { household: _activeHousehold_, version: CODE_VERSION,
                                             login: authOn_() ? (authRequired_() ? 'required' : 'optional') : 'off',
                                             signedInAs: _authEmail_ ? 'yes' : 'no',
                                             ownerLock: PropertiesService.getScriptProperties().getProperty('OWNER_KEY') ? 'key set' : 'locked, no key set' }; break;
      case 'getCookNext':         result = getCookNext();                 break;
      case 'addCookNext':         result = addCookNext(body);             break;
      case 'removeCookNext':      result = removeCookNext(body);          break;
      case 'claimCookNext':       result = claimCookNext(body);           break;
      case 'privatizeFeedback':   result = privatizeFeedback();           break;
      case 'getTopDishes':        result = getTopDishes(body);            break;
      case 'canonicaliseInventory': result = canonicaliseInventory(body); break;
      case 'getIngredients':      result = getIngredients();              break;
      case 'getMeasures':         result = getMeasures();                 break;
      case 'setMeasure':          result = setMeasure(body);              break;
      case 'seedTable':           result = seedTable(body);               break;
      case 'resolveInventoryNames': result = resolveInventoryNames(body); break;
      case 'portionToGrams':      result = portionToGrams(body);          break;
      case 'macrosForPortion':    result = macrosForPortion(body);        break;
      case 'deductionForPortion': result = deductionForPortion(body);     break;
      case 'addDishToLibrary':    result = addDishToLibrary(body);        break;
      case 'addIngredients':      result = addIngredients(body);          break;
      case 'setDishPrep':         result = setDishPrep(body);             break;
      case 'defaultPortionFor':   result = defaultPortionFor(body);       break;
      case 'getAll':              result = getAll(e.parameter.want);      break;
      case 'resetSchema':         result = (setupSheets(true), { success:true }); break;
      case 'getInventory':        result = getInventory();                break;
      case 'setInventory':        result = setInventory(body.items);      break;
      case 'addInventoryItem':    result = addInventoryItem(body);        break;
      case 'addInventoryItems':   result = addInventoryItems(body);       break;
      case 'linkInventory':       result = linkInventory(body);           break;
      case 'saveIngredientAlias': result = saveIngredientAlias(body);     break;
      case 'removeInventoryItem': result = removeInventoryItem(body.item);break;
      case 'updateInventoryQty':  result = updateInventoryQty(body);      break; // NEW
      case 'getMealLog':          result = getMealLog();                  break;
      case 'logMeal':             result = logMeal(body);                 break;
      case 'getGroceryOrders':    result = getGroceryOrders();            break;
      case 'saveGroceryOrder':    result = saveGroceryOrder(body);        break;
      case 'getMacros':           result = getMacros();                   break;
      case 'updateMacros':        result = updateMacros(body);            break;
      case 'logWorkout':          result = logWorkout(body);              break;
      case 'getWorkoutLog':       result = getWorkoutLog(body);           break;
      case 'savePreferences':     result = savePreferences(body);         break;
      case 'getPreferences':      result = getPreferences();              break;
      case 'removeMember':        result = removeMember(body.person);     break;
      case 'saveFeedback':        result = saveFeedback(body);            break;
      case 'getFeedback':         result = getFeedback();                 break;
      case 'updateMenuPortion':   result = updateMenuPortion(body);       break;
      case 'getHousehold':        result = getHousehold();                break;
      case 'saveHousehold':       result = saveHousehold(body);           break;
      case 'rateDish':            result = rateDish(body);                break;
      case 'setCookKnows':        result = setCookKnows(body);            break;
      case 'setCookKnowsBulk':    result = setCookKnowsBulk(body);        break;
      case 'getCookSkills':       result = getCookSkills();               break;
      case 'getDishCatalog':      result = getDishCatalog();              break;
      case 'getDishIngredients':  result = getDishIngredients();          break;
      case 'migrateDishCatalog':  result = migrateDishCatalog();          break;
      case 'getDishDuplicateCandidates': result = getDishDuplicateCandidates(); break;
      case 'mergeDishes':         result = mergeDishes(body);             break;
      case 'updateDishAliases':   result = updateDishAliases(body);       break;
      case 'resolveDishTexts':    result = resolveDishTexts(body);        break;
      case 'removeDishAlias':     result = removeDishAlias(body);         break;
      case 'cleanupBareDishes':   result = cleanupBareDishes(body);       break;
      case 'saveDishAlias':       result = saveDishAlias(body);           break;
      case 'reconcileDeductions': result = reconcileDeductions(body);     break;
      case 'seedIngredientPieces': result = seedIngredientPieces();       break;
      case 'getWishlist':         result = getWishlist();                 break;
      case 'addWishlist':         result = addWishlist(body);             break;
      case 'removeWishlist':      result = removeWishlist(body);          break;
      case 'getMenu':             result = getMenu();                     break;
      case 'addMenuItems':        result = addMenuItems(body);            break;
      case 'removeMenuItem':      result = removeMenuItem(body);          break;
      case 'clearMenuRange':      result = clearMenuRange(body);          break;
      case 'sweepMenu':           result = sweepMenu();                   break;
      case 'getMealPlans':        result = getMealPlans();                break;
      case 'saveMealPlan':        result = saveMealPlan(body);            break;
      case 'setPlanMode':         result = setPlanMode(body);             break;
      case 'updateMealLog':       result = updateMealLog(body);           break;
      case 'deleteMealLog':       result = deleteMealLog(body);           break;
      default:
        result = { error: 'Unknown action: ' + action };
    }
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// The schema fingerprint. Bump nothing by hand — it is derived from SHEETS, so
// adding a column or a tab changes it automatically and forces one more pass.
function schemaKey_() {
  let s = '';
  Object.keys(SHEETS).forEach(k => { s += k + ':' + SHEETS[k].length + ';'; });
  // v4.0. The key MUST include the household. Without this, the first household
  // to be set up caches 'ok' script-wide and every household created afterwards
  // never gets its tabs — an empty-spreadsheet bug that would only surface on
  // the second beta user, i.e. in front of a friend.
  return 'schema_' + _activeSheetId_.slice(-8) + '_' + s.length + '_' +
         s.split('').reduce((a, c) => ((a * 31 + c.charCodeAt(0)) | 0), 7);
}

// setupSheets() was called at the top of EVERY request. For 15 sheets that is
// ~60 Spreadsheet round trips before the request did any work — with 11 GETs per
// sync, the same header check ran 165 times a minute to discover nothing had
// changed. It only ever needs to run when the schema changes or a sheet is
// missing, so the result is cached for 6 hours under a key derived from SHEETS.
// Deploying a new column changes the key, so the backfill still happens on its
// own — no manual migration tap, which was the point of the original design.
function setupSheets(force) {
  const cache = CacheService.getScriptCache();
  const key = schemaKey_();
  if (!force && cache.get(key) === 'ok') return;
  setupSheetsUncached_();
  cache.put(key, 'ok', 21600);   // 6h, the Apps Script maximum
}

function setupSheetsUncached_() {
  Object.entries(SHEETS).forEach(([name, headers]) => {
    const ss = ssFor(name);
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    const firstCell = sheet.getRange(1, 1).getValue();
    if (!firstCell) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f3f2ef');
      // v4.18. Macros is NO LONGER seeded with You / Flatmate1 / Flatmate2. Every new kitchen
      // started with three placeholder people nobody asked for. A kitchen starts empty and each
      // person adds themselves in onboarding.
    } else {
      // A sheet that already exists may predate a column we've since added
      // (e.g. DishMacros.CookKnows). Backfill only the missing trailing header
      // cells — never rewrite ones that are already filled in.
      if (sheet.getMaxColumns() < headers.length)
        sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
      const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
      let changed = false;
      for (let c = 0; c < headers.length; c++) {
        if (!existing[c]) { existing[c] = headers[c]; changed = true; }
      }
      if (changed) {
        sheet.getRange(1, 1, 1, headers.length).setValues([existing])
             .setFontWeight('bold').setBackground('#f3f2ef');
      }
    }
  });
}

// ── getAll (v3.6, speed) ───────────────────────────────────────────────────
// syncAll fired 11 separate GETs. Apps Script serialises concurrent requests
// from the same user, so "parallel" was a lie — they queued, and each one paid
// the full request tax again (setupSheets, openById, JSON envelope). One request
// that reads every tab in a single execution shares all of that.
//
// Each reader is wrapped individually: one bad tab must degrade to an error on
// that key alone, not take the whole sync down. That is strictly safer than the
// old shape, where a thrown reader killed only its own fetch by luck of Promise.all
// ordering. Keys match the old action names exactly so the client can merge the
// two shapes without a translation layer.
const ALL_READERS = {
  getPeople:      getPeople,
  getInventory:   getInventory,
  getMealLog:     getMealLog,
  getMacros:      getMacros,
  getPreferences: getPreferences,
  getWorkoutLog:  function () { return getWorkoutLog({}); },
  getCookSkills:  getCookSkills,
  getWishlist:    getWishlist,
  getMenu:        getMenu,
  getMealPlans:   getMealPlans,
  getHousehold:   getHousehold,
  // v3.7. Measures (~40 rows) and Recipes (~tens) are small and change, so they
  // ride along. `getIngredients` deliberately does NOT — 542 rows of static IFCT
  // data on a 30-second poll would hand back the request budget this batch just
  // saved. It is fetched once and cached client-side; lab values do not change.
  getMeasures:    getMeasures,
  // v3.12. Small (a handful of dishes for today+tomorrow) and it changes whenever
  // anyone adds — so it must ride the 30s sync, or a flatmate's addition wouldn't
  // show up until someone reloaded.
  getCookNext:    getCookNext,
  // v4.13. The dish catalogue was missing here, so the combined sync never delivered it: the
  // page kept whatever catalogue it had (none), every dish looked unknown, and no calories
  // or stock counted. Fallback-only fetching hid it. Must match the client's getAll merge.
  getDishCatalog: getDishCatalog
};

function getAll(want) {
  // `want` is an optional comma-separated whitelist, so a caller that only needs
  // the menu after a write doesn't pay for the whole sheet.
  const only = want ? String(want).split(',').map(function (s) { return s.trim(); }).filter(String) : null;
  const out = { batch: true };
  Object.keys(ALL_READERS).forEach(function (k) {
    if (only && only.indexOf(k) === -1) return;
    try { out[k] = ALL_READERS[k](); }
    catch (err) { out[k] = { error: String(err && err.message || err) }; }
  });
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// MACRO FOUNDATION (v3.7) — ingredients, measures, recipes
// ══════════════════════════════════════════════════════════════════════════════

// v4.19. Columns are found by HEADER NAME, not position. The live Ingredients tab has Density
// BEFORE Common/Source (the order in the uploaded workbook), while this file's SHEETS list has
// it after, so the positional read took Density (0.85) for Common and Common ('yes') for Source:
// no ingredient counted as common, and every density read as 0 (so "1 l" or "500 ml" of
// anything could not be deducted). Reading by name makes the order irrelevant.
function ingredientCols_(sheet) {
  const hdr = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]
    .map(h => String(h || '').trim().toLowerCase());
  const c = {};
  ['ingid','name','fullname','hindi','aliases','group','state','kcal','protein','carbs','fat','fiber',
   'density','common','source','confidence','piecegrams'].forEach(k => { c[k] = hdr.indexOf(k); });
  return { c: c, width: hdr.length };
}
function getIngredients() {
  const sheet = getSheet('Ingredients');
  const rows = getDataRows(sheet);
  const c = ingredientCols_(sheet).c;
  const g = (r, k) => (c[k] > -1 ? r[c[k]] : '');
  return { ingredients: rows.map(r => ({
    id: g(r, 'ingid'), name: g(r, 'name'), fullName: g(r, 'fullname'), hindi: g(r, 'hindi'),
    aliases: String(g(r, 'aliases') || '').split(';').map(s => s.trim().toLowerCase()).filter(Boolean),
    group: g(r, 'group'), state: g(r, 'state'),
    kcal: +g(r, 'kcal') || 0, p: +g(r, 'protein') || 0, c: +g(r, 'carbs') || 0,
    f: +g(r, 'fat') || 0, fib: +g(r, 'fiber') || 0,
    common: g(r, 'common'), source: g(r, 'source'),
    // v4.12. Needed to turn "1 l" or "6 pcs" on a shelf into grams.
    density: +g(r, 'density') || 0, confidence: g(r, 'confidence') || '', pieceGrams: +g(r, 'piecegrams') || 0
  })) };
}

// v4.19. The library learns ingredients. A dish that needs something not in the table (curry
// leaves, say) gets it added here, in the same shape as every other row, flagged 'estimated'
// so it is never mistaken for a lab value. Per 100 g of the raw ingredient. De-duplicated by
// name or alias: an ingredient that already exists is returned, not added twice.
function addIngredients(body) {
  const items = Array.isArray(body && body.items) ? body.items.slice(0, 20) : [];
  if (!items.length) return { success: true, ids: {}, added: 0 };
  const out = withScriptLock_(function () {
    const sheet = getSheet('Ingredients');
    const meta = ingredientCols_(sheet), c = meta.c;
    const rows = getDataRows(sheet);
    const g = (r, k) => (c[k] > -1 ? r[c[k]] : '');
    const taken = {}, byName = {};
    rows.forEach(function (r) {
      taken[String(g(r, 'ingid')).toLowerCase()] = 1;
      [g(r, 'name')].concat(String(g(r, 'aliases') || '').split(';')).forEach(function (n) {
        const k = String(n || '').trim().toLowerCase();
        if (k) byName[k] = String(g(r, 'ingid'));
      });
    });
    const ids = {}, built = [];
    items.forEach(function (it) {
      const name = String((it && it.name) || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!name || name.length > 40 || !/^[a-z0-9 ()\-]+$/.test(name)) return;
      if (byName[name]) { ids[name] = byName[name]; return; }
      const num = function (v, hi) { v = +v; return (isFinite(v) && v >= 0 && v <= hi) ? v : NaN; };
      const kcal = num(it.kcal, 900), p = num(it.p, 100), cb = num(it.c, 100), f = num(it.f, 100), fib = num(it.fib, 100);
      if ([kcal, p, cb, f, fib].some(isNaN) || p + cb + f > 105) return;
      let id = name.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'ingredient', n = 2;
      const base = id;
      while (taken[id]) { id = base + '_' + n; n++; }
      taken[id] = 1; byName[name] = id; ids[name] = id;
      const row = new Array(meta.width).fill('');
      const put = function (k, v) { if (c[k] > -1) row[c[k]] = v; };
      put('ingid', id); put('name', name); put('fullname', String(it.fullName || name));
      put('hindi', String(it.hindi || '')); put('aliases', ''); put('group', String(it.group || 'Other'));
      put('state', String(it.state || 'raw')); put('kcal', kcal); put('protein', p); put('carbs', cb);
      put('fat', f); put('fiber', fib); put('density', +it.density > 0 ? +it.density : '');
      put('common', 'yes'); put('source', 'Claude estimate'); put('confidence', 'estimated');
      put('piecegrams', +it.pieceGrams > 0 ? +it.pieceGrams : '');
      built.push(row);
    });
    if (built.length) sheet.getRange(sheet.getLastRow() + 1, 1, built.length, meta.width).setValues(built);
    return { success: true, ids: ids, added: built.length };
  }, 15000);
  return (out && out.status === 'busy') ? { success: false, error: 'busy, try again' } : out;
}

// v4.7. Utensil geometry only. `grams` is deliberately absent: it is no longer a
// property of a measure, because it depends on what is IN the measure. Callers
// wanting grams must go through the dish's class density.
function getMeasures() {
  const rows = getDataRows(getSheet('Measures'));
  return { measures: rows.map(r => ({
    measure: String(r[0] || ''), hindi: r[1] || '',
    type: String(r[2] || 'volume').toLowerCase(),
    volumeMl: +r[3] || 0, note: r[4] || ''
  })) };
}

// v4.7. Sets a utensil's VOLUME, not its weight. The old version recorded a
// scale reading for (measure, foodClass); that pairing no longer exists, and the
// live sheet had no Weigh='done' rows to preserve when the tab was redefined.
//
// Volume is a property of the vessel, so a correction here is genuinely global:
// measure your own katori once and every dish's portion maths improves at once.
function setMeasure(body) {
  const sheet = getSheet('Measures');
  const rows = getDataRows(sheet);
  const m = String(body.measure || '').trim();
  if (!m) return { error: 'measure required' };
  const ml = parseFloat(body.volumeMl);
  if (!isFinite(ml) || ml < 0) return { error: 'volumeMl must be a non-negative number' };

  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() === m.toLowerCase()) {
      sheet.getRange(i + 2, 4).setValue(ml);
      if (body.note) sheet.getRange(i + 2, 5).setValue(body.note);
      return { success: true, updated: true };
    }
  }
  sheet.appendRow([m, body.hindi || '', body.type || 'volume', ml, body.note || '']);
  return { success: true, created: true };
}

// One-time bulk seed. Rows arrive as arrays in sheet-column order so the client
// can post a parsed CSV without the backend needing a CSV parser. Existing rows
// with Weigh='done' survive: seeding is additive to defaults, never to measurements.
function seedTable(body) {
  const name = body.sheet;
  // v4.7. DishCatalog and DishIngredients join the seedable tabs. DishCatalog is
  // handled separately below because its rows are FORMULAS, not values — the
  // generic path at the bottom would write the seed's numbers straight over them.
  const SEEDABLE = ['Ingredients', 'Measures', 'DishCatalog', 'DishIngredients'];
  if (SEEDABLE.indexOf(name) === -1) return { error: 'seedTable accepts: ' + SEEDABLE.join(', ') };
  const rows = body.rows || [];
  if (!rows.length) return { error: 'no rows' };
  const sheet = getSheet(name);

  // v4.7. The Weigh='done' preservation branch is gone with the column it guarded.
  // Measures now reseeds cleanly because a utensil's volume is not measured data
  // about this household — it is a fact about the utensil.

  // DishCatalog: seed rows carry only the seven inputs; every computed column is
  // rebuilt as a formula bound to its own row number.
  if (name === 'DishCatalog') {
    clearDataRows(sheet);
    const built = rows.map((r, i) => dishCatalogRow_(i + 2, {
      dishId: r[0], name: r[1], aliases: r[2], hindi: r[3], region: r[4],
      status: r[5] || 'active', createdAt: r[6] || istNow(), classId: r[7],
      evapOverride: r[8], pieces: r[9], servings: r[10],
      inputConfidence: r[11] || 'confirmed'
    }));
    sheet.getRange(2, 1, built.length, SHEETS.DishCatalog.length).setValues(built);
    return { success: true, written: built.length };
  }

  // DishIngredients: RawGrams is the input; the five macro columns are formulas
  // that scale the Ingredients per-100g values, so a corrected lab value
  // propagates to every dish using that ingredient.
  if (name === 'DishIngredients') {
    clearDataRows(sheet);
    const I = 'Ingredients!';
    const built = rows.map((r, i) => {
      const n = i + 2;
      const mac = col => '=$E' + n + '/100*IFERROR(INDEX(' + I + '$' + col + ':$' + col +
                         ',MATCH($C' + n + ',' + I + '$A:$A,0)),0)';
      return [r[0],
        '=IFERROR(INDEX(DishCatalog!$B:$B,MATCH($A' + n + ',DishCatalog!$A:$A,0)),"")',
        r[2],
        '=IFERROR(INDEX(' + I + '$B:$B,MATCH($C' + n + ',' + I + '$A:$A,0)),"?")',
        +r[4] || 0,
        mac('H'), mac('I'), mac('J'), mac('K'), mac('L')];
    });
    sheet.getRange(2, 1, built.length, SHEETS.DishIngredients.length).setValues(built);
    return { success: true, written: built.length };
  }

  clearDataRows(sheet);
  const width = SHEETS[name].length;
  const norm = rows.map(r => { const o = r.slice(0, width); while (o.length < width) o.push(''); return o; });
  // Chunked: a single setValues of 542 rows is fine, but the client may post in
  // batches to stay under the URL/payload limit, so appending is the safe shape.
  sheet.getRange(2, 1, norm.length, width).setValues(norm);
  return { success: true, written: norm.length };
}


// ── The resolver: free text → a canonical ingredient ────────────────────────
// This is what stops "Amul Taaza Toned Milk 500ml" and "toned milk" becoming two
// inventory rows. Matching is deliberately staged from most to least confident,
// and returns the confidence so the caller can decide whether to ask. Guessing
// silently is how the inventory got into its current state.
function resolveIngredient(text, ings) {
  const raw = String(text || '').toLowerCase();
  if (!raw.trim()) return null;

  // Strip the noise a delivery-app line carries: pack sizes, counts, and the
  // brand names that fragment the same food into a dozen rows. Brands are dropped
  // wholesale rather than listed — a whitelist would need updating forever.
  let t = raw
    .replace(/\b\d+(\.\d+)?\s*(kg|g|gm|gms|gram|grams|ml|l|ltr|litre|liter|pcs|pc|piece|pieces|pack|packet|no|nos)\b/g, ' ')
    .replace(/\b(pack of|combo|value|family|fresh|premium|select|classic|regular|original|natural|pure|farm)\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;

  const common = ings.filter(i => i.common === 'yes');
  const eq = (a, b) => a === b;

  // Every name a row answers to: its canonical name plus its curated aliases.
  const namesOf = i => [i.name].concat(i.aliases || []);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 1. Exact match on the canonical name or any alias.
  let hit = common.find(i => namesOf(i).some(n => eq(n, t)));
  if (hit) return { ing: hit, confidence: 'exact', cleaned: t };

  // 2. A name appears as a whole phrase inside the text. The LONGEST matching
  //    name wins across all rows, so "toned milk" beats "milk" and "coconut oil"
  //    beats "oil" — brand dropped, variant kept, which is the rule chosen for
  //    inventory. Matching on the longest name rather than the first is the
  //    entire difference between this working and it destroying the data.
  let best = null, bestLen = 0;
  common.forEach(i => namesOf(i).forEach(n => {
    if (n.length <= bestLen) return;
    if (new RegExp('(^|\\s)' + esc(n) + '($|\\s)').test(t)) { best = i; bestLen = n.length; }
  }));
  if (best) return { ing: best, confidence: 'contained', cleaned: t };

  // 3. Token overlap, for word-order differences ("dal chana" vs "chana dal").
  //    Requires every token of the ingredient name to be present — a single
  //    shared token is not a match, or "oil" swallows "coconut oil".
  const toks = t.split(' ').filter(Boolean);
  let tBest = null, tLen = 0;
  common.forEach(i => namesOf(i).forEach(n => {
    const w = n.split(' ').filter(Boolean);
    if (w.length <= tLen) return;
    if (w.every(x => toks.indexOf(x) > -1)) { tBest = i; tLen = w.length; }
  }));
  if (tBest) return { ing: tBest, confidence: 'tokens', cleaned: t };

  return { ing: null, confidence: 'none', cleaned: t };
}

function resolveInventoryNames(body) {
  const ings = getIngredients().ingredients;
  const items = body.items || [];
  return { resolved: items.map(txt => {
    const r = resolveIngredient(txt, ings);
    return { input: txt,
             ingID: r && r.ing ? r.ing.id : '',
             name:  r && r.ing ? r.ing.name : '',
             confidence: r ? r.confidence : 'none' };
  }) };
}


// ── v4.7 portion math: the layer that turns "2 katori" into grams ───────────
// This is the point of the whole rebuild. Everything below is pure arithmetic
// over data the sheet already computed — no model call, no guessing, no stored
// per-serving numbers that go stale.
//
//   grams = qty x volumeMl x bulkDensity x fillFactor      (volume utensils)
//   grams = qty x gramsPerPiece                            (counted items)
//
// Density and fill come from the dish's CLASS, so correcting one class fixes
// every dish in it at once.

function catalogIndex_() {
  const dishes = getDishCatalog().dishes;
  const byId = {}, byName = {};
  dishes.forEach(d => {
    byId[d.dishId] = d;
    if (d.canonicalName) byName[String(d.canonicalName).trim().toLowerCase()] = d;
    (d.aliases || []).forEach(a => { byName[String(a).trim().toLowerCase()] = d; });
  });
  return { byId: byId, byName: byName, all: dishes };
}

// Free text or an ID in, one catalog row out. Deliberately exact-match only:
// fuzzy matching belongs in resolveIngredient's staged resolver, and guessing
// silently here would attach a meal to the wrong dish's macros.
function resolveDish(nameOrId, idx) {
  idx = idx || catalogIndex_();
  const k = String(nameOrId || '').trim();
  if (!k) return null;
  return idx.byId[k] || idx.byName[k.toLowerCase()] || null;
}

// Grams for a portion. Returns { grams, basis, known }.
// `known: false` is NOT an error and must not be shown as zero — it means the
// dish has no class or no ingredients yet, so no honest number exists. The
// caller should offer classification (see addDishToLibrary) instead.
function portionToGrams(body) {
  const idx  = catalogIndex_();
  const dish = resolveDish(body.dishId || body.dish, idx);
  if (!dish) return { known: false, grams: 0, reason: 'dish not in catalog' };

  const qty = parseFloat(body.qty);
  const q   = (isFinite(qty) && qty > 0) ? Math.min(50, qty) : 1;

  // Counted dishes ignore volume entirely — a roti has no density.
  if (dish.servedAs === 'piece' || String(body.measure || '').toLowerCase() === 'piece') {
    if (!dish.gramsPerPiece) return { known: false, grams: 0, qty: q,
      reason: 'dish is counted but has no Pieces set' };
    return { known: true, grams: Math.round(q * dish.gramsPerPiece), qty: q,
             measure: 'Piece', basis: 'piece' };
  }

  const measures = getMeasures().measures;
  const want = String(body.measure || 'Katori, standard').toLowerCase();
  let m = null;
  for (let i = 0; i < measures.length; i++) {
    if (String(measures[i].measure).toLowerCase() === want) { m = measures[i]; break; }
  }
  if (!m) return { known: false, grams: 0, qty: q, reason: 'unknown measure: ' + body.measure };
  if (!dish.bulkDensity) return { known: false, grams: 0, qty: q,
    reason: 'dish has no class yet', needsClassification: true, dishId: dish.dishId };

  const grams = q * m.volumeMl * dish.bulkDensity * (dish.fillFactor || 1);
  return { known: true, grams: Math.round(grams), qty: q,
           measure: m.measure, basis: 'volume' };
}

// Macros for a portion, straight from the dish's per-100g figures.
// Those figures are themselves formulas over DishIngredients, so a corrected
// ingredient weight moves this number without anything being recomputed here.
function macrosForPortion(body) {
  const g = portionToGrams(body);
  if (!g.known) return { known: false, reason: g.reason,
                         needsClassification: !!g.needsClassification,
                         dishId: g.dishId || '', macros: null };
  const dish = resolveDish(body.dishId || body.dish);
  const p = dish.per100g || {};
  if (p.kcal == null) return { known: false, reason: 'dish has no ingredients yet',
                               needsClassification: true, dishId: dish.dishId, macros: null };
  const at = v => (v == null) ? null : Math.round(v * g.grams / 100 * 10) / 10;
  return {
    known: true, grams: g.grams, qty: g.qty, measure: g.measure, basis: g.basis,
    dishId: dish.dishId, inputConfidence: dish.inputConfidence,
    macros: { kcal: at(p.kcal), protein: at(p.p), carbs: at(p.c),
              fat: at(p.f), fiber: at(p.fib) }
  };
}

// Inventory deduction from a portion. Reads DishIngredients, which since v4.8 is
// the only table that says what a dish contains.
//
// A portion of `grams` out of a batch yielding `yieldGrams` consumed that
// fraction of every RAW ingredient that went in. Water is skipped: it is in the
// table to make the mass balance honest, not because anyone stocks it.
function deductionForPortion(body) {
  const g = portionToGrams(body);
  const dish = resolveDish(body.dishId || body.dish);
  if (!g.known || !dish) return { deductions: [], exact: false, reason: g.reason || 'unknown dish' };
  if (!dish.yieldGrams) return { deductions: [], exact: false, reason: 'dish has no ingredients yet' };

  const rows = getDataRows(getSheet('DishIngredients'))
    .filter(r => String(r[0]).trim() === dish.dishId);
  if (!rows.length) return { deductions: [], exact: false, reason: 'no ingredient rows' };

  const frac = g.grams / dish.yieldGrams;
  return {
    exact: true, grams: g.grams, fractionOfBatch: Math.round(frac * 1000) / 1000,
    deductions: rows
      .filter(r => String(r[2]).toLowerCase() !== 'water')
      .map(r => ({ ingID: r[2], name: r[3] || r[2],
                   grams: Math.round((+r[4] || 0) * frac) }))
      .filter(d => d.grams > 0)
  };
}

// Adds a dish the catalog did not have, or classifies one that arrived
// unclassified. The INPUTS arrive already estimated — Code.gs has never called
// Claude and does not start now; the client makes exactly one call per dish and
// posts the result here. From then on the sheet computes that dish forever.
//
// Writes ONLY input columns. Every computed column is left as its formula, which
// is why this goes through dishCatalogRow_() rather than assembling an array.
function addDishToLibrary(body) {
  const name = String(body.name || body.dish || '').trim();
  if (!name) return { success: false, error: 'name required' };
  const classId = String(body.classId || '').trim();
  if (!classId) return { success: false, error: 'classId required' };

  const validClass = getDataRows(getSheet('DishClasses'))
    .some(r => String(r[0]).trim() === classId);
  if (!validClass) return { success: false, error: 'unknown classId: ' + classId };

  const items = (body.ingredients || [])
    .map(it => ({ ing: String(it.ing || it.ingID || '').trim(), g: +it.g || 0 }))
    .filter(it => it.ing && it.g > 0);
  if (!items.length) return { success: false, error: 'at least one ingredient required' };

  const sheet = getSheet('DishCatalog');
  const data  = getDataRows(sheet);
  let row = -1, dishId = String(body.dishId || '').trim();
  for (let i = 0; i < data.length; i++) {
    if ((dishId && data[i][0] === dishId) ||
        String(data[i][1] || '').trim().toLowerCase() === name.toLowerCase()) {
      row = i + 2; dishId = data[i][0]; break;
    }
  }
  // v4.23. A dish that already has a class is a finished library row. Only the owner may rewrite it;
  // anyone else asking is told it is already there (so two phones learning the same dish both succeed).
  if (row > -1 && String(data[row - 2][7] || '').trim() && requireOwner_(body))
    return { success: true, already: true, dishId: data[row - 2][0] };
  const opts = {
    dishId: dishId || uniqueSlug(name, data.map(r => r[0])),
    name: name, aliases: body.aliases || '', hindi: body.hindi || '',
    region: body.region || '', status: 'active',
    createdAt: (row > -1 ? data[row - 2][6] : '') || istNow(),
    classId: classId, pieces: body.pieces, servings: body.servings,
    // Marked estimated, never confirmed. A guess presented as a measurement is
    // the failure this column exists to prevent.
    inputConfidence: body.inputConfidence || 'estimated',
    // Carried forward explicitly. Rebuilding the row without these would silently
    // erase a prep note the household had already learned.
    prepNote: (row > -1 ? data[row - 2][39] : '') || body.prepNote || '',
    prepHours: (row > -1 ? data[row - 2][40] : '') || body.prepHours || '',
    common: (row > -1 ? data[row - 2][41] : '') || body.common || ''
  };
  if (row === -1) row = getLastDataRow(sheet) + 1;
  sheet.getRange(row, 1, 1, SHEETS.DishCatalog.length)
       .setValues([dishCatalogRow_(row, opts)]);

  // Replace this dish's ingredient rows wholesale. Bottom-up delete so earlier
  // indices stay valid as rows disappear.
  const di = getSheet('DishIngredients');
  const diData = getDataRows(di);
  for (let i = diData.length - 1; i >= 0; i--) {
    if (String(diData[i][0]).trim() === opts.dishId) di.deleteRow(i + 2);
  }
  const start = getLastDataRow(di) + 1;
  const I = 'Ingredients!';
  const built = items.map((it, k) => {
    const n = start + k;
    const mac = col => '=$E' + n + '/100*IFERROR(INDEX(' + I + '$' + col + ':$' + col +
                       ',MATCH($C' + n + ',' + I + '$A:$A,0)),0)';
    return [opts.dishId,
      '=IFERROR(INDEX(DishCatalog!$B:$B,MATCH($A' + n + ',DishCatalog!$A:$A,0)),"")',
      it.ing,
      '=IFERROR(INDEX(' + I + '$B:$B,MATCH($C' + n + ',' + I + '$A:$A,0)),"?")',
      it.g, mac('H'), mac('I'), mac('J'), mac('K'), mac('L')];
  });
  di.getRange(start, 1, built.length, SHEETS.DishIngredients.length).setValues(built);
  SpreadsheetApp.flush();   // v4.19: let the formulas calculate before anyone reads the new row

  return { success: true, dishId: opts.dishId, ingredients: built.length,
           inputConfidence: opts.inputConfidence };
}

// The portion to pre-select next time. v4.7: whatever this household logged for
// this dish most recently — people are consistent, and a remembered "2 katori"
// beats a generic default. Falls back to one standard katori, or one piece for
// counted dishes.
function defaultPortionFor(body) {
  const dish = resolveDish(body.dishId || body.dish);
  const fallback = (dish && dish.servedAs === 'piece')
    ? { qty: 1, measure: 'Piece' } : { qty: 1, measure: 'Katori, standard' };
  if (!dish) return Object.assign({ source: 'fallback' }, fallback);

  const rows = getDataRows(getSheet('MealLog'));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][5] || '').trim() !== dish.dishId) continue;
    const qty = parseFloat(rows[i][10]), measure = String(rows[i][11] || '').trim();
    if (isFinite(qty) && qty > 0 && measure)
      return { qty: qty, measure: measure, source: 'last logged' };
  }
  return Object.assign({ source: 'fallback' }, fallback);
}

// Which dishes actually get eaten, most first. Drives the top-20 recipe batch —
// writing recipes for dishes nobody cooks is the fastest way to waste the one
// sitting of attention this gets.
function getTopDishes(body) {
  const rows = getDataRows(getSheet('MealLog'));
  const limit = parseInt(body && body.limit) || 20;
  const counts = {};
  rows.forEach(function (r) {
    const d = String(r[1] || '').trim();
    if (!d) return;
    const k = d.toLowerCase();
    if (!counts[k]) counts[k] = { dish: d, dishID: r[5] || '', count: 0, last: r[0] };
    counts[k].count++;
    if (r[5] && !counts[k].dishID) counts[k].dishID = r[5];
  });
  const list = Object.keys(counts).map(function (k) { return counts[k]; })
    .sort(function (a, b) { return b.count - a.count; });

  // Which of them already have a recipe, so the batch can skip them. A 'draft'
  // is deliberately NOT skipped — it is incomplete and a fresh draft may be better.
  // An 'edited' one always is: someone spent judgement on those grams and a batch
  // must never quietly overwrite that.
  // v4.8. "Has a recipe" now means "the library knows what is in it", which is the
  // same question asked of the table that can actually answer it.
  const have = {};
  getDataRows(getSheet('DishIngredients')).forEach(function (r) {
    if (r[0]) have[String(r[0]).trim()] = true;
  });
  const idx = catalogIndex_();
  return { dishes: list.slice(0, limit).map(function (d) {
    const c = idx.byName[String(d.dish || '').trim().toLowerCase()];
    d.hasRecipe = !!(c && have[c.dishId]);
    return d;
  }), totalDistinct: list.length };
}

// ── Canonicalising the existing inventory (v3.8) ────────────────────────────
// Rewrites the Inventory sheet so each distinct food is ONE row under its
// canonical name, merging the brand-fragmented duplicates that are already there.
// Quantities are summed only when the units match — adding 500 ml to 1 kg would
// invent a number, so mismatched units keep their rows and are reported instead.
function canonicaliseInventory(body) {
  const ings = getIngredients().ingredients;
  const sheet = getSheet('Inventory');
  const rows = getDataRows(sheet);
  const groups = {}, untouched = [];

  rows.forEach(function (r) {
    const res = resolveIngredient(r[0], ings);
    if (!res || !res.ing || res.confidence === 'none') { untouched.push(r); return; }
    const unit = String(r[2] || '').toLowerCase().trim();
    const key = res.ing.id + '|' + unit;
    if (!groups[key]) groups[key] = { name: res.ing.name, unit: r[2], qty: 0, n: 0,
                                      updated: r[3], by: r[4], originals: [] };
    const q = parseFloat(r[1]);
    groups[key].qty += isFinite(q) ? q : 0;
    groups[key].n++;
    groups[key].originals.push(r[0]);
  });

  const merged = Object.keys(groups).map(function (k) { return groups[k]; });
  const collapsed = merged.filter(function (g) { return g.n > 1; });

  // Dry run by default. Rewriting someone's whole kitchen on a mistaken match is
  // not something to discover after the fact, so the preview is the default and
  // the write has to be asked for explicitly.
  if (!body || !body.apply) {
    return { preview: true, wouldMerge: collapsed.map(function (g) {
      return { into: g.name, from: g.originals };
    }), unresolved: untouched.map(function (r) { return r[0]; }),
    rowsBefore: rows.length, rowsAfter: merged.length + untouched.length };
  }

  const out = merged.map(function (g) {
    return [g.name, g.qty || '', g.unit || '', istNow(), g.by || ''];
  }).concat(untouched);
  clearDataRows(sheet);
  if (out.length) sheet.getRange(2, 1, out.length, 5).setValues(out);
  return { success: true, rowsBefore: rows.length, rowsAfter: out.length,
           mergedGroups: collapsed.length };
}

// ── Cook next, shared (v3.12) ───────────────────────────────────────────────
function getCookNext() {
  const rows = getDataRows(getSheet('CookNext'));
  // Only today and tomorrow are ever useful; older rows are dead weight on every
  // sync. They are filtered on read rather than deleted, so a device whose clock
  // is a few hours off doesn't destroy a menu somebody is still looking at.
  const keep = {};
  const d = new Date();
  for (let i = -1; i <= 1; i++) {
    const x = new Date(d); x.setDate(d.getDate() + i);
    keep[Utilities.formatDate(x, 'Asia/Kolkata', 'yyyy-MM-dd')] = true;
  }
  return { items: rows.filter(function (r) { return keep[String(r[1])]; }).map(function (r) {
    let hints = {}, missing = [];
    try { hints = JSON.parse(r[9] || '{}'); } catch (e) {}
    try { missing = JSON.parse(r[8] || '[]'); } catch (e) {}
    return { id: r[0], date: String(r[1]), slot: r[2], scope: r[3], dish: r[4],
             for: String(r[5] || '').split('|').filter(String),
             protein: +r[6] || 0, portion: r[7] || '', missing: missing, hints: hints,
             prep: r[10] || '', prepHours: +r[11] || 0, addedBy: r[12], addedAt: r[13] };
  }) };
}

// APPEND only. There is deliberately no "replace the menu" action: the rule chosen
// for this household is that anyone may add and nobody may replace, and the safest
// way to enforce that is for the destructive operation not to exist at the API.
// Duplicates are skipped rather than erroring — two phones adding the same dish at
// the same moment is a race with an obvious right answer, not a conflict.
function addCookNext(body) {
  const sheet = getSheet('CookNext');
  const lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { error: 'busy, try again' }; }
  try {
    const rows = getDataRows(sheet);
    const seen = {};
    rows.forEach(function (r) {
      seen[[r[1], r[2], r[3], String(r[4]).toLowerCase()].join('|')] = true;
    });
    const date = String(body.date || '');
    const slot = String(body.slot || '');
    const scope = String(body.scope || 'shared');
    const out = [], added = [];
    (body.items || []).forEach(function (m) {
      const dish = String(m.dish || '').trim();
      if (!dish) return;
      const k = [date, slot, scope, dish.toLowerCase()].join('|');
      if (seen[k]) return;
      seen[k] = true;
      const id = 'cn_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
      out.push([id, date, slot, scope, dish,
                (m.for || []).join('|'), +m.protein || 0, m.portion || '',
                JSON.stringify(m.missing || []), JSON.stringify(m.hints || {}),
                m.prep || '', +m.prepHours || 0, body.addedBy || '', istNow()]);
      added.push(dish);
    });
    if (out.length) sheet.getRange(sheet.getLastRow() + 1, 1, out.length, out[0].length).setValues(out);
    // v4.25. The menu is here now, so nobody is "building" it any more.
    CacheService.getScriptCache().remove(claimKey_(date, slot, scope));
    return { success: true, added: added.length, dishes: added };
  } finally { lock.releaseLock(); }
}

// v4.25. Two phones opened at lunchtime used to build two house menus: two paid Claude calls
// and two different answers. Before building, a phone asks here. The first one gets the job
// (claimed:true) for 90 seconds; any other phone is told who has it (claimed:false, by) and
// waits for that menu. If the menu already exists, everyone is told so (ready:true) and gets
// the list back. If the lock is busy, the phone just builds it (the old behaviour).
function claimKey_(date, slot, scope) {
  return 'cng_' + _activeHousehold_ + '_' + date + '_' + slot + '_' + scope;
}
function claimCookNext(body) {
  const date = String((body && body.date) || '').trim();
  const slot = String((body && body.slot) || '').trim().toLowerCase();
  const scope = String((body && body.scope) || 'shared').trim();
  const by = String((body && body.by) || '').trim().slice(0, 40);
  if (!date || !slot) return { error: 'date and slot required' };
  const out = withScriptLock_(function () {
    const items = getCookNext().items;
    if (items.some(function (x) { return x.date === date && x.slot === slot && x.scope === scope; }))
      return { success: true, claimed: false, ready: true, items: items };
    const cache = CacheService.getScriptCache();
    const key = claimKey_(date, slot, scope);
    const held = cache.get(key);
    if (held) {
      let h = {};
      try { h = JSON.parse(held) || {}; } catch (e) { h = {}; }
      if (h.by && h.by !== by) return { success: true, claimed: false, by: h.by, items: items };
    }
    cache.put(key, JSON.stringify({ by: by, at: Date.now() }), 90);
    return { success: true, claimed: true };
  }, 5000);
  return (out && out.status === 'busy') ? { success: true, claimed: true } : out;
}

// Removing ONE dish is not replacing the menu — it is the "no thanks" the menu has
// always supported. Removing by ID means one person's rejection cannot take a dish
// someone else added at the same second.
function removeCookNext(body) {
  const sheet = getSheet('CookNext');
  const rows = getDataRows(sheet);
  const id = String(body.id || '');
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === id) { sheet.deleteRow(i + 2); return { success: true }; }
  }
  return { success: false, reason: 'not found' };
}

// ── Inventory ──────────────────────────────────
function getInventory() {
  const data = getDataRows(getSheet('Inventory'));
  return { items: data.map(r => ({ item: r[0], quantity: r[1], unit: r[2], lastUpdated: r[3], updatedBy: r[4],
                                   ingId: String(r[5] || ''), brand: String(r[6] || '') })) };
}

function setInventory(items) {
  const sheet = getSheet('Inventory');
  clearDataRows(sheet);
  if (!items || !items.length) return { success: true };
  const now  = istNow();
  const rows = items.map(i => [i.item || i.name, i.quantity || i.qty, i.unit || '', now, i.updatedBy || 'App',
                               i.ingId || '', i.brand || '']);
  sheet.getRange(2, 1, rows.length, 7).setValues(rows);
  return { success: true, count: rows.length };
}

function addInventoryItem(body) {
  const sheet = getSheet('Inventory');
  const now   = istNow();
  const data  = getDataRows(sheet);
  const name  = (body.item || body.name || '').toLowerCase();
  for (let i = 0; i < data.length; i++) {
    if (data[i][0].toLowerCase() === name) {
      sheet.getRange(i + 2, 2).setValue(body.quantity || body.qty);
      sheet.getRange(i + 2, 4).setValue(now);
      sheet.getRange(i + 2, 5).setValue(body.updatedBy || 'App');
      if (body.ingId) sheet.getRange(i + 2, 6, 1, 2).setValues([[body.ingId, body.brand || '']]);
      return { success: true, action: 'updated' };
    }
  }
  sheet.getRange(getLastDataRow(sheet) + 1, 1, 1, 7).setValues([[
    body.item || body.name, body.quantity || body.qty, body.unit || '', now, body.updatedBy || 'App',
    body.ingId || '', body.brand || ''
  ]]);
  return { success: true, action: 'added' };
}

// v4.22. Many items in ONE round trip. The kitchen box used to post one request per line, each
// a separate Apps Script run (1-3 s apiece), so ten items meant twenty seconds of waiting.
// One read, one write for existing rows, one append for new ones, all under the script lock.
// An existing item (same name, case-insensitive) gets its quantity replaced, as before.
function ensureInventoryHeaders_(sheet) {
  if (!String(sheet.getRange(1, 6).getValue() || '').trim()) sheet.getRange(1, 6, 1, 2).setValues([['IngID', 'Brand']]).setFontWeight('bold');
}
function addInventoryItems(body) {
  const items = Array.isArray(body && body.items) ? body.items.slice(0, 80) : [];
  if (!items.length) return { success: true, added: 0, updated: 0 };
  const out = withScriptLock_(function () {
    const sheet = getSheet('Inventory');
    ensureInventoryHeaders_(sheet);
    const now = istNow(), by = (body && body.updatedBy) || 'App';
    const last = sheet.getLastRow();
    const data = last >= 2 ? sheet.getRange(2, 1, last - 1, 7).getValues() : [];
    const at = {};
    data.forEach(function (r, i) { if (r[0] !== '') at[String(r[0]).trim().toLowerCase()] = i; });
    const fresh = [];
    let updated = 0, dirty = false;
    items.forEach(function (it) {
      const name = String((it && (it.item || it.name)) || '').trim();
      const qty = (it && (it.quantity != null ? it.quantity : it.qty));
      if (!name || qty == null || qty === '') return;
      const k = name.toLowerCase();
      if (at[k] != null && at[k] >= 0 && at[k] < data.length) {
        const r = data[at[k]];
        r[1] = qty; r[3] = now; r[4] = by;
        if (it.ingId) { r[5] = it.ingId; r[6] = it.brand || ''; }
        dirty = true; updated++;
      } else if (at[k] != null) {
        const r = fresh[at[k] - data.length];
        r[1] = qty; if (it.ingId) { r[5] = it.ingId; r[6] = it.brand || ''; }
      } else {
        at[k] = data.length + fresh.length;
        fresh.push([name, qty, it.unit || '', now, by, it.ingId || '', it.brand || '']);
      }
    });
    if (dirty && data.length) sheet.getRange(2, 1, data.length, 7).setValues(data);
    if (fresh.length) sheet.getRange(Math.max(sheet.getLastRow(), 1) + 1, 1, fresh.length, 7).setValues(fresh);
    return { success: true, added: fresh.length, updated: updated };
  }, 15000);
  return (out && out.status === 'busy') ? { success: false, error: 'busy, try again' } : out;
}

// v4.22. Sets the library link on existing shelf rows (matched by the typed Item name). Used when
// a row is matched to an ingredient after the fact: an old row, or a new item that needed a question.
function linkInventory(body) {
  const links = Array.isArray(body && body.links) ? body.links.slice(0, 100) : [];
  if (!links.length) return { success: true, linked: 0 };
  const out = withScriptLock_(function () {
    const sheet = getSheet('Inventory');
    ensureInventoryHeaders_(sheet);
    const last = sheet.getLastRow();
    if (last < 2) return { success: true, linked: 0 };
    const names = sheet.getRange(2, 1, last - 1, 1).getValues();
    const cols = sheet.getRange(2, 6, last - 1, 2).getValues();
    const idx = {};
    names.forEach(function (r, i) { idx[String(r[0]).trim().toLowerCase()] = i; });
    let n = 0;
    links.forEach(function (l) {
      const i = idx[String((l && l.name) || '').trim().toLowerCase()];
      if (i == null || !l.ingId) return;
      cols[i] = [String(l.ingId), String(l.brand || '')]; n++;
    });
    if (n) sheet.getRange(2, 6, last - 1, 2).setValues(cols);
    return { success: true, linked: n };
  }, 15000);
  return (out && out.status === 'busy') ? { success: false, error: 'busy, try again' } : out;
}

// v4.22. "Rage coffee" means instant coffee, for every household. An alias is only ever ADDED, only to
// an ingredient that exists, and never one that is already another ingredient's name or alias,
// so a wrong answer cannot silently steal a name from a different ingredient.
function saveIngredientAlias(body) {
  const ingId = String((body && body.ingId) || '').trim();
  const alias = String((body && body.alias) || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!ingId) return { success: false, error: 'ingId required' };
  if (!/^[a-z0-9 ()\-]{2,60}$/.test(alias)) return { success: false, error: 'alias not allowed' };
  const out = withScriptLock_(function () {
    const sheet = getSheet('Ingredients');
    const meta = ingredientCols_(sheet), c = meta.c;
    if (c.aliases < 0 || c.ingid < 0) return { success: false, error: 'Ingredients sheet has no Aliases column' };
    const rows = getDataRows(sheet);
    let target = -1;
    for (let i = 0; i < rows.length; i++) {
      const rid = String(rows[i][c.ingid]).trim();
      const names = [String(rows[i][c.name] || '')].concat(String(rows[i][c.aliases] || '').split(';'))
        .map(function (x) { return x.trim().toLowerCase(); });
      if (rid === ingId) target = i;
      else if (names.indexOf(alias) > -1) return { success: false, error: 'already belongs to another ingredient' };
    }
    if (target < 0) return { success: false, error: 'unknown ingredient' };
    const have = String(rows[target][c.aliases] || '').split(';').map(function (x) { return x.trim(); }).filter(Boolean);
    if (String(rows[target][c.name] || '').trim().toLowerCase() !== alias &&
        have.map(function (x) { return x.toLowerCase(); }).indexOf(alias) < 0) have.push(alias);
    sheet.getRange(target + 2, c.aliases + 1).setValue(have.join(';'));
    return { success: true, ingId: ingId, aliases: have.map(function (x) { return x.toLowerCase(); }) };
  }, 15000);
  return (out && out.status === 'busy') ? { success: false, error: 'busy, try again' } : out;
}

function removeInventoryItem(itemName) {
  const sheet = getSheet('Inventory');
  const data  = getDataRows(sheet);
  for (let i = 0; i < data.length; i++) {
    if (data[i][0].toLowerCase() === itemName.toLowerCase()) {
      sheet.deleteRow(i + 2);
      return { success: true };
    }
  }
  return { success: false, error: 'Item not found' };
}

// NEW — reduces qty in place, no row deletion
function updateInventoryQty(body) {
  const sheet = getSheet('Inventory');
  const now   = istNow();
  const data  = getDataRows(sheet);
  const name  = (body.item || '').toLowerCase();
  for (let i = 0; i < data.length; i++) {
    if (data[i][0].toLowerCase() === name) {
      sheet.getRange(i + 2, 2).setValue(body.quantity);
      sheet.getRange(i + 2, 4).setValue(now);
      return { success: true };
    }
  }
  // Not found — add it
  sheet.getRange(getLastDataRow(sheet) + 1, 1, 1, 5).setValues([[body.item, body.quantity, '', now, 'App']]);
  return { success: true, created: true };
}

// ── Meal Log ───────────────────────────────────
// Every meal needs a stable handle before it can be edited or deleted. Historical
// rows predate LogID, so rather than asking anyone to run a migration (a lesson this
// project already paid for — see the shared-library migration), the read path mints
// and writes back any missing IDs once, on first read. Idempotent and invisible.
function getMealLog() {
  const sheet = getSheet('MealLog');
  const data  = getDataRows(sheet);
  const fills = [];
  data.forEach((r, i) => {
    if (!r[6]) { r[6] = newLogID(); fills.push([i + 2, r[6]]); }
  });
  fills.forEach(f => sheet.getRange(f[0], 7).setValue(f[1]));
  return { meals: data.map(r => ({
    date: mealDate_(r[0]), mealName: r[1], mealType: r[2], loggedBy: r[3], notes: r[4],
    dishId: r[5] || '', logId: r[6] || '', source: r[7] || 'manual',
    qty: (r[8] === '' || r[8] == null) ? null : (+r[8] || null),
    measure: r[9] || ''
  })).reverse() };
}

// v4.21. A MealLog date written as a date-time string ("21/10/2026, 1:05:00 am") is parsed by
// Sheets into a real Date, which serialises to JSON in UTC. For IST 00:00-05:29 that is the
// PREVIOUS calendar day, so the client filed the meal under yesterday and the day bar lost
// it on the next sync. Dates leave here as IST text, never as a Date.
function mealDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss');
  return v;
}

function newLogID() {
  return 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function logMeal(body) {
  const sheet = getSheet('MealLog');
  const name  = body.mealName || body.dish;
  const dishId = name ? lookupDishID_(name) : '';   // v4.11: read-only, '' when unmatched
  const logId = body.logId || newLogID();
  const logRow = getLastDataRow(sheet) + 1;
  sheet.getRange(logRow, 1).setNumberFormat('@');   // v4.21: keep the timestamp as text
  sheet.getRange(logRow, 1, 1, 10).setValues([[
    body.date || istNow(), name, body.mealType || 'Home cooked', body.loggedBy || 'App',
    body.notes || '', dishId, logId, body.source || 'manual',
    (body.qty === '' || body.qty == null) ? '' : (+body.qty || ''),
    body.measure || ''
  ]]);
  // v3.14. A hand-logged dish settles the question its Menu row was asking. That row
  // used to be DELETED by the client, which is why a dish you logged yourself vanished
  // off the menu while one the sweep logged did not. Now it is marked, exactly as the
  // sweep marks it, so the Menu can keep showing it as eaten. One call, so there is no
  // window where the meal exists and the row is still open for the sweep to log twice.
  let closed = 0;
  // v4.11. A hand-logged meal used to carry NO portion, so the day counted one standard
  // katori whatever was actually picked. When the caller sent no amount, take it from the
  // Menu row being closed: that row holds what was planned and, for a meal eaten as
  // planned, what was eaten.
  let portionFilled = !(body.qty === '' || body.qty == null);
  if (body.closeMenuRow) {
    const ms = getSheet('Menu');
    const md = getDataRows(ms);
    const wantDate = asISODate(body.menuDate || istToday());
    const wantSlot = String(body.mealType || '').trim().toLowerCase();
    const wantDish = String(name || '').trim().toLowerCase();
    const wantWho  = String(body.loggedBy || '').trim().toLowerCase();
    for (let i = 0; i < md.length; i++) {
      const r = md[i];
      if (String(r[6] || 'open') !== 'open') continue;
      if (asISODate(r[1]) !== wantDate) continue;
      if (String(r[2] || '').trim().toLowerCase() !== wantSlot) continue;
      if (String(r[3] || '').trim().toLowerCase() !== wantDish) continue;
      if (String(r[4] || '').trim().toLowerCase() !== wantWho) continue;
      ms.getRange(i + 2, 7).setValue('logged');
      ms.getRange(i + 2, 8).setValue(logId);
      if (!portionFilled && r[10] !== '' && r[10] != null && +r[10] > 0) {
        sheet.getRange(logRow, 9, 1, 2).setValues([[+r[10], r[11] || '']]);
        portionFilled = true;
      }
      closed++;
    }
  }
  // v4.12. The meal takes its ingredients off the shelf: here, so that the manual form, the
  // menu and the auto-log sweep all do it, once, from the amount actually stored.
  // Best effort: a stock problem must never cost someone their logged meal.
  let deduction = null;
  if (name) {
    try {
      const stored = sheet.getRange(logRow, 9, 1, 2).getValues()[0];
      const o = { logId: logId, dish: name, dishId: dishId, person: body.loggedBy || 'App',
                  qty: stored[0], measure: stored[1] };
      deduction = (body.deduct === false || body.deduct === 'no')
        ? recordSkippedDeduction_(logId, o, 'ate out')
        : applyDeduction_(o);
    } catch (e) { deduction = { status: 'error', error: String((e && e.message) || e) }; }
  }
  return { success: true, dishId: dishId, logId: logId, closedMenuRows: closed, deduction: deduction };
}

// Editing a logged meal changes the dish name, who ate it, or which slot it was.
// The row keeps its LogID so anything pointing at it (a swept Menu row) still
// resolves, and DishID is re-derived because the dish may now be a different dish.
function updateMealLog(body) {
  const logId = String(body.logId || '').trim();
  if (!logId) return { success: false, error: 'No logId' };
  const sheet = getSheet('MealLog');
  const data  = getDataRows(sheet);
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][6] || '').trim() !== logId) continue;
    const row = i + 2;
    if (body.mealName) {
      sheet.getRange(row, 2).setValue(body.mealName);
      sheet.getRange(row, 6).setValue(lookupDishID_(body.mealName));
    }
    if (body.mealType) sheet.getRange(row, 3).setValue(body.mealType);
    if (body.loggedBy) sheet.getRange(row, 4).setValue(body.loggedBy);
    // The amount travels with the meal — it IS the macros — so an edit that changed
    // the name but left the amount behind produced a half-corrected row.
    if (body.qty != null) sheet.getRange(row, 9).setValue(+body.qty || '');
    if (body.measure != null) sheet.getRange(row, 10).setValue(String(body.measure));
    // v4.12. A different dish, amount or person is a different deduction: take the old one
    // back off the shelf and apply the new one.
    let deduction = null;
    if (body.mealName || body.qty != null || body.measure != null || body.loggedBy) {
      try { deduction = redoDeduction_(logId); }
      catch (e) { deduction = { status: 'error', error: String((e && e.message) || e) }; }
    }
    return { success: true, deduction: deduction };
  }
  return { success: false, error: 'Meal not found' };
}

// Deleting also releases the Menu row that produced it, if there was one — so a
// wrongly auto-logged meal can be removed and then re-logged correctly, rather
// than leaving a Menu row permanently marked 'logged' with nothing behind it.
// Just the rows, no side effects. Split out of deleteMealLog so removeMenuItem can
// drop a meal WITHOUT the Menu row being reopened underneath it.
function deleteMealLogRows_(logId) {
  try { reverseDeduction_(logId); } catch (e) {}   // v4.12: the stock comes back with the meal
  const sheet = getSheet('MealLog');
  const data  = getDataRows(sheet);
  let removed = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    if (String(data[i][6] || '').trim() === logId) { sheet.deleteRow(i + 2); removed++; }
  }
  return removed;
}

function deleteMealLog(body) {
  const logId = String(body.logId || '').trim();
  if (!logId) return { success: false, error: 'No logId' };
  const removed = deleteMealLogRows_(logId);
  if (removed) {
    const ms = getSheet('Menu');
    const md = getDataRows(ms);
    for (let i = 0; i < md.length; i++) {
      if (String(md[i][7] || '').trim() === logId) {
        ms.getRange(i + 2, 7).setValue('open');
        ms.getRange(i + 2, 8).setValue('');
      }
    }
  }
  return { success: true, removed: removed };
}

// ── Grocery Orders ─────────────────────────────
function getGroceryOrders() {
  const data = getDataRows(getSheet('GroceryOrders'));
  return { orders: data.map(r => ({ date: r[0], item: r[1], quantity: r[2], orderedBy: r[3], appName: r[4] })).reverse() };
}

function saveGroceryOrder(body) {
  const sheet = getSheet('GroceryOrders');
  const items = body.items || [];
  if (!items.length) return { success: false, error: 'No items provided' };
  const now  = istNow();
  const rows = items.map(i => [now, i.item || i.name, i.quantity || i.qty, body.orderedBy || 'App', body.appName || 'Blinkit']);
  sheet.getRange(getLastDataRow(sheet) + 1, 1, rows.length, 5).setValues(rows);
  return { success: true, count: rows.length };
}

// ── Macros ─────────────────────────────────────
function getMacros() {
  const data = getDataRows(getSheet('Macros'));
  return { macros: data.map(r => ({ person: r[0], calories: Number(r[1]), protein: Number(r[2]),
    carbs: Number(r[3]), fat: Number(r[4]), weight: Number(r[5]), fiber: Number(r[6]) || 0 })) };
}

function updateMacros(body) {
  const sheet = getSheet('Macros');
  const data  = getDataRows(sheet);
  for (let i = 0; i < data.length; i++) {
    if (data[i][0].toLowerCase() === (body.person || '').toLowerCase()) {
      sheet.getRange(i + 2, 1, 1, 7).setValues([[
        body.person,
        body.calories || data[i][1],
        body.protein  || data[i][2],
        body.carbs    || data[i][3],
        body.fat      || data[i][4],
        body.weight   || data[i][5],
        body.fiber    || data[i][6]
      ]]);
      return { success: true };
    }
  }
  // Person not found — insert as new row
  sheet.getRange(getLastDataRow(sheet) + 1, 1, 1, 7).setValues([[
    body.person, body.calories || 0, body.protein || 0, body.carbs || 0, body.fat || 0,
    body.weight || 0, body.fiber || 0
  ]]);
  return { success: true, added: true };
}

// ── Workouts (NEW) ─────────────────────────────
function logWorkout(body) {
  const sheet = getSheet('Workouts');
  const date  = body.date || Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  sheet.getRange(getLastDataRow(sheet) + 1, 1, 1, 8).setValues([[
    date,
    body.person         || '',
    body.exercise       || '',
    body.muscleGroup    || '',
    body.sets           || '',  // JSON string: [{"reps":12,"weight":20},...]
    body.totalVolume    || 0,
    body.caloriesBurned || 0,
    istNow()
  ]]);
  return { success: true };
}

function getWorkoutLog(body) {
  const data   = getDataRows(getSheet('Workouts'));
  const person = body.person || null;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (parseInt(body.days) || 30));

  const workouts = data
    .filter(r => r[0] && (!person || r[1] === person) && new Date(r[0]) >= cutoff)
    .map(r => ({ date: r[0], person: r[1], exercise: r[2], muscleGroup: r[3], sets: r[4], totalVolume: r[5], caloriesBurned: r[6] }))
    .reverse();

  return { workouts };
}

// ── Preferences ────────────────────────────────
// Preferences rows written before the Favourites column existed had only six
// columns: the last of them was UpdatedAt, which now lands in the Favourites
// slot. Members added back then show a date and time as their favourite food.
// Anything that parses as one of our timestamps is that defect, not data.
function looksLikeTimestamp(v) {
  if (v instanceof Date) return true;
  const t = String(v || '').trim();
  if (!t) return false;
  return /^\d{1,2}\/\d{1,2}\/\d{2,4}[,\s]/.test(t) || /^\d{4}-\d{2}-\d{2}T/.test(t);
}

function getPreferences() {
  const sheet = getSheet('Preferences');
  const data  = getDataRows(sheet);
  data.forEach(function (r, i) {
    if (!looksLikeTimestamp(r[5])) return;
    // Self-heal: move the stray timestamp back to UpdatedAt and clear favourites,
    // so the row is right in the Sheet too and not just in this response.
    if (!r[6]) sheet.getRange(i + 2, 7).setValue(r[5]);
    sheet.getRange(i + 2, 6).setValue('');
    r[5] = '';
  });
  return { preferences: data.map(r => {
    let picks = null;
    try { picks = r[7] ? JSON.parse(r[7]) : null; } catch (e) { picks = null; }
    return { person: r[0], diet: r[1], likes: r[2], dislikes: r[3], allergies: r[4],
             favourites: looksLikeTimestamp(r[5]) ? '' : r[5], picks: picks };
  }) };
}

// Field-preserving: any field the caller omits keeps whatever is already on the row.
// The taste picker only knows about picks, and onboarding knows nothing about them —
// without this, whichever saved last would silently wipe the other's work.
function savePreferences(body) {
  const sheet = getSheet('Preferences');
  const data  = getDataRows(sheet);
  const now   = istNow();
  const keep = (incoming, existing) => (incoming === undefined || incoming === null)
    ? (existing === undefined || existing === null ? '' : existing) : incoming;

  for (let i = 0; i < data.length; i++) {
    if ((data[i][0] || '').toLowerCase() === (body.person || '').toLowerCase()) {
      const old = data[i];
      const row = [body.person,
                   keep(body.diet, old[1]), keep(body.likes, old[2]), keep(body.dislikes, old[3]),
                   keep(body.allergies, old[4]), keep(body.favourites, old[5]), now,
                   body.picks !== undefined ? JSON.stringify(body.picks || {}) : (old[7] || '')];
      sheet.getRange(i + 2, 1, 1, 8).setValues([row]);
      return { success: true, updated: true };
    }
  }
  sheet.getRange(getLastDataRow(sheet) + 1, 1, 1, 8).setValues([[
    body.person, body.diet || '', body.likes || '', body.dislikes || '',
    body.allergies || '', body.favourites || '', now,
    body.picks ? JSON.stringify(body.picks) : ''
  ]]);
  return { success: true, added: true };
}

// Records how well the cook makes a dish: 'avoid' | 'fine' | 'favourite'.
// Creates the dish row if it doesn't exist yet (rating can precede macros).
function rateDish(body) {
  if (!body.dish || !body.rating) return { success: false, error: 'Missing dish or rating' };
  return writeCookSkill(body.dish, { rating: body.rating }, body.updatedBy);
}

// Records whether the cook can already make a dish: 'yes' | 'no' | '' (unknown).
// This is deliberately separate from CookRating: rating answers "how well does
// it come out", this answers "can she make it at all". A dish outside her
// repertoire isn't a bad dish — it just needs teaching before it's orderable.
// Onboarding seeds the cook's repertoire in one go. Doing it as ten separate
// setCookKnows calls meant ten Apps Script executions — Apps Script serialises
// requests from the same user, so that is the better part of a minute of
// spinner at the exact moment someone is deciding whether this app is worth it.
// One read, one pass, one write.
function setCookKnowsBulk(body) {
  const raw = Array.isArray(body && body.dishes) ? body.dishes : [];
  const knows = (body && body.knows) === 'no' ? 'no' : 'yes';
  // Only onboarding passes 'seeded'. Anything else writing in bulk is doing it
  // on the household's behalf during ordinary use, which counts as learned.
  const source = (body && body.source) === 'seeded' ? 'seeded' : 'observed';

  // Dedupe first. Appending a row and then matching against it in the same pass
  // would hand back a data[] index that is not a sheet row, and the write would
  // land on the wrong dish.
  const seen = {}, dishes = [];
  raw.forEach(d => {
    const s = String(d || '').trim();
    const k = s.toLowerCase();
    if (!s || seen[k]) return;
    seen[k] = 1; dishes.push(s);
  });
  if (!dishes.length) return { success: true, saved: 0 };

  const sheet = getSheet('CookSkills');
  const data  = getSkillRows_();
  const appends = [];
  let updated = 0;

  dishes.forEach(dish => {
    const dishId = lookupDishID_(dish);
    const i = findSkillRow(data, dishId, dish);
    const prev = i > -1 ? data[i] : ['', '', '', '', 0, '', '', ''];
    const row = [dishId, dish, knows, prev[3] || '', Number(prev[4]) || 0,
                 (body && body.updatedBy) || 'App', istNow(), source];
    if (i > -1) { sheet.getRange(i + 2, 1, 1, 8).setValues([row]); data[i] = row; updated++; }
    else appends.push(row);
  });

  if (appends.length) {
    sheet.getRange(getLastDataRow(sheet) + 1, 1, appends.length, 8).setValues(appends);
  }
  return { success: true, saved: updated + appends.length };
}

function setCookKnows(body) {
  if (!body.dish) return { success: false, error: 'No dish' };
  const knows = body.knows === 'yes' ? 'yes' : body.knows === 'no' ? 'no' : '';
  return writeCookSkill(body.dish, { knows: knows }, body.updatedBy);
}

// ── Cook Skills (this household only) ──────────
function getCookSkills() {
  const data = getSkillRows_().filter(r => r[1] !== '');
  return { skills: data.map(r => ({
    dishId: r[0], dish: r[1], cookKnows: r[2] || '',
    cookRating: r[3] || '', ratingCount: Number(r[4]) || 0,
    updatedBy: r[5], updatedAt: r[6], source: r[7] || ''
  })) };
}

// v4.11. Every row, blank DishID included. Not getDataRows(): that drops rows whose first
// column is blank, and an unmatched dish legitimately has no DishID yet.
function getSkillRows_() {
  const sheet = getSheet('CookSkills');
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, SHEETS.CookSkills.length).getValues();
}

function findSkillRow(data, dishId, rawName) {
  const key = String(rawName).trim().toLowerCase();
  // v4.11. An unmatched dish now has a BLANK DishID. Without this guard every unmatched
  // dish would "match" the first other row with a blank ID, and one dish's rating would
  // silently overwrite another's. A blank ID falls through to matching by name.
  if (dishId) for (let i = 0; i < data.length; i++) if (data[i][0] === dishId) return i;
  for (let i = 0; i < data.length; i++)
    if (String(data[i][1]).trim().toLowerCase() === key) return i;
  return -1;
}

// Shared writer for both cook-facing facts. `patch` carries only the fields the
// caller actually knows; the rest survive untouched.
function writeCookSkill(dish, patch, updatedBy) {
  const dishId = lookupDishID_(dish);
  const sheet  = getSheet('CookSkills');
  const data   = getSkillRows_();
  const i = findSkillRow(data, dishId, dish);
  const prev = i > -1 ? data[i] : ['', '', '', '', 0, '', '', ''];

  const knows  = patch.knows  == null ? (prev[2] || '') : patch.knows;
  const rating = patch.rating == null ? (prev[3] || '') : patch.rating;
  const count  = patch.rating == null ? (Number(prev[4]) || 0) : (Number(prev[4]) || 0) + 1;
  // Provenance is sticky in one direction only: a dish that was seeded and has
  // since been rated or re-marked through ordinary use has been earned, so it
  // stops counting as seeded. Nothing ever becomes seeded after the fact.
  const source = patch.source || (prev[7] === 'seeded' && patch.knows == null ? 'seeded' : (prev[7] || 'observed'));
  const row = [dishId, String(dish).trim(), knows, rating, count, updatedBy || 'App', istNow(), source];

  if (i > -1) {
    sheet.getRange(i + 2, 1, 1, 8).setValues([row]);
    return { success: true, updated: true, dishId };
  }
  sheet.getRange(getLastDataRow(sheet) + 1, 1, 1, 8).setValues([row]);
  return { success: true, created: true, dishId };
}

// ── Dish Catalog (canonical registry) ──────────
// One row per real-world dish: a stable DishID, a display CanonicalName, and
// pipe-separated Aliases ("paneer ki bhurji|bhurji"). Everything that used to
// match dishes by raw string (macros, ratings, meal log) now resolves through
// this first, so near-duplicate spellings collapse into one row instead of
// silently fragmenting cook ratings and macros across several.
// IngredientRefs is intentionally blank/reserved — a future ingredient
// catalog can populate it without needing to re-migrate this sheet.
// v4.7. Reads the wide catalog. IngredientRefs is GONE — a dish's ingredients are
// rows in DishIngredients now, not a string in a cell. Status/CreatedAt shifted
// right by one (Hindi and Region were inserted), which is exactly the corruption
// the never-insert rule warns about: this reader had to move with them.
//
// Computed fields come back as whatever the sheet last calculated. A blank means
// the formula returned "" (no ingredients yet), not zero — the client must show
// that as unknown rather than as a dish with no calories.
// v4.21. What each dish is made of, raw grams per batch. Read once and cached by the client to
// work out what a portion needs against the shelf. Water is omitted: nobody stocks it.
function getDishIngredients() {
  const rows = getDataRows(getSheet('DishIngredients'));
  return { rows: rows
    .filter(r => String(r[2]).toLowerCase() !== 'water')
    .map(r => ({ dishId: String(r[0]).trim(), ingId: String(r[2]).trim(),
                 name: r[3] || r[2], g: +r[4] || 0 }))
    .filter(r => r.dishId && r.g > 0) };
}

function getDishCatalog() {
  const data = getDataRows(getSheet('DishCatalog'));
  const num = v => (v === '' || v == null) ? null : (+v || 0);
  return { dishes: data.map(r => ({
    dishId: r[0], canonicalName: r[1],
    aliases: String(r[2] || '').split('|').map(a => a.trim()).filter(Boolean),
    hindi: r[3] || '', region: r[4] || '',
    status: r[5] || 'active', createdAt: r[6],
    classId: r[7] || '', className: r[8] || '',
    servedAs: r[10] || '',
    // Density and fill are what let a portion in ANY utensil be computed, not
    // just the standard katori the sheet pre-computes in GramsPerStdKatori.
    bulkDensity: num(r[17]), fillFactor: num(r[18]),
    yieldGrams: num(r[14]), pieces: num(r[15]), gramsPerPiece: num(r[16]),
    gramsPerKatori: num(r[19]), katoriPerBatch: num(r[20]),
    per100g: { kcal: num(r[26]), p: num(r[27]), c: num(r[28]),
               f: num(r[29]), fib: num(r[30]) },
    perServing: { kcal: num(r[32]), p: num(r[33]), c: num(r[34]),
                  f: num(r[35]), fib: num(r[36]) },
    servingLabel: r[37] || '',
    // 'estimated' means Claude guessed this dish's class and ingredients during
    // migration. The client MUST surface that — an estimate shown as fact is the
    // failure mode this column exists to prevent.
    inputConfidence: r[38] || 'confirmed',
    prepNote: r[39] || '', prepHours: +r[40] || 0,
    common: (r[41] === '' || r[41] == null) ? null : String(r[41]).toLowerCase() === 'yes'
  })) };
}

// ── The formula row ──────────────────────────────────────────────────────────
// Builds the 39 cells for ONE DishCatalog row: inputs as values, everything else
// as a live formula string. Every caller that creates a dish must go through
// here. Writing a plain array instead is how the formulas get destroyed.
//
// Two deliberate departures from the source workbook, both because a live sheet
// grows and a static file does not:
//   1. Whole-column ranges. The workbook pinned $E$2:$E$893 — dish 108 would fall
//      outside every SUMIFS and silently total zero.
//   2. GramsPerStdKatori looks the standard katori up BY NAME. The workbook hard-
//      coded Measures!$D$3; reordering that tab would have silently rescaled every
//      dish in the system.
function dishCatalogRow_(r, o) {
  o = o || {};
  const K = 'INDEX(Measures!$D:$D,MATCH("Katori, standard",Measures!$A:$A,0))';
  const DI = 'DishIngredients!';
  const sum = col => '=SUMIFS(' + DI + '$' + col + ':$' + col + ',' + DI + '$A:$A,$A' + r + ')';
  const cls = col => '=IFERROR(INDEX(DishClasses!$' + col + ':$' + col +
                     ',MATCH($H' + r + ',DishClasses!$A:$A,0)),0)';
  // per-100g and per-serving share a shape; batch columns are V..Z, 100g AA..AE
  const p100 = b => '=IF($O' + r + '=0,"",ROUND($' + b + r + '/$O' + r + '*100,1))';
  const pSrv = b => '=IF($P' + r + '="",IF($O' + r + '=0,"",ROUND($' + b + r +
                    '*$T' + r + '/$O' + r + ',1)),ROUND($' + b + r + '/$P' + r + ',1))';
  return [
    o.dishId || '', o.name || '', o.aliases || '', o.hindi || '', o.region || '',
    o.status || 'active', o.createdAt || istNow(),
    o.classId || '',
    '=IFERROR(INDEX(DishClasses!$B:$B,MATCH($H' + r + ',DishClasses!$A:$A,0)),"")',
    (o.evapOverride === 0 || o.evapOverride) ? o.evapOverride : '',
    '=IF($R' + r + '=0,"piece","volume")',
    sum('E'),
    '=SUMIFS(' + DI + '$E:$E,' + DI + '$A:$A,$A' + r + ',' + DI + '$C:$C,"water")',
    '=IF($J' + r + '="",' + cls('F').slice(1) + ',$J' + r + ')',
    '=ROUND($L' + r + '*(1-$N' + r + '),0)',
    (o.pieces === 0 || o.pieces) ? o.pieces : '',
    '=IF($P' + r + '="","",ROUND($O' + r + '/$P' + r + ',0))',
    cls('D'), cls('E'),
    '=IF($R' + r + '=0,"",ROUND($R' + r + '*$S' + r + '*' + K + ',0))',
    '=IF(OR($R' + r + '=0,$T' + r + '=0),"",ROUND($O' + r + '/$T' + r + ',1))',
    sum('F'), sum('G'), sum('H'), sum('I'), sum('J'),
    p100('V'), p100('W'), p100('X'), p100('Y'), p100('Z'),
    (o.servings === 0 || o.servings) ? o.servings : '',
    pSrv('V'), pSrv('W'), pSrv('X'), pSrv('Y'), pSrv('Z'),
    '=IF($R' + r + '=0,"1 piece ("&$Q' + r + '&" g)","1 katori ("&$T' + r + '&" g)")',
    o.inputConfidence || 'confirmed',
    o.prepNote || '', (o.prepHours === 0 || o.prepHours) ? o.prepHours : '',
    o.common || ''
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// DISH MATCHING AND ALIASES  (v4.11)
//
// The library is the only place a dish exists. Free text is NEVER stored as a dish: it
// is matched to one that is already there, and the spelling is remembered as an ALIAS
// of that dish so the same text is never matched twice. This replaces getOrCreateDishID,
// which minted a bare, unclassified row for every name it did not recognise exactly (no
// class, no ingredients, no Hindi name, nothing ever filled in), so each unfamiliar
// spelling grew the shared library by one empty dish.
//
// Matching here is DETERMINISTIC and costs nothing. It auto-resolves only what cannot
// plausibly be wrong:
//   id, canonical, alias   the text already IS a name the library knows
//   normalised             the same name, differing only in case, spacing, punctuation
//   hindi                  the dish's Hindi name
//   stem                   a name with no qualifier that equals exactly ONE dish's name
//                          minus its bracket ("Dal tadka" -> "Dal tadka (arhar)")
// Anything that is merely CLOSE comes back as candidates and is never applied silently:
// a wrong alias is shared by every household and silently corrupts their macros.
// Choosing among candidates is a later step (a cheap Claude call, then the user).
//
// The library has no Claude and no API key here, by design.

var _catMemo_ = null;   // per execution: building the index reads the whole catalogue

// norm keeps brackets (stem logic needs them); flat drops them. Devanagari is kept.
function normDish_(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0900-\u097f\s()]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function flatDish_(s) { return normDish_(s).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim(); }
function stemDish_(s) {
  const t = normDish_(s).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return t || flatDish_(s);
}
function hasQualifier_(s) { return /\([^)]*\)/.test(normDish_(s)); }
// "dal + roti", "dal, rice": more than one dish. Not matched here; combos are split first.
function looksLikeCombo_(s) { return /[+,&]|\s\/\s/.test(String(s || '')); }

// Words that appear in dozens of dish names and say little about which one is meant.
// A query made only of these ("dal", "sabzi") can never be resolved automatically.
var GENERIC_DISH_TOKENS_ = { dal:1, sabzi:1, sabji:1, curry:1, masala:1, fry:1, rice:1, roti:1,
  with:1, and:1, the:1, of:1, wala:1, style:1, home:1, homemade:1, mixed:1, mix:1, veg:1, vegetable:1 };

function dishTokens_(s) {
  return flatDish_(s).split(' ').filter(Boolean)
    .map(function (t) { return (t.length > 3 && /s$/.test(t) && !/ss$/.test(t)) ? t.slice(0, -1) : t; });
}

// Pure: dishes in, lookup tables out. Merged or retired rows are not matchable.
function buildDishIndex_(dishes) {
  const live = (dishes || []).filter(function (d) {
    const st = String(d.status == null ? 'active' : d.status).trim().toLowerCase();
    return !st || st === 'active';
  });
  const idx = { all: live, byId: {}, flat: {}, stem: {}, hindi: {} };
  const push = function (map, key, d) {
    if (!key) return;
    if (!map[key]) map[key] = [];
    if (map[key].indexOf(d) < 0) map[key].push(d);
  };
  live.forEach(function (d) {
    idx.byId[String(d.dishId).toLowerCase()] = d;
    [d.canonicalName].concat(d.aliases || []).forEach(function (n) {
      push(idx.flat, flatDish_(n), d);
      push(idx.stem, stemDish_(n), d);
    });
    if (d.hindi) push(idx.hindi, flatDish_(d.hindi), d);
  });
  return idx;
}
function dishIndex_() {
  if (!_catMemo_) _catMemo_ = buildDishIndex_(getDishCatalog().dishes);
  return _catMemo_;
}

// Pure. Returns one of
//   { status:'matched', dish, via, persist }       persist = the text is a NEW spelling to remember
//   { status:'candidates', candidates:[{dish,score}], generic?, ambiguous? }
//   { status:'combo' }   { status:'none' }
function matchDish_(text, idx) {
  const raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!raw) return { status: 'none' };
  if (looksLikeCombo_(raw)) return { status: 'combo' };
  const rawLower = raw.toLowerCase();

  const byId = idx.byId[rawLower];
  if (byId) return { status: 'matched', dish: byId, via: 'id', persist: false };

  const flat = flatDish_(raw);
  const ex = idx.flat[flat] || [];
  if (ex.length === 1) {
    const d = ex[0];
    let via = 'normalised';
    if (String(d.canonicalName).trim().toLowerCase() === rawLower) via = 'canonical';
    else if ((d.aliases || []).some(function (a) { return String(a).trim().toLowerCase() === rawLower; })) via = 'alias';
    return { status: 'matched', dish: d, via: via, persist: via === 'normalised' };
  }
  if (ex.length > 1)
    return { status: 'candidates', ambiguous: true,
             candidates: ex.map(function (d) { return { dish: d, score: 1 }; }) };

  const hi = idx.hindi[flat] || [];
  if (hi.length === 1) return { status: 'matched', dish: hi[0], via: 'hindi', persist: true };

  // Stem: only for text with NO bracket of its own. "Omelette" is "Omelette (2 egg)" with
  // the qualifier dropped; "Omelette (3 egg)" names a different amount and is not applied.
  if (!hasQualifier_(raw)) {
    const st = idx.stem[flat] || [];
    if (st.length === 1) return { status: 'matched', dish: st[0], via: 'stem', persist: true };
    if (st.length > 1)
      return { status: 'candidates', ambiguous: true,
               candidates: st.map(function (d) { return { dish: d, score: 0.9 }; }) };
  }

  const q = dishTokens_(raw);
  if (!q.length) return { status: 'none' };
  const qNon = q.filter(function (t) { return !GENERIC_DISH_TOKENS_[t]; });
  const w = function (t) { return GENERIC_DISH_TOKENS_[t] ? 0.3 : 1; };
  const sum = function (a) { return a.reduce(function (x, t) { return x + w(t); }, 0); };

  const scored = [];
  idx.all.forEach(function (d) {
    let best = 0;
    [d.canonicalName].concat(d.aliases || []).forEach(function (n) {
      const sets = [dishTokens_(n)];
      const st = dishTokens_(stemDish_(n));
      if (st.join(' ') !== sets[0].join(' ')) sets.push(st);
      sets.forEach(function (dt) {
        const inter = q.filter(function (t) { return dt.indexOf(t) >= 0; });
        if (!inter.length) return;
        let score;
        if (qNon.length) {
          if (!inter.some(function (t) { return !GENERIC_DISH_TOKENS_[t]; })) return;   // only generic overlap
          const uni = q.concat(dt.filter(function (t) { return q.indexOf(t) < 0; }));
          score = sum(inter) / sum(uni);
        } else {
          // Query is all generic words: every dish containing them is equally plausible.
          score = inter.length === q.length ? 0.5 : 0;
        }
        if (score > best) best = score;
      });
    });
    if (best >= 0.3) scored.push({ dish: d, score: Math.round(best * 100) / 100 });
  });
  scored.sort(function (a, b) {
    return b.score - a.score || String(a.dish.canonicalName).length - String(b.dish.canonicalName).length;
  });
  if (!scored.length) return { status: 'none' };
  return { status: 'candidates', candidates: scored.slice(0, 5), generic: qNon.length === 0 };
}

// Read-only. '' when there is no confident match. NEVER creates a row.
function lookupDishID_(name) {
  const t = String(name || '').trim();
  if (!t) return '';
  const m = matchDish_(t, dishIndex_());
  return m.status === 'matched' ? String(m.dish.dishId) : '';
}

// ── aliases ──────────────────────────────────────────────────────────────────
// Appends `aliasText` to the dish's Aliases cell (pipe-separated) and logs it in AliasLog
// (who, how, when, and whether it is awaiting review). Refuses an alias that already names
// a DIFFERENT dish. Under a lock: two phones resolving the same spelling at once must not
// write it twice or interleave two edits to one cell.
function addDishAlias_(dishId, aliasText, method, note) {
  const alias = String(aliasText || '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
  if (alias.length < 2 || alias.length > 80) return { added: false, reason: 'invalid' };
  if (looksLikeCombo_(alias)) return { added: false, reason: 'combo' };

  const r = withScriptLock_(function () { return addDishAliasLocked_(dishId, alias, method, note); }, 15000);
  return (r && r.status === 'busy') ? { added: false, reason: 'busy' } : r;
}
function addDishAliasLocked_(dishId, alias, method, note) {
  {
    const sheet = getSheet('DishCatalog');
    const last = sheet.getLastRow();
    if (last < 2) return { added: false, reason: 'empty catalogue' };
    const vals = sheet.getRange(2, 1, last - 1, 3).getValues();   // DishID, Canonical, Aliases
    let target = -1;
    for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(dishId)) { target = i; break; }
    if (target < 0) return { added: false, reason: 'unknown dish' };

    const want = flatDish_(alias);
    for (let i = 0; i < vals.length; i++) {
      if (i === target) continue;
      const names = [vals[i][1]].concat(String(vals[i][2] || '').split('|'));
      if (names.some(function (n) { return flatDish_(n) === want; }))
        return { added: false, reason: 'collision', with: String(vals[i][1]) };
    }

    const have = String(vals[target][2] || '').split('|').map(function (a) { return a.trim(); }).filter(Boolean);
    const lower = alias.toLowerCase();
    if (String(vals[target][1]).trim().toLowerCase() === lower ||
        have.some(function (a) { return a.toLowerCase() === lower; }))
      return { added: false, reason: 'exists', aliases: have };

    have.push(alias);
    sheet.getRange(target + 2, 3).setValue(have.join('|'));

    const log = getSheet('AliasLog');
    log.getRange(log.getLastRow() + 1, 1, 1, SHEETS.AliasLog.length).setValues([[
      alias, String(dishId), String(vals[target][1]), method || '', 'app',
      _activeHousehold_, istNow(), method === 'claude' ? 'pending' : 'ok', note || ''
    ]]);
    _catMemo_ = null;
    return { added: true, aliases: have, canonicalName: String(vals[target][1]) };
  }
}

// body: { texts:[...], persist? }. One result per distinct text, in order.
//   matched     { dishId, canonicalName, via, aliasAdded, aliases }
//   candidates  { candidates:[{dishId, canonicalName, score}], generic?, ambiguous? }
//   combo / none
// Persisting happens only for a NEW spelling of a confidently matched dish.
function resolveDishTexts(body) {
  const seen = {};
  const texts = (Array.isArray(body && body.texts) ? body.texts : [])
    .map(function (t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); })
    .filter(function (t) { if (!t || seen[t.toLowerCase()]) return false; seen[t.toLowerCase()] = 1; return true; })
    .slice(0, 20);
  const persist = !(body && body.persist === false);
  const out = texts.map(function (t) {
    const m = matchDish_(t, dishIndex_());
    if (m.status === 'matched') {
      let aliasAdded = false, aliases = m.dish.aliases || [];
      if (m.persist && persist) {
        const r = addDishAlias_(m.dish.dishId, t, m.via, '');
        aliasAdded = !!r.added;
        if (r.aliases) aliases = r.aliases;
        // A refused alias (it names another dish) means the match was not safe after all.
        if (!r.added && r.reason === 'collision') return { text: t, status: 'none', note: 'alias collides with ' + r.with };
      }
      const ps = m.dish.perServing || {};
      return { text: t, status: 'matched', via: m.via, dishId: m.dish.dishId,
               canonicalName: m.dish.canonicalName, aliasAdded: aliasAdded, aliases: aliases,
               costed: ps.kcal != null };
    }
    if (m.status === 'candidates')
      return { text: t, status: 'candidates', generic: !!m.generic, ambiguous: !!m.ambiguous,
               candidates: m.candidates.map(function (c) {
                 return { dishId: c.dish.dishId, canonicalName: c.dish.canonicalName,
                          hindi: c.dish.hindi || '', score: c.score };
               }) };
    return { text: t, status: m.status };
  });
  return { results: out };
}

// Undo for a wrong alias. Removes it from the dish's Aliases cell and marks its AliasLog
// rows 'removed'. body: { dishId, alias }.
//
// A wrong alias does more than mislabel a spelling: every meal logged under it was costed
// and DEDUCTED as the wrong dish. So removing it also takes those meals back: their stock
// is put back, their DishID is cleared, and they go back to 'pending', to be settled
// properly once the text is matched correctly. Only this household's meals can be reached.
function removeDishAlias(body) {
  const r = withScriptLock_(function () { return removeDishAliasLocked_(body); }, 15000);
  return (r && r.status === 'busy') ? { success: false, error: 'busy' } : r;
}
function removeDishAliasLocked_(body) {
  const dishId = String((body && body.dishId) || '').trim();
  const alias = String((body && body.alias) || '').replace(/\s+/g, ' ').trim();
  if (!dishId || !alias) return { success: false, error: 'dishId and alias required' };
  const sheet = getSheet('DishCatalog');
  const last = sheet.getLastRow();
  if (last < 2) return { success: false, error: 'empty catalogue' };
  const vals = sheet.getRange(2, 1, last - 1, 3).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) !== dishId) continue;
    const have = String(vals[i][2] || '').split('|').map(function (a) { return a.trim(); }).filter(Boolean);
    const keep = have.filter(function (a) { return a.toLowerCase() !== alias.toLowerCase(); });
    if (keep.length === have.length) return { success: false, error: 'alias not found' };
    sheet.getRange(i + 2, 3).setValue(keep.join('|'));
    const log = getSheet('AliasLog');
    const ll = log.getLastRow();
    if (ll >= 2) {
      const lv = log.getRange(2, 1, ll - 1, 9).getValues();
      for (let j = 0; j < lv.length; j++)
        if (String(lv[j][1]) === dishId && String(lv[j][0]).toLowerCase() === alias.toLowerCase() &&
            lv[j][7] !== 'removed') log.getRange(j + 2, 8).setValue('removed');
    }
    _catMemo_ = null;

    // Take back what the alias caused.
    const ml = getSheet('MealLog');
    const mlLast = ml.getLastRow();
    const mv = mlLast >= 2 ? ml.getRange(2, 1, mlLast - 1, 10).getValues() : [];
    const want = flatDish_(alias);
    let reopened = 0;
    for (let k = 0; k < mv.length; k++) {
      if (flatDish_(mv[k][1]) !== want || String(mv[k][5]) !== dishId) continue;
      const logId = String(mv[k][6] || '').trim();
      try { reverseDeduction_(logId); } catch (e) {}
      ml.getRange(k + 2, 6).setValue('');
      const ex = findInventoryLog_(logId);
      if (ex && ex.status !== 'skipped')
        writeInventoryLog_(logId, { dish: String(mv[k][1]), person: String(mv[k][3]) }, '', 'pending',
                           { reason: 'the alias was removed, so the dish is not matched' }, ex);
      reopened++;
    }
    return { success: true, aliases: keep, mealsReopened: reopened };
  }
  return { success: false, error: 'unknown dish' };
}

// Saves an alias the APP proposes. Code.gs never calls Claude; the client does, and asks
// for the result to be saved here, where it is checked again.
//   body: { text, dishId, method: 'claude' | 'user', note? }
//   'user'   a person chose it from the question. Any existing dish is allowed, because the
//            person is the authority, but not text that already means a different dish.
//   'claude' a machine's pick. Applied only where it cannot plausibly be wrong: the dish must
//            be one the matcher ITSELF offered for this text, the text must have a distinctive
//            word (never "dal" or "sabzi" alone), it must not be an ambiguous stem, and the
//            overlap must be strong enough. Saved as 'pending' for the owner's review.
function saveDishAlias(body) {
  const text = String((body && body.text) || '').replace(/\s+/g, ' ').trim();
  const dishId = String((body && body.dishId) || '').trim();
  const method = (body && body.method) === 'claude' ? 'claude' : 'user';
  if (!text || !dishId) return { success: false, error: 'text and dishId required' };
  const idx = dishIndex_();
  const dish = idx.byId[dishId.toLowerCase()];
  if (!dish) return { success: false, error: 'unknown dish' };
  const m = matchDish_(text, idx);
  if (m.status === 'combo') return { success: false, error: 'a combination of dishes cannot be an alias' };
  if (m.status === 'matched' && String(m.dish.dishId) !== String(dish.dishId))
    return { success: false, error: 'that text already means ' + m.dish.canonicalName };
  // Text that ALREADY resolves to this dish (another phone saved it a moment ago, or it was
  // matched after the question was asked) needs no machine judgement: it just succeeds.
  if (method === 'claude' && m.status !== 'matched') {
    if (m.status !== 'candidates' || m.generic || m.ambiguous)
      return { success: false, error: 'not eligible for automatic matching' };
    const c = m.candidates.filter(function (x) { return String(x.dish.dishId) === String(dish.dishId); })[0];
    if (!c || c.score < 0.5) return { success: false, error: 'the match is not strong enough to apply automatically' };
  }
  const r = addDishAlias_(dish.dishId, text, method, (body && body.note) || '');
  return { success: !!r.added || r.reason === 'exists', added: !!r.added, reason: r.reason || '',
           aliases: r.aliases || dish.aliases || [], canonicalName: dish.canonicalName, dishId: dish.dishId };
}

// ── cleanup of rows the old resolver minted ──────────────────────────────────
// Finds bare rows (a slug ID rather than D###, no class, no ingredients) and, for each,
// either folds it into the real dish it is a spelling of or leaves it alone. body.apply
// must be true to change anything; the default is a dry run that only reports the plan.
// A bare row is NEVER deleted unless its name matched a real dish with confidence: a
// dish somebody actually cooked and could not be matched is kept and reported.
function cleanupBareDishes(body) {
  const apply = !!(body && body.apply);
  const sheet = getSheet('DishCatalog');
  const last = sheet.getLastRow();
  if (last < 2) return { dryRun: !apply, plan: [] };
  const rows = sheet.getRange(2, 1, last - 1, SHEETS.DishCatalog.length).getValues();

  const hasIng = {};
  getDataRows(getSheet('DishIngredients')).forEach(function (r) { hasIng[String(r[0])] = 1; });

  const bare = [];
  rows.forEach(function (r, i) {
    const id = String(r[0] || '');
    if (!id || /^D\d+$/.test(id)) return;          // seeded dishes are never touched
    if (String(r[7] || '') !== '') return;         // has a ClassID: not bare
    if (hasIng[id]) return;                        // has ingredients: not bare
    bare.push({ rowIdx: i, dishId: id, name: String(r[1] || '') });
  });

  const bareIds = {};
  bare.forEach(function (b) { bareIds[b.dishId] = 1; });
  const real = getDishCatalog().dishes.filter(function (d) { return !bareIds[String(d.dishId)]; });
  const idx = buildDishIndex_(real);

  const plan = bare.map(function (b) {
    const m = matchDish_(b.name, idx);
    if (m.status === 'matched')
      return { dishId: b.dishId, name: b.name, action: 'fold-into', target: m.dish.dishId,
               targetName: m.dish.canonicalName, via: m.via, rowIdx: b.rowIdx };
    if (m.status === 'candidates')
      return { dishId: b.dishId, name: b.name, action: 'review', rowIdx: b.rowIdx,
               candidates: m.candidates.slice(0, 3).map(function (c) {
                 return { dishId: c.dish.dishId, canonicalName: c.dish.canonicalName, score: c.score };
               }) };
    return { dishId: b.dishId, name: b.name, action: 'keep', rowIdx: b.rowIdx };
  });
  const report = plan.map(function (p) { const q = Object.assign({}, p); delete q.rowIdx; return q; });
  if (!apply) return { dryRun: true, plan: report };

  // 1. delete first (bottom-up so the indices stay valid), so that adding the alias is
  //    not refused for colliding with the very row it came from.
  const folds = plan.filter(function (p) { return p.action === 'fold-into'; });
  folds.slice().sort(function (a, b) { return b.rowIdx - a.rowIdx; })
       .forEach(function (p) { sheet.deleteRow(p.rowIdx + 2); });
  _catMemo_ = null;

  // 2. remember the spelling on the real dish, and re-point meals logged under the old ID.
  let aliased = 0, repointed = 0;
  const ml = getSheet('MealLog');
  const mlLast = ml.getLastRow();
  const mv = mlLast >= 2 ? ml.getRange(2, 1, mlLast - 1, 10).getValues() : [];
  folds.forEach(function (p) {
    const r = addDishAlias_(p.target, p.name, 'cleanup', 'folded bare row ' + p.dishId);
    if (r.added) aliased++;
    for (let i = 0; i < mv.length; i++)
      if (String(mv[i][5]) === p.dishId) { ml.getRange(i + 2, 6).setValue(p.target); mv[i][5] = p.target; repointed++; }
  });
  return { dryRun: false, plan: report, deleted: folds.length, aliased: aliased, mealsRepointed: repointed };
}

// ─────────────────────────────────────────────────────────────────────────────
// STOCK DEDUCTION  (v4.12)
//
// Logging a meal takes its ingredients out of the kitchen. That is half of why the
// library exists: the same table that says what a katori of dal tadka weighs says what
// went into it, so the amount used is arithmetic, not a guess.
//
//   portion grams / the batch's yield grams = the fraction of the batch eaten
//   every RAW ingredient x that fraction                = what to take off the shelf
//
// It happens server-side, once per logged meal, whichever way the meal got logged (the
// manual form, the menu, or the auto-log sweep all go through logMeal). Each meal has one
// row in InventoryLog, keyed by LogID, which is what makes it:
//   - IDEMPOTENT   the same meal can never deduct twice (a retry, a double tap, a sweep)
//   - REVERSIBLE   deleting the meal puts the stock back; editing it re-does the deduction
//   - HONEST       the row records what was taken and what could not be, and why
//
// A shelf quantity is free text with its unit inside it ("500 g", "1.5 kg", "1 l",
// "6 pcs"). It is converted to grams, reduced, and written back in the SAME unit, so the
// kitchen screen reads as it always did. What cannot be converted is never guessed:
//   no unit ("1")           a pack ("2 packs")       millilitres with no density
//   pieces with no weight   an item not on the shelf at all
// is reported back as "not tracked" with the reason, so the person can fix the entry.
//
// A dish that has not been matched to the library yet cannot be deducted. Its row is
// 'pending' and reconcileDeductions applies it exactly once when the dish is resolved.
// Nothing here calls Claude.

var _lockHeld_ = false;   // true while a caller (sweepMenu) already holds the script lock
function withScriptLock_(fn, ms) {
  if (_lockHeld_) return fn();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(ms || 15000)) return { status: 'busy' };
  _lockHeld_ = true;
  try { return fn(); } finally { _lockHeld_ = false; lock.releaseLock(); }
}

// ── quantities ───────────────────────────────────────────────────────────────
var STOCK_UNITS_ = { kg: 'kg', kgs: 'kg', g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g',
  ml: 'ml', l: 'l', ltr: 'l', ltrs: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  pcs: 'pcs', pc: 'pcs', piece: 'pcs', pieces: 'pcs', no: 'pcs', nos: 'pcs',
  dozen: 'dozen', doz: 'dozen', pack: 'pack', packs: 'pack', packet: 'pack', packets: 'pack' };

// "500 g" -> {value:500, unit:'g'}.  A bare "3" takes the Unit column if there is one,
// otherwise unit '' (unknown). A dozen becomes 12 pcs. Not a quantity at all -> null.
function parseStockQty_(raw, unitCol) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)$/);
  if (!m) return null;
  const word = m[2] || String(unitCol || '').trim().toLowerCase();
  const unit = word ? (STOCK_UNITS_[word] || '') : '';
  const value = parseFloat(m[1]);
  if (unit === 'dozen') return { value: value * 12, unit: 'pcs' };
  return { value: value, unit: unit };
}

// Grams for a shelf quantity, or {reason}. Never a guess.
function stockToGrams_(q, ing) {
  if (!q) return { reason: 'the quantity is not a number' };
  if (q.unit === 'g') return { grams: q.value };
  if (q.unit === 'kg') return { grams: q.value * 1000 };
  if (q.unit === 'ml' || q.unit === 'l') {
    if (!(ing && ing.density > 0)) return { reason: 'no density for ' + ((ing && ing.name) || 'this item') };
    return { grams: (q.unit === 'l' ? q.value * 1000 : q.value) * ing.density };
  }
  if (q.unit === 'pcs') {
    if (!(ing && ing.pieceGrams > 0)) return { reason: 'no piece weight for ' + ((ing && ing.name) || 'this item') };
    return { grams: q.value * ing.pieceGrams };
  }
  if (q.unit === 'pack') return { reason: 'a pack has no fixed weight' };
  return { reason: 'the quantity has no unit' };
}
function gramsToStock_(grams, unit, ing) {
  if (unit === 'g') return grams;
  if (unit === 'kg') return grams / 1000;
  if (unit === 'ml') return grams / ing.density;
  if (unit === 'l') return grams / ing.density / 1000;
  if (unit === 'pcs') return grams / ing.pieceGrams;
  return grams;
}
// Written back in the unit it came in, at a precision finer than any single ingredient
// amount, so a pinch of salt is not rounded to nothing on every meal.
function formatStockQty_(value, unit) {
  const dp = { g: 1, ml: 1, kg: 4, l: 4, pcs: 2 }[unit];
  const v = Math.max(0, value);
  return dp == null ? String(v) : String(Number(v.toFixed(dp))) + ' ' + unit;
}
function round2_(x) { return Math.round(x * 100) / 100; }

// ── what a portion of a dish consumed ────────────────────────────────────────
// RAW grams per ingredient, summed (oil may appear twice in one recipe), water excluded
// (it is in the table to make the mass balance honest, not because anyone stocks it).
// Kept to 2 decimals: rounding each line to whole grams, as the older action does, drops
// every spice under half a gram, permanently, on every meal.
function deductionLines_(dish, portionGrams) {
  if (!(dish.yieldGrams > 0)) return { error: 'the dish has no yield yet' };
  const rows = getDataRows(getSheet('DishIngredients'))
    .filter(function (r) { return String(r[0]).trim() === String(dish.dishId); });
  if (!rows.length) return { error: 'the dish has no ingredients yet' };
  const frac = portionGrams / dish.yieldGrams;
  const by = {};
  rows.forEach(function (r) {
    const id = String(r[2]).trim();
    if (!id || id.toLowerCase() === 'water') return;
    if (!by[id]) by[id] = { ingID: id, name: String(r[3] || id), grams: 0 };
    by[id].grams += (+r[4] || 0) * frac;
  });
  return { frac: frac, lines: Object.keys(by).map(function (k) { return by[k]; })
    .filter(function (l) { return l.grams > 0.005; })
    .map(function (l) { return { ingID: l.ingID, name: l.name, grams: round2_(l.grams) }; }) };
}

// ── InventoryLog: one row per logged meal ────────────────────────────────────
function inventoryLogRows_() {
  const sh = getSheet('InventoryLog');
  const last = sh.getLastRow();
  return last < 2 ? [] : sh.getRange(2, 1, last - 1, SHEETS.InventoryLog.length).getValues();
}
function findInventoryLog_(logId) {
  const rows = inventoryLogRows_();
  for (let i = rows.length - 1; i >= 0; i--)
    if (String(rows[i][0]) === String(logId))
      return { row: i + 2, status: String(rows[i][4] || ''), detail: String(rows[i][5] || '') };
  return null;
}
function writeInventoryLog_(logId, o, dishId, status, detail, existing) {
  const sh = getSheet('InventoryLog');
  const rec = [String(logId), String(o.dish || ''), String(o.person || ''), String(dishId || ''),
               status, JSON.stringify(detail || {}), istNow(), ''];
  if (existing) sh.getRange(existing.row, 1, 1, rec.length).setValues([rec]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, rec.length).setValues([rec]);
}

// ── apply ────────────────────────────────────────────────────────────────────
// o: { logId, dish, dishId?, person, qty, measure, redo? }.  Returns the receipt.
//   {status:'applied', used:[...], skipped:[...], short:[...]}   something was settled
//   {status:'pending', reason}    cannot be done YET (dish not matched, no recipe)
//   {status:'skipped'|'reversed', already:true}   this meal was already dealt with
function applyDeduction_(o) {
  const r = withScriptLock_(function () { return applyDeductionLocked_(o); });
  return r;
}
function applyDeductionLocked_(o) {
  const logId = String(o.logId || '');
  if (!logId) return { status: 'pending', reason: 'no LogID' };
  const existing = findInventoryLog_(logId);
  if (existing && (existing.status === 'applied' || existing.status === 'skipped' ||
                   (existing.status === 'reversed' && !o.redo)))
    return { status: existing.status, already: true };

  const dishId = String(o.dishId || '') || lookupDishID_(o.dish);
  const pend = function (reason) {
    writeInventoryLog_(logId, o, dishId, 'pending', { reason: reason }, existing);
    return { status: 'pending', reason: reason };
  };
  if (!dishId) return pend('the dish is not matched to the dish list yet');
  const idx = catalogIndex_();
  const dish = resolveDish(dishId, idx);
  if (!dish) return pend('the dish is not in the dish list');
  const g = portionToGrams({ dishId: dishId, qty: o.qty, measure: o.measure });
  if (!g.known) return pend(g.reason || 'the portion could not be worked out');
  const dl = deductionLines_(dish, g.grams);
  if (dl.error) return pend(dl.error);

  const ings = getIngredients().ingredients;
  const byId = {};
  ings.forEach(function (i) { byId[i.id] = i; });
  const wanted = {};
  dl.lines.forEach(function (l) { wanted[l.ingID] = true; });
  // A shelf row is matched against ONLY the ingredients this dish uses, and an estimated
  // or uncommon ingredient counts like any other. The match is narrow by construction,
  // so the "common staples only" restriction that guards free-form shelf cleaning is not
  // needed here, and without lifting it a freshly added ingredient could never come off
  // the shelf.
  const subset = ings.filter(function (i) { return wanted[i.id]; })
                     .map(function (i) { return Object.assign({}, i, { common: 'yes' }); });

  const sheet = getSheet('Inventory');
  const last = sheet.getLastRow();
  const inv = last >= 2 ? sheet.getRange(2, 1, last - 1, Math.max(7, sheet.getLastColumn())).getValues() : [];
  const rowsFor = {};
  inv.forEach(function (r, i) {
    if (!String(r[0] || '').trim()) return;
    // v4.22. A row linked to the library (IngID) is matched by that link, exactly. Unlinked rows
    // still fall back to the name matcher, so nothing stops working before a row is linked.
    const linked = String(r[5] || '').trim();
    if (linked) { if (wanted[linked]) (rowsFor[linked] = rowsFor[linked] || []).push(i); return; }
    const res = resolveIngredient(r[0], subset);
    if (res && res.ing && res.confidence !== 'none') (rowsFor[res.ing.id] = rowsFor[res.ing.id] || []).push(i);
  });
  // v4.22. Several brands of one ingredient (Nescafe and Rage): use the one with the MOST on the
  // shelf first; on a tie, alphabetical by the item's name. An amount that can't be turned into
  // grams counts as 0, so a measurable row is preferred over a vague one.
  Object.keys(rowsFor).forEach(function (id) {
    const ing = byId[id] || { id: id };
    const amount = function (ri) {
      const g = stockToGrams_(parseStockQty_(inv[ri][1], inv[ri][2]), ing);
      return g && g.grams > 0 ? g.grams : 0;
    };
    rowsFor[id].sort(function (a, b) {
      return (amount(b) - amount(a)) ||
             String(inv[a][0]).toLowerCase().localeCompare(String(inv[b][0]).toLowerCase());
    });
  });

  const used = [], skipped = [], short = [], dirty = {};
  dl.lines.forEach(function (line) {
    const ing = byId[line.ingID] || { id: line.ingID, name: line.name };
    const rows = rowsFor[line.ingID] || [];
    if (!rows.length) { skipped.push({ ingID: line.ingID, name: line.name, grams: line.grams, reason: 'not in your stock list' }); return; }
    let remaining = line.grams, touched = false, why = '';
    rows.forEach(function (ri) {
      if (remaining <= 0.005) return;
      const row = inv[ri];
      const q = parseStockQty_(row[1], row[2]);
      const have = stockToGrams_(q, ing);
      if (have.grams == null) { why = have.reason; return; }
      if (have.grams <= 0) { why = why || 'the stock is empty'; return; }
      const take = Math.min(remaining, have.grams);
      const before = String(row[1]);
      const after = formatStockQty_(gramsToStock_(have.grams - take, q.unit, ing), q.unit);
      row[1] = after; row[3] = istNow(); row[4] = 'Meal'; dirty[ri] = true;
      used.push({ item: String(row[0]), ingID: line.ingID, name: line.name, grams: round2_(take),
                  unit: q.unit, before: before, after: after });
      remaining -= take; touched = true;
    });
    if (!touched) skipped.push({ ingID: line.ingID, name: line.name, grams: line.grams, reason: why || 'the stock is empty' });
    else if (remaining > 0.05) short.push({ ingID: line.ingID, name: line.name, grams: round2_(remaining) });
  });

  Object.keys(dirty).forEach(function (k) {
    const ri = +k, row = inv[ri];
    sheet.getRange(ri + 2, 2).setValue(row[1]);
    sheet.getRange(ri + 2, 4, 1, 2).setValues([[row[3], row[4]]]);
  });
  const detail = { grams: g.grams, used: used, skipped: skipped, short: short };
  writeInventoryLog_(logId, o, dishId, 'applied', detail, existing);
  return { status: 'applied', grams: g.grams, used: used, skipped: skipped, short: short };
}

// A meal that is not home cooked (ate out) is recorded as such, so it is never retried.
function recordSkippedDeduction_(logId, o, note) {
  return withScriptLock_(function () {
    const existing = findInventoryLog_(logId);
    if (existing && existing.status === 'applied') return { status: 'applied', already: true };
    writeInventoryLog_(logId, o, o.dishId || '', 'skipped', { reason: note }, existing);
    return { status: 'skipped', reason: note };
  });
}

// ── reverse ──────────────────────────────────────────────────────────────────
// Puts back exactly what was taken, in whatever unit the shelf row is in NOW. If the
// item has since been removed or re-entered without a usable unit, that line is reported
// as not restored rather than invented.
function reverseDeduction_(logId) {
  return withScriptLock_(function () {
    const e = findInventoryLog_(logId);
    if (!e || e.status !== 'applied') return { status: e ? e.status : 'none', restored: [], lost: [] };
    let detail = {};
    try { detail = JSON.parse(e.detail || '{}'); } catch (x) { detail = {}; }
    const ings = getIngredients().ingredients, byId = {};
    ings.forEach(function (i) { byId[i.id] = i; });
    const sheet = getSheet('Inventory');
    const last = sheet.getLastRow();
    const inv = last >= 2 ? sheet.getRange(2, 1, last - 1, 5).getValues() : [];
    const restored = [], lost = [];
    (detail.used || []).forEach(function (u) {
      let ri = -1;
      for (let i = 0; i < inv.length; i++)
        if (String(inv[i][0]).trim().toLowerCase() === String(u.item).trim().toLowerCase()) { ri = i; break; }
      if (ri < 0) { lost.push({ item: u.item, grams: u.grams, reason: 'the item is no longer in your stock list' }); return; }
      const ing = byId[u.ingID] || { name: u.name };
      const q = parseStockQty_(inv[ri][1], inv[ri][2]);
      const cur = stockToGrams_(q, ing);
      if (cur.grams == null) { lost.push({ item: u.item, grams: u.grams, reason: cur.reason }); return; }
      const after = formatStockQty_(gramsToStock_(cur.grams + u.grams, q.unit, ing), q.unit);
      inv[ri][1] = after;
      sheet.getRange(ri + 2, 2).setValue(after);
      sheet.getRange(ri + 2, 4, 1, 2).setValues([[istNow(), 'Meal undone']]);
      restored.push({ item: u.item, grams: u.grams, after: after });
    });
    detail.reversedAt = istNow();
    const sh = getSheet('InventoryLog');
    sh.getRange(e.row, 5).setValue('reversed');
    sh.getRange(e.row, 6).setValue(JSON.stringify(detail));
    return { status: 'reversed', restored: restored, lost: lost };
  });
}

function mealRowByLogId_(logId) {
  const sh = getSheet('MealLog');
  const last = sh.getLastRow();
  if (last < 2) return null;
  const vals = sh.getRange(2, 1, last - 1, 10).getValues();
  for (let i = 0; i < vals.length; i++)
    if (String(vals[i][6] || '').trim() === String(logId))
      return { row: i + 2, name: String(vals[i][1] || ''), by: String(vals[i][3] || ''),
               dishId: String(vals[i][5] || ''), qty: vals[i][8], measure: vals[i][9] };
  return null;
}

// An edited meal (a different dish, amount or person) is taken back off and re-done.
// An 'ate out' meal stays skipped: editing it does not turn it into one you cooked.
function redoDeduction_(logId) {
  const e = findInventoryLog_(logId);
  if (!e || e.status === 'skipped') return { status: e ? e.status : 'none' };
  if (e.status === 'applied') reverseDeduction_(logId);
  const m = mealRowByLogId_(logId);
  if (!m) return { status: 'none' };
  return applyDeduction_({ logId: logId, dish: m.name, dishId: lookupDishID_(m.name), person: m.by,
                           qty: m.qty, measure: m.measure, redo: true });
}

// Settles meals whose dish was not in the list when they were logged and is now: the
// dish has since been matched (an alias was saved) or added. Applies each exactly once.
// Safe to call as often as is convenient; with nothing pending it only reads one tab.
function reconcileDeductions(body) {
  const rows = inventoryLogRows_();
  const todo = [];
  rows.forEach(function (r) { if (String(r[4]) === 'pending') todo.push(String(r[0])); });
  const out = { applied: 0, stillPending: 0, pendingTotal: todo.length, results: [] };
  todo.slice(0, 12).forEach(function (logId) {
    const m = mealRowByLogId_(logId);
    const e = findInventoryLog_(logId);
    if (!m) { if (e) writeInventoryLog_(logId, { dish: '', person: '' }, '', 'skipped', { reason: 'the meal no longer exists' }, e); return; }
    const dishId = lookupDishID_(m.name) || m.dishId;
    const r = applyDeduction_({ logId: logId, dish: m.name, dishId: dishId, person: m.by, qty: m.qty, measure: m.measure });
    if (r.status === 'applied' && !r.already) {
      out.applied++;
      out.results.push({ logId: logId, dish: m.name, person: m.by, used: r.used, skipped: r.skipped, short: r.short });
      if (dishId && !m.dishId) getSheet('MealLog').getRange(m.row, 6).setValue(dishId);
    } else out.stillPending++;
  });
  return out;
}

// One-off, idempotent: gives the ingredients that are counted in pieces a piece weight,
// WITHOUT overwriting anything already typed. The weight is the library's own: its
// recipes use 44 g per egg everywhere (176 g = 4 eggs, 88 g = 2, 264 g = 6), so "4 eggs
// in, 4 eggs out" holds. Others (bread, banana, lemon) are left blank for the owner,
// and show up as "no piece weight" until filled in the sheet.
function seedIngredientPieces() {
  const sheet = getSheet('Ingredients');
  const last = sheet.getLastRow();
  if (last < 2) return { seeded: [] };
  const col = SHEETS.Ingredients.indexOf('PieceGrams') + 1;
  const vals = sheet.getRange(2, 1, last - 1, col).getValues();
  const seeds = { egg: 44 }, done = [];
  vals.forEach(function (r, i) {
    const id = String(r[0]);
    if (seeds[id] && (r[col - 1] === '' || r[col - 1] == null)) {
      sheet.getRange(i + 2, col).setValue(seeds[id]);
      done.push({ ingID: id, grams: seeds[id] });
    }
  });
  return { seeded: done };
}

function uniqueSlug(name, existingIds) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'dish';
  const taken = new Set(existingIds);
  let id = base, n = 2;
  while (taken.has(id)) { id = base + '-' + n; n++; }
  return id;
}

// One-time (idempotent) backfill: gives every existing DishMacros/MealLog row
// a DishID by resolving its current dish-name string through the catalog.
// Safe to run more than once — already-migrated rows (DishID already set)
// are skipped, so nothing is overwritten.
function migrateDishCatalog() {
  let mlMigrated = 0;
  const mlSheet = getSheet('MealLog');
  const mlData  = getDataRows(mlSheet);
  mlData.forEach((row, i) => {
    if (row[5] || !row[1]) return;
    mlSheet.getRange(i + 2, 6).setValue(lookupDishID_(row[1]));
    mlMigrated++;
  });
  return {
    success: true, mealLogMigrated: mlMigrated,
    totalCatalogEntries: getDataRows(getSheet('DishCatalog')).length
  };
}

// Cheap (no API call), token-overlap similarity — flags likely-duplicate
// catalog entries for a human to review and merge. Deliberately not fuzzy
// enough to auto-merge on its own; false positives here would incorrectly
// combine two different dishes' cook ratings, which is exactly the signal
// this project cares most about protecting.
function tokenSimilarity(a, b) {
  const ta = new Set(String(a).toLowerCase().split(/\s+/).filter(Boolean));
  const tb = new Set(String(b).toLowerCase().split(/\s+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  ta.forEach(t => { if (tb.has(t)) shared++; });
  return shared / Math.max(ta.size, tb.size);
}

function getDishDuplicateCandidates() {
  const data = getDataRows(getSheet('DishCatalog'));
  const candidates = [];
  for (let i = 0; i < data.length; i++) {
    for (let j = i + 1; j < data.length; j++) {
      const sim = tokenSimilarity(data[i][1], data[j][1]);
      if (sim >= 0.6) {
        candidates.push({
          idA: data[i][0], nameA: data[i][1],
          idB: data[j][0], nameB: data[j][1],
          similarity: Math.round(sim * 100)
        });
      }
    }
  }
  candidates.sort((a, b) => b.similarity - a.similarity);
  return { candidates: candidates };
}

// Merges mergeId into keepId: the merged dish's name becomes an alias on the
// kept catalog row, DishMacros rows are combined (kept row's cook-rating
// count is summed with the merged row's, a confirmed macro source always
// wins over an estimated one), and MealLog rows are repointed. This is only
// ever triggered by a human tapping "Merge" after reviewing a duplicate
// candidate — never automatic.
function mergeDishes(body) {
  const keepId = body.keepId, mergeId = body.mergeId;
  if (!keepId || !mergeId || keepId === mergeId) return { success: false, error: 'Need two different dish IDs' };

  const catSheet = getSheet('DishCatalog');
  const catData  = getDataRows(catSheet);
  let keepRow = -1, mergeRow = -1, mergeName = '';
  catData.forEach((r, i) => {
    if (r[0] === keepId) keepRow = i;
    if (r[0] === mergeId) { mergeRow = i; mergeName = r[1]; }
  });
  if (keepRow === -1 || mergeRow === -1) return { success: false, error: 'Dish not found' };

  const existingAliases = String(catData[keepRow][2] || '').split('|').map(a => a.trim()).filter(Boolean);
  if (mergeName && existingAliases.map(a => a.toLowerCase()).indexOf(mergeName.toLowerCase()) === -1) {
    existingAliases.push(mergeName);
  }
  catSheet.getRange(keepRow + 2, 3).setValue(existingAliases.join('|'));
  catSheet.deleteRow(mergeRow + 2);

  // v4.8. Ratings only. There are no macros to reconcile any more — those live in
  // the library, keyed on the DishID that survives the merge, so they need no
  // merging at all. Rating counts add; 'yes' beats blank beats 'no', because if
  // either row says she can make it, she can.
  // v4.8. Ratings live in CookSkills and always did. There are no macros left to
  // reconcile — those are in the library, keyed on the DishID that survives the
  // merge, so they need no merging at all. Counts add; 'yes' beats blank beats 'no',
  // because if either row says she can make it, she can.
  const csSheet = getSheet('CookSkills');
  const csData  = getSkillRows_();
  let keepCs = -1, mergeCs = -1;
  csData.forEach((r, i) => {
    if (r[0] === keepId) keepCs = i;
    if (r[0] === mergeId) mergeCs = i;
  });
  if (keepCs > -1 && mergeCs > -1) {
    const keep = csData[keepCs], merged = csData[mergeCs];
    csSheet.getRange(keepCs + 2, 1, 1, SHEETS.CookSkills.length).setValues([[
      keepId, keep[1] || merged[1] || '',
      (keep[2] === 'yes' || merged[2] === 'yes') ? 'yes' : (keep[2] || merged[2] || ''),
      keep[3] || merged[3] || '',
      (Number(keep[4]) || 0) + (Number(merged[4]) || 0),
      'Merge', istNow(), keep[7] || merged[7] || ''
    ]]);
    csSheet.deleteRow(mergeCs + 2);
  } else if (mergeCs > -1) {
    csSheet.getRange(mergeCs + 2, 1).setValue(keepId);
  }

  const mlSheet = getSheet('MealLog');
  const mlData  = getDataRows(mlSheet);
  mlData.forEach((r, i) => {
    if (r[5] === mergeId) mlSheet.getRange(i + 2, 6).setValue(keepId);
  });

  return { success: true };
}

// Lets a person manually add alternate spellings to a dish (separate from
// the auto-populated alias added by mergeDishes above).
function updateDishAliases(body) {
  if (!body.dishId) return { success: false, error: 'No dishId' };
  const sheet = getSheet('DishCatalog');
  const data  = getDataRows(sheet);
  for (let i = 0; i < data.length; i++) {
    if (data[i][0] === body.dishId) {
      sheet.getRange(i + 2, 3).setValue(String(body.aliases || '').trim());
      return { success: true };
    }
  }
  return { success: false, error: 'Dish not found' };
}



// Records a dish's prep requirement in the library. Soaking rajma is a fact about
// rajma, not about one kitchen, so it is shared. Writes ONLY the three prep input
// columns — never the computed ones, which would kill the formulas.
// Never overwrites an existing note with a blank: a menu that simply didn't mention
// soaking is not evidence that soaking isn't needed.
function setDishPrep(body) {
  const name = String(body.dish || '').trim();
  if (!name) return { success: false, error: 'No dish' };
  const sheet = getSheet('DishCatalog');
  const data  = getDataRows(sheet);
  const key = name.toLowerCase();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][1] || '').trim().toLowerCase() !== key) continue;
    const row = i + 2;
    const note = String(body.prepNote || '').trim();
    if (note) {
      sheet.getRange(row, 40).setValue(note);
      sheet.getRange(row, 41).setValue(+body.prepHours || 0);
    }
    if (body.common != null) sheet.getRange(row, 42).setValue(body.common ? 'yes' : 'no');
    return { success: true, dishId: data[i][0] };
  }
  return { success: false, error: 'Dish not in catalog' };
}

// ── Feedback ───────────────────────────────────
// A screenshot beats a description for a layout bug, so feedback can carry one.
// Sheets can't hold an image, so the file goes to Drive and the row keeps a link.
// A failed upload must never lose the words: the text is written either way.
// The folder is created NEXT TO THE SPREADSHEET, not in the Drive root. The root
// version was findable only by searching for it by name, which is why the reported
// symptom was "I can't find the folder" rather than "the upload failed" — the files
// were there the whole time, just nowhere anyone would look.
function feedbackFolder() {
  var name = 'Nutrition OS Feedback';
  var parent = null;
  try {
    // The Sheet's own folder. If the file has no parent we can read (rare), fall
    // back to the root rather than failing the upload over a filing decision.
    var parents = DriveApp.getFileById(SpreadsheetApp.openById(SHEET_ID).getId()).getParents();
    if (parents.hasNext()) parent = parents.next();
  } catch (err) { parent = null; }

  var scope = parent || DriveApp.getRootFolder();
  var existing = scope.getFoldersByName(name);
  if (existing.hasNext()) return existing.next();
  // An older deployment may have made one in the root already — reuse it rather
  // than splitting screenshots across two folders with the same name.
  var loose = DriveApp.getFoldersByName(name);
  if (loose.hasNext()) return loose.next();
  return scope.createFolder(name);
}

// v4.25 (Phase 1). One-off owner tool: makes every screenshot already in the feedback folder
// private (the ones saved before v4.25 are "anyone with the link"). Safe to run twice.
function privatizeFeedback() {
  let n = 0;
  const files = feedbackFolder().getFiles();
  while (files.hasNext() && n < 2000) {
    const f = files.next();
    f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    n++;
  }
  return { success: true, madePrivate: n };
}

function saveFeedbackPhoto(base64, mimeType, person) {
  try {
    const folder = feedbackFolder();
    const ext  = (mimeType || 'image/png').split('/')[1] || 'png';
    // Date-first so the folder sorts chronologically, and the person's name in it
    // so a screenshot can be matched to a row without opening every file.
    const stamp = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd-HHmmss');
    const name = 'feedback-' + stamp + '-' + (person || 'unknown') + '.' + ext;
    const blob = Utilities.newBlob(Utilities.base64Decode(base64), mimeType || 'image/png', name);
    const file = folder.createFile(blob);
    // v4.25 (Phase 1). Private: only the Drive owner (you) can open it. It used to be "anyone
    // with the link", and a screenshot can show a household's food log.
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    return { url: file.getUrl(), folder: folder.getUrl(), name: name };
  } catch (err) {
    return null;
  }
}

// Updates the portion on menu rows for one dish in one slot. Scoped to a person when
// given, so a per-person amount can be changed without touching everyone else's.
// Only 'open' rows are touched: once a row is logged its portion is history, and
// rewriting it would silently disagree with the MealLog entry it already produced.
function updateMenuPortion(body) {
  const date = String(body.date || '').trim();
  const slot = String(body.slot || '').trim().toLowerCase();
  const dish = String(body.dish || '').trim().toLowerCase();
  if (!date || !slot || !dish) return { success: false, error: 'Missing key' };
  const person = String(body.person || '').trim().toLowerCase();
  const qty = (body.qty === '' || body.qty == null) ? '' : (+body.qty || '');
  const measure = String(body.measure || '');

  // v3.14. `includeLogged` lets the Menu edit a dish that has already been eaten.
  // The amount is not cosmetic — PortionFactor multiplies the macros — so changing it
  // on a logged dish MUST also rewrite the MealLog row, or the Menu and the day bar
  // would disagree about the same meal.
  const includeLogged = body.includeLogged === true || String(body.includeLogged) === 'true';

  const sheet = getSheet('Menu');
  const data = getDataRows(sheet);
  let n = 0;
  const logIds = [];
  data.forEach(function (r, i) {
    const status = String(r[6] || 'open');
    if (status !== 'open' && !(includeLogged && status === 'logged')) return;
    if (asISODate(r[1]) !== date) return;
    if (String(r[2] || '').trim().toLowerCase() !== slot) return;
    if (String(r[3] || '').trim().toLowerCase() !== dish) return;
    if (person && String(r[4] || '').trim().toLowerCase() !== person) return;
    // Menu columns 11 and 12. Portion/PortionFactor used to sit here and Qty/Measure
    // slid into exactly their place when they were removed, so the range is unchanged
    // — the VALUES are what changed. Verified against SHEETS.Menu, not assumed.
    sheet.getRange(i + 2, 11, 1, 2).setValues([[qty, measure]]);
    if (body.note !== undefined) {
      if (!String(sheet.getRange(1, 13).getValue() || '').trim()) sheet.getRange(1, 13).setValue('Note').setFontWeight('bold');
      sheet.getRange(i + 2, 13).setValue(String(body.note || '').trim().slice(0, 140));
    }
    n++;
    if (status === 'logged') {
      const lid = String(r[7] || '').trim();
      if (lid && logIds.indexOf(lid) === -1) logIds.push(lid);
    }
  });

  let relogged = 0;
  if (logIds.length) {
    const ml = getSheet('MealLog');
    const md = getDataRows(ml);
    for (let i = 0; i < md.length; i++) {
      if (logIds.indexOf(String(md[i][6] || '').trim()) === -1) continue;
      ml.getRange(i + 2, 9, 1, 2).setValues([[qty, measure]]);   // MealLog Qty, Measure
      relogged++;
    }
    // v4.12. The amount changed, so what came off the shelf must change with it.
    logIds.forEach(function (lid) { try { redoDeduction_(lid); } catch (e) {} });
  }
  return { success: true, updated: n, relogged: relogged };
}

// ── Household settings ──────────────────────────────────────────────────────
function getHousehold() {
  const sheet = getSheet('Household');
  const rows = sheet.getDataRange().getValues();
  const out = {};
  for (var i = 1; i < rows.length; i++) {
    const k = String(rows[i][0] || '').trim();
    if (k) out[k] = String(rows[i][1] == null ? '' : rows[i][1]);
  }
  return { settings: out };
}

// Upsert, key by key. A key that isn't in the payload is left alone rather than
// cleared — a client on an older version must not wipe settings it doesn't know
// about yet.
function saveHousehold(body) {
  const incoming = body.settings || {};
  const keys = Object.keys(incoming);
  if (!keys.length) return { success: true, saved: 0 };

  const sheet = getSheet('Household');
  const rows = sheet.getDataRange().getValues();
  const rowOf = {};
  for (var i = 1; i < rows.length; i++) {
    const k = String(rows[i][0] || '').trim();
    if (k) rowOf[k] = i + 1;
  }
  const stamp = istNow();
  const who = body.person || 'Unknown';
  const appends = [];
  keys.forEach(function (k) {
    const v = incoming[k] == null ? '' : String(incoming[k]);
    if (rowOf[k]) sheet.getRange(rowOf[k], 2, 1, 3).setValues([[v, stamp, who]]);
    else appends.push([k, v, stamp, who]);
  });
  if (appends.length) {
    sheet.getRange(getLastDataRow(sheet) + 1, 1, appends.length, 4).setValues(appends);
  }
  return { success: true, saved: keys.length };
}

function saveFeedback(body) {
  if (!body.message) return { success: false, error: 'No message' };
  const shot = body.photoBase64
    ? saveFeedbackPhoto(body.photoBase64, body.photoType, body.person)
    : null;
  const sheet = getSheet('Feedback');
  const row = getLastDataRow(sheet) + 1;
  // The text row is written whether or not the image made it — a failed upload must
  // never cost the words, which are the part that actually carries the report.
  sheet.getRange(row, 1, 1, 5).setValues([[
    istNow(), body.person || 'Unknown', body.message, body.screen || '', body.version || ''
  ]]);
  // setFormula, not setValue: a bare URL string is not clickable in Sheets, which is
  // the other half of "I can't find the screenshot".
  if (shot && shot.url) {
    sheet.getRange(row, 6).setFormula(
      '=HYPERLINK("' + shot.url + '","View screenshot")');
  } else {
    sheet.getRange(row, 6).setValue(body.photoBase64 ? 'upload failed' : '');
  }
  return {
    success: true,
    photoSaved: !!(shot && shot.url),
    photoAttempted: !!body.photoBase64,
    photoUrl: (shot && shot.url) || '',
    folderUrl: (shot && shot.folder) || ''
  };
}

function getFeedback() {
  const data = getDataRows(getSheet('Feedback'));
  return { feedback: data.map(r => ({ date: r[0], person: r[1], message: r[2],
    screen: r[3], version: r[4], photo: r[5] || '' })).reverse() };
}

// ── Wishlist ───────────────────────────────────
// A flat list of dish names the household would like cooked at some point.
// Case-insensitive on the dish name so "Rajma Chawal" and "rajma chawal" can't
// both sit in the list, and adding one that's already there is a no-op rather
// than an error — the client fires this from a heart toggle, and a double-tap
// should be harmless.
function getWishlist() {
  const data = getDataRows(getSheet('Wishlist'));
  return { wishlist: data.map(r => ({
    dish: r[0], addedBy: r[1], addedAt: r[2]
  })).filter(w => w.dish).reverse() };
}

function addWishlist(body) {
  const dish = String(body.dish || '').trim();
  if (!dish) return { success: false, error: 'No dish' };
  const sheet = getSheet('Wishlist');
  const data  = getDataRows(sheet);
  const key   = dish.toLowerCase();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0] || '').trim().toLowerCase() === key) {
      return { success: true, already: true };
    }
  }
  sheet.getRange(getLastDataRow(sheet) + 1, 1, 1, 3).setValues([[
    dish, body.addedBy || 'Unknown', istNow()
  ]]);
  return { success: true };
}

function removeWishlist(body) {
  const dish = String(body.dish || '').trim().toLowerCase();
  if (!dish) return { success: false, error: 'No dish' };
  const sheet = getSheet('Wishlist');
  const data  = getDataRows(sheet);
  // Bottom-up: deleting a row shifts everything below it, so descending order
  // keeps the remaining indices valid.
  let removed = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    if (String(data[i][0] || '').trim().toLowerCase() === dish) {
      sheet.deleteRow(i + 2);   // +1 for the header row, +1 because rows are 1-based
      removed++;
    }
  }
  return { success: true, removed: removed };
}

// ── The Menu ───────────────────────────────────
// Finalised dishes: what the cook is actually making, and for whom.
const SLOT_ORDER = ['breakfast', 'lunch', 'snack', 'dinner'];
// The hour each slot stops being "now" — the mirror of the client's mealSlot().
// A slot is swept once the clock has passed its end, which is the whole basis of
// "auto-log unless I cancel": the cancel window is the slot itself.
const SLOT_END = { breakfast: 11, lunch: 16, snack: 19, dinner: 24 };

function istToday() {
  return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
}
function istHour() {
  return parseInt(Utilities.formatDate(new Date(), 'Asia/Kolkata', 'H'), 10);
}
function newMenuID() {
  return 'M' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getMenu() {
  const data = getDataRows(getSheet('Menu'));
  return { menu: data.map(r => ({
    id: r[0], date: asISODate(r[1]), slot: String(r[2] || '').trim().toLowerCase(),
    dish: r[3], person: r[4],
    source: r[5] || 'pick', status: r[6] || 'open', logId: r[7] || '',
    addedBy: r[8] || '', addedAt: r[9] || '',
    qty: (r[10] === '' || r[10] == null) ? null : (+r[10] || null),
    measure: r[11] || '',
    note: String(r[12] || '')
  })).filter(m => m.dish && m.person) };
}

// Writing '2026-08-16' into a cell does NOT store a string — Sheets parses it into a
// real Date, which comes back as a Date object and serialises to JSON in UTC. At IST
// midnight that is the *previous* day, so a naive comparison against today() never
// matches and the whole menu silently disappears on the next sync. Every date read out
// of a sheet goes through here. (Same root cause as the original en-IN day-view bug —
// third time this project has been bitten by a date that isn't the string it looks like.)
function asISODate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Kolkata', 'yyyy-MM-dd');
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);   // en-IN d/m/yyyy
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd');
}

// Bulk add, because every real caller adds several at once: a dish for three
// people, or a whole approved plan. A row that already exists for the same
// date+slot+dish+person is skipped rather than erroring — tapping "+1" twice
// should be harmless, exactly as double-tapping a wishlist heart is.
function addMenuItems(body) {
  const items = body.items || [];
  if (!items.length) return { success: false, error: 'No items' };
  const sheet = getSheet('Menu');
  const data  = getDataRows(sheet);
  const seen  = {};
  data.forEach(r => {
    seen[[asISODate(r[1]), String(r[2]).trim().toLowerCase(),
          String(r[3]).toLowerCase(), String(r[4]).toLowerCase()].join('|')] = true;
  });
  const now = istNow(), rows = [], ids = [];
  items.forEach(it => {
    const date = String(it.date || istToday()).trim();
    const slot = String(it.slot || 'dinner').trim().toLowerCase();
    const dish = String(it.dish || '').trim();
    const person = String(it.person || '').trim();
    if (!dish || !person) return;
    const key = [date, slot, dish.toLowerCase(), person.toLowerCase()].join('|');
    if (seen[key]) return;
    seen[key] = true;
    const id = newMenuID();
    ids.push(id);
    rows.push([id, date, slot, dish, person, it.source || 'pick', 'open', '',
               body.addedBy || person, now,
               (it.qty === '' || it.qty == null) ? '' : (+it.qty || ''),
               it.measure || '', String(it.note || '').trim().slice(0, 140)]);
  });
  if (!rows.length) return { success: true, added: 0, already: true };
  const at = getLastDataRow(sheet) + 1;
  // Force the Date column to plain text before writing. Without this Sheets converts
  // '2026-08-16' into a Date on the way IN as well as the way out, and the sheet stops
  // being readable by eye — which is half the point of using a Sheet at all.
  sheet.getRange(at, 2, rows.length, 1).setNumberFormat('@');
  if (!String(sheet.getRange(1, 13).getValue() || '').trim()) sheet.getRange(1, 13).setValue('Note').setFontWeight('bold');
  sheet.getRange(at, 1, rows.length, 13).setValues(rows);
  return { success: true, added: rows.length, ids: ids };
}

// Leaving a dish. Accepts an id, or the natural key when the client is acting on
// what it can see rather than on an id it happens to hold.
function removeMenuItem(body) {
  const sheet = getSheet('Menu');
  const data  = getDataRows(sheet);
  const id    = String(body.id || '').trim();
  const date  = String(body.date || '').trim();
  const slot  = String(body.slot || '').trim().toLowerCase();
  const dish  = String(body.dish || '').trim().toLowerCase();
  const person = String(body.person || '').trim().toLowerCase();
  // v3.14. The Menu now shows eaten dishes as well as planned ones, so × on an eaten
  // dish has to mean something. `force` is that meaning: remove the row AND delete the
  // meal it produced. Without the flag the old rule still holds — a logged row is
  // history and deleting it silently would orphan the MealLog entry.
  const force = body.force === true || String(body.force) === 'true';
  if (!id && !(date && dish && person)) return { success: false, error: 'Nothing identified' };
  let removed = 0, unlogged = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    const r = data[i];
    const match = id
      ? String(r[0]).trim() === id
      : (asISODate(r[1]) === date && String(r[2]).trim().toLowerCase() === slot &&
         String(r[3]).trim().toLowerCase() === dish && String(r[4]).trim().toLowerCase() === person);
    if (!match) continue;
    const status = String(r[6] || 'open');
    if (status !== 'open' && !force) continue;
    // Delete the meal FIRST and with the bare helper, not deleteMealLog() — that one
    // reopens any Menu row pointing at the logId, which is the row we are about to
    // delete. Using it here would rewrite a row by index and then delete a different one.
    if (status === 'logged') {
      const logId = String(r[7] || '').trim();
      if (logId) unlogged += deleteMealLogRows_(logId);
    }
    sheet.deleteRow(i + 2); removed++;
  }
  return { success: true, removed: removed, unlogged: unlogged };
}

// Used when a plan is replaced or cancelled: drop this person's *future* unlogged
// rows and leave everything already eaten alone. Today's rows survive by default so
// cancelling a plan at lunchtime doesn't yank dinner out from under the cook.
function clearMenuRange(body) {
  const person = String(body.person || '').trim().toLowerCase();
  const from   = String(body.from || istToday()).trim();
  const source = String(body.source || '').trim();
  const sheet  = getSheet('Menu');
  const data   = getDataRows(sheet);
  let removed = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    const r = data[i];
    if (person && String(r[4]).trim().toLowerCase() !== person) continue;
    if (asISODate(r[1]) < from) continue;
    if (source && String(r[5] || '') !== source) continue;
    if (String(r[6] || 'open') !== 'open') continue;
    sheet.deleteRow(i + 2);
    removed++;
  }
  return { success: true, removed: removed };
}

// ── The auto-log sweep ─────────────────────────
// The heart of "I shouldn't have to open the app". Every open Menu row whose slot
// has finished becomes a logged meal. Three things make this safe enough to run
// without anyone watching:
//   1. LockService — two phones polling the same second cannot both log the row.
//   2. Status is the guard, not the clock — a row is logged exactly once because
//      the write flips it to 'logged' in the same locked section.
//   3. A 30-day horizon — if the app goes unopened for months, that isn't a
//      backlog to replay, it's a stale plan; those rows expire silently instead
//      of dumping a hundred invented meals into the log.
// It is deliberately NOT scoped to whoever opened the app: a person on a fixed
// menu may never open it at all, and scoping the sweep to the active person is
// exactly the bug that made the evening prep card useless for two of three people.
function sweepMenu() {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { success: false, busy: true }; }
  _lockHeld_ = true;   // v4.12: logMeal -> applyDeduction_ must not try to take the lock we hold
  try {
    const sheet = getSheet('Menu');
    const data  = getDataRows(sheet);
    const today = istToday(), hour = istHour();
    const horizon = Utilities.formatDate(
      new Date(Date.now() - 30 * 86400000), 'Asia/Kolkata', 'yyyy-MM-dd');

    const logged = [], expired = [];
    data.forEach((r, i) => {
      if (String(r[6] || 'open') !== 'open') return;
      const date = asISODate(r[1]);
      const slot = String(r[2]).trim().toLowerCase();
      if (date > today) return;                                   // still in the future
      if (date === today && hour < (SLOT_END[slot] || 24)) return; // slot still open — you can still cancel
      if (date < horizon) { expired.push(i + 2); return; }
      logged.push({ row: i + 2, date: date, slot: slot, dish: String(r[3]).trim(),
                    person: String(r[4]).trim(),
                    qty: (r[10] === '' || r[10] == null) ? '' : (+r[10] || ''),
                    measure: String(r[11] || '').trim() });
    });

    logged.forEach(m => {
      const logId = newLogID();
      const r = logMeal({
        mealName: m.dish, mealType: m.slot, loggedBy: m.person,
        notes: (m.qty && m.measure) ? 'From the menu · ' + m.qty + ' ' + m.measure
                                     : 'From the menu',
        qty: m.qty, measure: m.measure,
        logId: logId, source: 'auto',
        date: m.date === today ? istNow() : (asISODate(m.date) + ', 12:00 pm')
      });
      sheet.getRange(m.row, 7).setValue('logged');
      sheet.getRange(m.row, 8).setValue(r.logId || logId);
      // The sweep logs server-side, so the client never fires dish_logged for these.
      // Without this, check 5 sees a day with a menu view and no logging at all and
      // scores it as a pass on evidence that does not exist.
      try { logEvent({ event: 'dish_logged', detail: m.dish, person: m.person, version: 'sweep' }); }
      catch (e) {}
    });
    expired.forEach(row => sheet.getRange(row, 7).setValue('expired'));

    return { success: true, logged: logged.length, expired: expired.length,
             meals: logged.map(m => ({ dish: m.dish, person: m.person, slot: m.slot, date: m.date })) };
  } finally { _lockHeld_ = false; lock.releaseLock(); }
}

// ── Fixed meal plans ───────────────────────────
function getMealPlans() {
  const data = getDataRows(getSheet('MealPlans'));
  return { plans: data.map(r => {
    // Accepts both shapes: the original bare array, and the {slots, days} wrapper that
    // replaced it when slot selection was added. A plan saved before that still loads.
    let raw = [], slots = null;
    try { raw = JSON.parse(r[6] || '[]'); } catch (e) { raw = []; }
    if (raw && !Array.isArray(raw) && raw.days) { slots = raw.slots || null; raw = raw.days; }
    if (!Array.isArray(raw)) raw = [];
    return { person: r[0], mode: r[1] || 'daily', startDate: r[2] ? asISODate(r[2]) : '', days: +r[3] || 0,
             repeatGap: +r[4] || 0, notes: r[5] || '', plan: raw,
             slots: slots || (raw[0] && raw[0].slots ? Object.keys(raw[0].slots) : null),
             status: r[7] || 'active', updatedAt: r[8] || '' };
  }).filter(p => p.person) };
}

function saveMealPlan(body) {
  const person = String(body.person || '').trim();
  if (!person) return { success: false, error: 'No person' };
  const sheet = getSheet('MealPlans');
  const data  = getDataRows(sheet);
  const row = [person, body.mode || 'fixed', body.startDate || istToday(), +body.days || 0,
               +body.repeatGap || 0, body.notes || '', JSON.stringify(body.plan || []),
               body.status || 'active', istNow()];
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === person.toLowerCase()) {
      sheet.getRange(i + 2, 1, 1, 9).setValues([row]);
      return { success: true, updated: true };
    }
  }
  sheet.getRange(getLastDataRow(sheet) + 1, 1, 1, 9).setValues([row]);
  return { success: true, created: true };
}

// Switching a person between Fix Menu and Daily Selection without touching the
// plan itself, so flipping back to fixed doesn't mean regenerating from scratch.
function setPlanMode(body) {
  const person = String(body.person || '').trim();
  if (!person) return { success: false, error: 'No person' };
  const mode  = body.mode === 'fixed' ? 'fixed' : 'daily';
  const sheet = getSheet('MealPlans');
  const data  = getDataRows(sheet);
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === person.toLowerCase()) {
      sheet.getRange(i + 2, 2).setValue(mode);
      sheet.getRange(i + 2, 9).setValue(istNow());
      return { success: true, updated: true };
    }
  }
  sheet.getRange(getLastDataRow(sheet) + 1, 1, 1, 9).setValues([
    [person, mode, istToday(), 0, 0, '', '[]', 'active', istNow()]]);
  return { success: true, created: true };
}

// ── Members ────────────────────────────────────
// Deletes the person's row from Macros + Preferences (the two sheets that
// drive the member list in syncAll). MealLog/Workouts history is left intact.
function removeMember(person) {
  if (!person) return { success: false, error: 'No person specified' };
  // v4.24. A removed person's account stops being a member of this household: to come back they
  // need the PIN and to join again.
  if (authOn_()) deactivateMembership_(_activeHousehold_, person);
  let removed = 0;
  ['Macros', 'Preferences'].forEach(sheetName => {
    const sheet = getSheet(sheetName);
    const data  = getDataRows(sheet);
    for (let i = data.length - 1; i >= 0; i--) {
      if ((data[i][0] || '').toLowerCase() === person.toLowerCase()) {
        sheet.deleteRow(i + 2);
        removed++;
      }
    }
  });
  return { success: true, removed: removed };
}

// ── Helpers ────────────────────────────────────
// Auto-creates a missing sheet with its headers. Without this, any newly added
// sheet (e.g. Feedback) returns null and every write to it throws.
// ── Per-execution handle cache (v3.6, speed) ───────────────────────────────
// Every SpreadsheetApp call is a round trip to Google's servers (~10-50ms).
// openById() was being called once per getSheet() and once per sheet inside
// setupSheets(), which on a single request added up to 60+ round trips before
// any actual work happened. These caches live for one execution only — Apps
// Script starts a fresh global scope per request, so there is no staleness risk.
// ══════════════════════════════════════════════════════════════════════════════
// MULTI-TENANCY (v4.0) — registry, households, instrumentation
// ══════════════════════════════════════════════════════════════════════════════
//
// Ten beta households, one deployment, ten spreadsheets you own. The alternative
// — each friend deploying their own Apps Script — costs them a Google "this app
// isn't verified" screen and costs you all visibility when something breaks.

const REGISTRY_HEADERS = ['HouseholdID', 'Name', 'Phone', 'SheetID', 'PIN', 'Created', 'Notes'];

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE SIGN-IN (v4.24)
// ══════════════════════════════════════════════════════════════════════════════
// The app gets a Google ID token in the browser and sends it to authGoogle. We ask Google to
// verify it (tokeninfo), check it was issued to OUR client id, and then hand back our own signed
// session token (HMAC, 30 days) so Google is not called on every request. Requests carry `sess`;
// membership of a household lives in the Memberships tab of the registry spreadsheet.
//   Script properties: GOOGLE_CLIENT_ID (turns login on), AUTH_REQUIRED='yes' (turns the PIN-only
//   path off), SESSION_SECRET (made automatically).
var _authEmail_ = '';
const ACCOUNT_HEADERS = ['Email', 'Name', 'Photo', 'FirstSeen', 'LastSeen'];
const MEMBERSHIP_HEADERS = ['Email', 'HouseholdID', 'Person', 'Role', 'Joined', 'Status'];
const SESSION_DAYS = 30;

function authProp_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function authOn_() { return !!authProp_('GOOGLE_CLIENT_ID'); }
function authRequired_() { return authOn_() && authProp_('AUTH_REQUIRED') === 'yes'; }
function sessionSecret_() {
  let s = authProp_('SESSION_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); PropertiesService.getScriptProperties().setProperty('SESSION_SECRET', s); }
  return s;
}
function b64u_(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }
function signSession_(email) {
  const payload = JSON.stringify({ e: email, x: Date.now() + SESSION_DAYS * 86400000 });
  const p = b64u_(Utilities.newBlob(payload).getBytes());
  return 'v1.' + p + '.' + b64u_(Utilities.computeHmacSha256Signature(p, sessionSecret_()));
}
// Returns the email, or '' when the token is not ours, was altered, or has expired.
function verifySession_(tok) {
  try {
    const parts = String(tok || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return '';
    const want = b64u_(Utilities.computeHmacSha256Signature(parts[1], sessionSecret_()));
    let diff = want.length === parts[2].length ? 0 : 1;
    for (let i = 0; i < want.length; i++) diff |= (want.charCodeAt(i) ^ (parts[2].charCodeAt(i) || 0));
    if (diff) return '';
    const pad = parts[1] + '==='.slice((parts[1].length + 3) % 4);
    const o = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(pad)).getDataAsString());
    return (o && o.e && o.x > Date.now()) ? String(o.e).toLowerCase() : '';
  } catch (err) { return ''; }
}

// Run ONCE from the Apps Script editor after pasting this version: it makes Google show the
// "allow this script to connect to an external service" screen that sign-in verification needs.
function authorizeLogin() {
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true });
  return 'authorised';
}

function regTab_(name, headers) {
  const ss = SpreadsheetApp.openById(REGISTRY_SHEET_ID);
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#f3f2ef');
    sh.setFrozenRows(1);
  }
  return sh;
}
function tabRows_(sh, width) {
  return sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues().filter(function (r) { return r[0] !== ''; });
}
function normSlug_(x) { return String(x || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

function authGoogle(body) {
  if (!authOn_()) return { error: 'Sign-in is not set up on this backend yet.' };
  const tok = String((body && body.idToken) || '');
  if (!tok) return { error: 'No Google token' };
  let info;
  try {
    const resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tok), { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return { error: 'Google sign-in could not be verified' };
    info = JSON.parse(resp.getContentText());
  } catch (err) { return { error: 'Could not reach Google to verify the sign-in' }; }
  const okIss = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  if (info.aud !== authProp_('GOOGLE_CLIENT_ID') || !okIss) return { error: 'This sign-in was not issued for this app' };
  if (String(info.email_verified) !== 'true') return { error: 'That Google email is not verified' };
  if (!(+info.exp * 1000 > Date.now())) return { error: 'That sign-in has expired. Try again.' };
  const email = String(info.email || '').toLowerCase();
  if (!email) return { error: 'No email on that Google account' };
  const name = String(info.given_name || info.name || '').slice(0, 40);
  const picture = String(info.picture || '').slice(0, 500);

  withScriptLock_(function () {
    const sh = regTab_('Accounts', ACCOUNT_HEADERS);
    const rows = tabRows_(sh, ACCOUNT_HEADERS.length);
    let at = -1;
    rows.forEach(function (r, i) { if (String(r[0]).toLowerCase() === email) at = i; });
    const now = new Date();
    if (at < 0) sh.appendRow([email, name, picture, now, now]);
    else sh.getRange(at + 2, 2, 1, 4).setValues([[name || rows[at][1], picture || rows[at][2], rows[at][3], now]]);
    return true;
  }, 15000);
  return { success: true, session: signSession_(email), user: { email: email, name: name, picture: picture },
           households: householdsFor_(email) };
}

function householdsFor_(email) {
  const reg = {};
  registryRows_().forEach(function (r) { reg[String(r[0]).trim().toLowerCase()] = String(r[1]).trim(); });
  return tabRows_(regTab_('Memberships', MEMBERSHIP_HEADERS), MEMBERSHIP_HEADERS.length)
    .filter(function (r) { return String(r[0]).toLowerCase() === email && String(r[5] || 'active') === 'active' && reg[String(r[1]).toLowerCase()]; })
    .map(function (r) { return { hh: String(r[1]).toLowerCase(), name: reg[String(r[1]).toLowerCase()], person: String(r[2] || '') }; });
}
function myHouseholds() {
  if (!_authEmail_) return { error: 'Sign in required' };
  return { success: true, households: householdsFor_(_authEmail_) };
}

function isMember_(email, hh) {
  email = String(email || '').toLowerCase(); hh = String(hh || '').toLowerCase();
  if (!email || !hh) return false;
  const cache = CacheService.getScriptCache(), key = 'mem_' + email + '_' + hh;
  if (cache.get(key)) return true;
  const yes = tabRows_(regTab_('Memberships', MEMBERSHIP_HEADERS), MEMBERSHIP_HEADERS.length).some(function (r) {
    return String(r[0]).toLowerCase() === email && String(r[1]).toLowerCase() === hh && String(r[5] || 'active') === 'active';
  });
  if (yes) cache.put(key, '1', 600);   // only a "yes" is cached, so a removal never waits on a stale "no"
  return yes;
}
function addMembership_(email, hh, person, role) {
  email = String(email).toLowerCase(); hh = String(hh).toLowerCase();
  withScriptLock_(function () {
    const sh = regTab_('Memberships', MEMBERSHIP_HEADERS);
    const rows = tabRows_(sh, MEMBERSHIP_HEADERS.length);
    let at = -1;
    rows.forEach(function (r, i) { if (String(r[0]).toLowerCase() === email && String(r[1]).toLowerCase() === hh) at = i; });
    if (at < 0) sh.appendRow([email, hh, person || '', role || 'member', new Date(), 'active']);
    else sh.getRange(at + 2, 6).setValue('active');                  // re-joining after a removal
    return true;
  }, 15000);
  const cache = CacheService.getScriptCache();
  cache.remove('mem_' + email + '_' + hh); cache.remove('ppl_' + hh);
}
function deactivateMembership_(hh, person) {
  hh = String(hh || '').toLowerCase(); const want = String(person || '').trim().toLowerCase();
  if (!hh || !want) return 0;
  let n = 0; const cache = CacheService.getScriptCache();
  withScriptLock_(function () {
    const sh = regTab_('Memberships', MEMBERSHIP_HEADERS);
    tabRows_(sh, MEMBERSHIP_HEADERS.length).forEach(function (r, i) {
      if (String(r[1]).toLowerCase() === hh && String(r[2] || '').trim().toLowerCase() === want && String(r[5] || 'active') === 'active') {
        sh.getRange(i + 2, 6).setValue('removed'); cache.remove('mem_' + String(r[0]).toLowerCase() + '_' + hh); n++;
      }
    });
    return true;
  }, 15000);
  cache.remove('ppl_' + hh);
  return n;
}

// First time into a kitchen: house name + PIN, once. After this the account IS the key.
function joinHousehold(body) {
  if (!_authEmail_) return { error: 'Sign in required' };
  const typed = String((body && body.hh) || '').trim().toLowerCase();
  const slug = normSlug_(typed);
  const rows = registryRows_();
  const found = rows.filter(function (r) { return String(r[0]).trim().toLowerCase() === typed; })[0] ||
                rows.filter(function (r) { return String(r[0]).trim().toLowerCase() === slug; })[0];
  if (!found) return { error: 'Unknown household' };
  const pin = String(found[4] || '').trim();
  const hh = String(found[0]).trim().toLowerCase();
  const badPin = checkPin_(hh, (body && body.pin), pin);
  if (badPin) return badPin;
  addMembership_(_authEmail_, hh, '', 'member');
  return { success: true, hh: hh, name: String(found[1]).trim() };
}

// Ties this account to a person in the kitchen (the name on meals, targets and the photo).
function linkPerson(body) {
  if (!_authEmail_) return { error: 'Sign in required' };
  const person = String((body && body.person) || '').replace(/\s+/g, ' ').trim();
  if (!person || person.length > 40) return { error: 'A name is needed' };
  const hh = _activeHousehold_;
  const out = withScriptLock_(function () {
    const sh = regTab_('Memberships', MEMBERSHIP_HEADERS);
    const rows = tabRows_(sh, MEMBERSHIP_HEADERS.length);
    let mine = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (String(r[1]).toLowerCase() !== hh || String(r[5] || 'active') !== 'active') continue;
      if (String(r[0]).toLowerCase() === _authEmail_) mine = i;
      else if (String(r[2] || '').trim().toLowerCase() === person.toLowerCase())
        return { error: 'That person is already linked to another account.' };
    }
    if (mine < 0) return { error: 'Not a member of this household' };
    sh.getRange(mine + 2, 3).setValue(person);
    return { success: true, person: person };
  }, 15000);
  CacheService.getScriptCache().remove('ppl_' + hh);
  return (out && out.status === 'busy') ? { success: false, error: 'busy, try again' } : out;
}

// Who is in this kitchen, for the photo beside each name. Names and photos only: emails never leave.
function getPeople() {
  if (!authOn_() || !REGISTRY_SHEET_ID) return { people: [] };
  const hh = _activeHousehold_, cache = CacheService.getScriptCache();
  let list = null;
  const hit = cache.get('ppl_' + hh);
  if (hit) { try { list = JSON.parse(hit); } catch (err) { list = null; } }
  if (!list) {
    const photo = {};
    tabRows_(regTab_('Accounts', ACCOUNT_HEADERS), ACCOUNT_HEADERS.length).forEach(function (r) { photo[String(r[0]).toLowerCase()] = String(r[2] || ''); });
    list = tabRows_(regTab_('Memberships', MEMBERSHIP_HEADERS), MEMBERSHIP_HEADERS.length)
      .filter(function (r) { return String(r[1]).toLowerCase() === hh && String(r[5] || 'active') === 'active'; })
      .map(function (r) { return { person: String(r[2] || ''), photo: photo[String(r[0]).toLowerCase()] || '', _e: String(r[0]).toLowerCase() }; });
    cache.put('ppl_' + hh, JSON.stringify(list), 120);
  }
  return { people: list.map(function (x) { return { person: x.person, photo: x.photo, me: !!_authEmail_ && x._e === _authEmail_ }; }) };
}

// v4.5. The Registry tab builds itself on first use, the same way every other tab
// in this project does — a setup function you have to remember to run is a setup
// function that silently doesn't get run, which is exactly how this went wrong.
//
// Deliberately NOT in SHEETS: everything listed there gets created in EVERY
// household's spreadsheet by setupSheetsUncached_(). The registry is global, not
// household data, and a copy of it inside each household's file would be a
// confusing lie about where the real one lives.
function registrySheet_() {
  const ss = SpreadsheetApp.openById(REGISTRY_SHEET_ID);
  let sh = ss.getSheetByName('Registry');
  if (!sh) sh = ss.insertSheet('Registry');

  if (!sh.getRange(1, 1).getValue()) {
    sh.getRange(1, 1, 1, REGISTRY_HEADERS.length).setValues([REGISTRY_HEADERS])
      .setFontWeight('bold').setBackground('#f3f2ef');
    sh.setFrozenRows(1);
  }
  // The PIN column is forced to plain text BEFORE anything is written to it.
  // Sheets reads 0000 as the number zero, and the default household PIN would
  // then fail every check for a reason that is invisible in the grid.
  sh.getRange(1, 5, sh.getMaxRows(), 1).setNumberFormat('@');

  // Register the original household against the spreadsheet it already has. This
  // matters more than it looks: it puts your own kitchen on the same resolution
  // path as every beta user, and a path only one person takes is a path that
  // stays broken until a friend finds it.
  const last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, REGISTRY_HEADERS.length).getValues() : [];
  if (!rows.some(r => String(r[0]).trim().toLowerCase() === 'home')) {
    sh.appendRow(['home', 'Home', '', SHEET_ID, '0000', new Date(), 'original household']);
  }
  return sh;
}

function registryRows_() {
  if (!REGISTRY_SHEET_ID) return [];
  const sh = registrySheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, REGISTRY_HEADERS.length).getValues()
           .filter(r => r[0] !== '');
}

// Resolving hits the registry spreadsheet, which is a round trip we do NOT want
// in front of every one of the ~11 reads a sync makes. The mapping almost never
// changes, so it is cached for six hours per household.
// v4.25 (Phase 1). PIN guessing. A 4-digit PIN has 10,000 possibilities, so after 5 wrong
// tries for one household the PIN door shuts for 15 minutes (even for the right PIN, or the
// limit would be pointless). Signed-in members never go through the PIN, so they are not
// affected. The count lives in CacheService, so it forgets by itself after the window.
// The counter is updated under the script lock: without it, 30 requests sent at the same
// instant would all read "0 wrong so far" and all get a free guess.
var PIN_MAX_WRONG_ = 5;
var PIN_LOCK_SECONDS_ = 900;
function pinFailKey_(hh) { return 'pinfail_' + String(hh).trim().toLowerCase(); }
function pinLocked_(hh) {
  return Number(CacheService.getScriptCache().get(pinFailKey_(hh)) || 0) >= PIN_MAX_WRONG_;
}
function pinWrong_(hh) {
  const cache = CacheService.getScriptCache(), key = pinFailKey_(hh);
  const lock = LockService.getScriptLock();
  let have = false;
  try { have = lock.tryLock(3000); } catch (e) { have = false; }
  try {
    cache.put(key, String(Number(cache.get(key) || 0) + 1), PIN_LOCK_SECONDS_);
  } finally { if (have) { try { lock.releaseLock(); } catch (e) {} } }
}
var PIN_LOCKED_MSG_ = 'Too many wrong PINs. This kitchen is locked for 15 minutes.';
// The single place a typed PIN is compared. Returns null when it is right, else an error object.
// An empty registry PIN means the kitchen has none (no check, no counting).
function checkPin_(hh, typed, expected) {
  if (!expected) return null;
  if (pinLocked_(hh)) return { error: PIN_LOCKED_MSG_, locked: true };
  if (String(typed || '').trim() === expected) {
    CacheService.getScriptCache().remove(pinFailKey_(hh));
    return null;
  }
  pinWrong_(hh);
  return { error: pinLocked_(hh) ? PIN_LOCKED_MSG_ : 'Bad PIN', locked: pinLocked_(hh) };
}

// Owner tool: opens a locked kitchen straight away instead of waiting 15 minutes.
// Runs before household resolution (a locked kitchen cannot resolve), so it asks for the owner key.
function unlockHousehold(body) {
  const denied = requireOwner_(body);
  if (denied) return denied;
  const hh = String((body && body.hh) || '').trim().toLowerCase();
  if (!hh) return { error: 'hh required' };
  CacheService.getScriptCache().remove(pinFailKey_(hh));
  return { success: true, unlocked: hh };
}

function resolveHousehold_(hh, pin, email) {
  // v4.25 (Phase 1). No household name = refused. This used to fall through to the ORIGINAL
  // spreadsheet (the one holding the registry and every kitchen's PIN) with no PIN at all, so
  // anyone who knew the web address could read it or write into it. Every phone since v4.0
  // sends a household name on every request after setup; create/join/sign-in answer earlier.
  if (!hh) return { error: 'Household required' };
  hh = String(hh).trim().toLowerCase();
  const cache = CacheService.getScriptCache();
  const ckey = 'hh_' + hh;
  let hit = cache.get(ckey);
  let row = hit ? JSON.parse(hit) : null;

  if (!row) {
    const found = registryRows_().filter(r => String(r[0]).trim().toLowerCase() === hh)[0];
    if (!found) return { error: 'Unknown household' };
    // Everything is trimmed because these cells are now typed by hand. A trailing
    // space after 0000 is invisible in the grid and would fail every PIN check.
    row = { sheetId: String(found[3]).trim(), pin: String(found[4]).trim(),
            name: String(found[1]).trim() };
    // Ten minutes, not six hours. The cache exists to keep the registry read off
    // the ~11 reads a sync makes — ten minutes does that just as well. Six hours
    // meant a corrected PIN stayed rejected for the rest of the day, with the sheet
    // visibly showing the right value, which is the worst kind of bug to debug.
    cache.put(ckey, JSON.stringify(row), 600);
  }
  // A PIN is not real auth. It stops a household ID that gets shared in a
  // WhatsApp group from being enough to read someone's food log, which for ten
  // friends is the proportionate amount of security to build.
  // v4.24. A signed-in member needs no PIN (the PIN is only for joining). Without a membership the
  // PIN still works while login is optional, so phones on an older app keep working through the
  // rollout; once AUTH_REQUIRED is set, only members get in.
  if (email && isMember_(email, hh)) {
    /* member: no PIN needed */
  } else if (authRequired_()) {
    return { error: email ? 'Not a member of this household' : 'Sign in required' };
  } else {
    const bad = checkPin_(hh, pin, row.pin);
    if (bad) return bad;
  }
  if (!row.sheetId) return { error: 'Household has no spreadsheet' };

  _activeSheetId_ = row.sheetId;
  _activeHousehold_ = hh;
  return { ok: true, name: row.name };
}

// Drops every cached household mapping. Reachable as a plain URL so a bad PIN or a
// corrected SheetID can be fixed from a browser — needing the Apps Script editor to
// unstick a login is exactly the dependency that made the registry hard to set up.
function clearRegistryCache() {
  const cache = CacheService.getScriptCache();
  const ids = registryRows_().map(r => 'hh_' + String(r[0]).trim().toLowerCase());
  ids.push('hh_home');
  cache.removeAll(ids);
  return { success: true, cleared: ids.length };
}

// Onboarding. Creates a spreadsheet YOU own, gives it the full schema, seeds the
// household settings, and hands back the id + PIN for the client to store.
// Deliberately does NOT require a PIN to call — it is the one action that runs
// before a household exists.
function createHousehold(body) {
  if (!REGISTRY_SHEET_ID) return { error: 'Registry not configured' };
  if (authRequired_() && !_authEmail_) return { error: 'Sign in required' };
  const name = String((body && body.name) || '').trim();
  if (!name) return { error: 'Name required' };
  // v4.17. Same rules as the app's create screen, enforced here too so nothing else can
  // bypass them. The name becomes the ID friends type to join, so it must survive that.
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{1,28}[A-Za-z0-9]$/.test(name) || !/[A-Za-z]/.test(name) || / {2,}|-{2,}/.test(name))
    return { error: 'House name: 3-30 characters, letters, numbers, spaces and hyphens only' };
  if (['home', 'default', 'admin', 'test'].indexOf(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')) > -1)
    return { error: 'That house name is reserved' };
  const askedPin = String((body && body.pin) || '').trim();
  if (askedPin && !/^\d{4,6}$/.test(askedPin)) return { error: 'PIN must be 4 to 6 digits' };

  const existing = registryRows_();
  const id = uniqueSlug(name, existing.map(r => String(r[0])));
  // v4.14. Honour the PIN the person typed at the gate (4-6 digits); otherwise generate one.
  // Before this the typed PIN was ignored, so the phone stored a PIN the registry did not have.
  const asked = String((body && body.pin) || '').trim();
  const pin = /^\d{4,6}$/.test(asked) ? asked : String(Math.floor(1000 + Math.random() * 9000));

  const ss = SpreadsheetApp.create('Nutrition OS — ' + name);
  const sheetId = ss.getId();

  // Point the whole module at the new spreadsheet, then reuse the ordinary setup
  // path. Building the schema a second way here is how the two drift apart.
  _activeSheetId_ = sheetId;
  _activeHousehold_ = id;
  _ssCache_ = {}; _shCache_ = {};
  setupSheetsUncached_();
  // A brand-new spreadsheet ships with a "Sheet1" nobody wants.
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);

  // saveHousehold takes a settings OBJECT, not key/value pairs — onboarding
  // sends the cook's name, language and region in one write.
  if (body && body.household && typeof body.household === 'object') {
    try { saveHousehold({ settings: body.household, person: name }); } catch (err) {}
  }

  // registrySheet_(), not getSheetByName — signing up the very first beta user
  // must not depend on the tab already existing.
  registrySheet_()
    .appendRow([id, name, String((body && body.phone) || ''), sheetId, pin, new Date(), 'beta']);

  if (_authEmail_) addMembership_(_authEmail_, id, '', 'owner');
  return { success: true, hh: id, pin: pin, sheetId: sheetId };
}

// ── Instrumentation ────────────────────────────────────────────────────────
// Deliberately append-only and deliberately dumb. Anything that needs computing
// is computed in getChecks, so a bad analysis is a re-read rather than lost data.
function logEvent(body) {
  const ev = String((body && body.event) || '').trim();
  if (!ev) return { error: 'event required' };
  const now = new Date();
  getSheet('Events').appendRow([
    now,
    Utilities.formatDate(now, 'Asia/Kolkata', 'yyyy-MM-dd'),   // v4.25: IST, whatever the project timezone
    String((body && body.person) || ''),
    ev,
    String((body && body.detail) || ''),
    String((body && body.version) || '')
  ]);
  return { success: true };
}

// The six checks, minus the two that need a tap in the UI (translation job,
// food accepted). Returns raw counts alongside the verdicts — a check that only
// says pass/fail is a check you can't debug.
// v4.25. The calendar day (IST) of a sheet value: a real Date, "2026-10-21 …", or the en-IN
// text "21/10/2026, 1:05:00 am" that logMeal has written since v4.21. new Date() cannot read
// the last one (it gives Invalid Date, or the wrong month when the day is 12 or less), which
// silently dropped meals out of checks 1 and 3. '' when there is no date.
function istDay_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, 'Asia/Kolkata', 'yyyy-MM-dd');
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return '';
}

function getChecks(body) {
  const days = Math.max(1, Number((body && body.days) || 14));
  const cutoffDay = istDay_(new Date(Date.now() - days * 86400000));

  // Days come from the timestamp in IST, not from the stored Day column, which was written in
  // the project's timezone before v4.25.
  const events = getDataRows(getSheet('Events'))
    .filter(r => istDay_(r[0]) && istDay_(r[0]) >= cutoffDay)
    .map(r => ({ ts: new Date(r[0]), day: istDay_(r[0]), event: String(r[3]), detail: String(r[4]) }));

  const meals = getDataRows(getSheet('MealLog'))
    .filter(r => istDay_(r[0]) && istDay_(r[0]) >= cutoffDay)
    .map(r => ({ day: istDay_(r[0]), dish: String(r[1]).toLowerCase().trim(), source: String(r[7] || '') }));

  const byDay = {};
  events.forEach(e => { (byDay[e.day] = byDay[e.day] || []).push(e); });
  const activeDays = Object.keys(byDay).sort();

  // Check 5 — first stop, not second opinion. The menu was looked at before any
  // food was logged that day, i.e. the app was consulted rather than reported to.
  let firstStop = 0;
  activeDays.forEach(day => {
    const evs = byDay[day].slice().sort((a, b) => a.ts - b.ts);
    const firstMenu = evs.filter(e => e.event === 'menu_view' || e.event === 'menu_generated')[0];
    const firstLog  = evs.filter(e => e.event === 'dish_logged')[0];
    if (firstMenu && (!firstLog || firstMenu.ts <= firstLog.ts)) firstStop++;
  });

  // Check 1 — the fallback, by proxy. A day where a menu was generated and then
  // nothing from it got eaten is a day the household went and made something else.
  let abandoned = 0;
  activeDays.forEach(day => {
    const gen = byDay[day].some(e => e.event === 'menu_generated');
    if (!gen) return;
    // 'auto' counts as eating from the menu, and missing it was a real defect: the
    // sweep writes 'auto', the client writes 'menu' only when someone logs by hand.
    // A household on a fixed plan that follows the menu perfectly logs nothing
    // manually, so this check would have reported them as abandoning it every day.
    // An auto-logged meal comes FROM a Menu row by definition — it is the strongest
    // evidence the menu was followed, not the weakest.
    const ateFromMenu = meals.some(m => m.day === day && (m.source === 'menu' || m.source === 'auto'));
    if (!ateFromMenu) abandoned++;
  });

  // Check 3 — prep landed. A dish shown on the prep card was actually eaten the
  // following day, which is the only evidence that the night-before nudge works.
  let prepLanded = 0, prepShown = 0;
  events.filter(e => e.event === 'prep_shown').forEach(e => {
    prepShown++;
    const dish = e.detail.toLowerCase().trim();
    if (!dish) return;
    const nextDay = istDay_(new Date(e.ts.getTime() + 86400000));
    if (meals.some(m => m.day === nextDay && m.dish.indexOf(dish) > -1)) prepLanded++;
  });

  // Check 6 — it learned. NOT a total: the onboarding grid writes to the same
  // field, so a household that taps twenty chips at setup would pass this at
  // minute five having taught the app nothing. What the check actually claims is
  // that the repertoire GREW through use, so only dishes that didn't come from
  // the seeding grid count, and the bar is correspondingly lower.
  let learned = 0, seeded = 0;
  try {
    const skills = (getCookSkills().skills || []).filter(s => String(s.cookKnows).toLowerCase() === 'yes');
    seeded  = skills.filter(s => String(s.source) === 'seeded').length;
    learned = skills.length - seeded;
  } catch (err) {}

  return {
    household: _activeHousehold_,
    windowDays: days,
    activeDays: activeDays.length,
    checks: {
      fallback:    { pass: abandoned === 0,    abandonedDays: abandoned },
      prepLanded:  { pass: prepLanded >= 1,    landed: prepLanded, shown: prepShown },
      firstStop:   { pass: firstStop >= 10,    days: firstStop, of: activeDays.length },
      // Both numbers are reported, because "5 learned on top of 3 seeded" and
      // "5 learned on top of 40 seeded" are very different kitchens and a single
      // verdict would hide which one you're looking at.
      itLearned:   { pass: learned >= 5,       learned: learned, seeded: seeded }
    }
  };
}

var _ssCache_ = {};
var _shCache_ = {};
function ssFor(name) {
  // The library is shared by every household; everything else follows whichever
  // household this request resolved to.
  const id = LIBRARY_SHEETS.indexOf(name) > -1 ? LIBRARY_SHEET_ID : _activeSheetId_;
  if (!_ssCache_[id]) _ssCache_[id] = SpreadsheetApp.openById(id);
  return _ssCache_[id];
}
function getSheet(name) {
  if (_shCache_[name]) return _shCache_[name];
  const ss = ssFor(name);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    const headers = SHEETS[name];
    if (headers) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }
  _shCache_[name] = sheet;
  return sheet;
}
function getDataRows(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues().filter(r => r[0] !== '');
}
function clearDataRows(sheet) {
  const last = sheet.getLastRow();
  if (last >= 2) sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).clearContent();
}
function getLastDataRow(sheet) { return sheet.getLastRow(); }
function istNow() { return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }); }
function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
