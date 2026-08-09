// ==UserScript==
// @name        Nexus Legacy Trade Value By DasToast
// @namespace   nexuslegacy-alliance-tools
// @author      DasToast
// @description Annotates Alliance Trade, Market Browse, Create Order, Hub Inventory, and My Orders with a fair-value ratio under your own resource weights, plus an inline Fair Trade Calculator. Standalone — completely independent from the Market Value script.
// @version     3.11.2
// @match       https://*.nexuslegacy.space/*
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @run-at      document-idle
// @noframes
// ==/UserScript==

/*
 * Display tool for Alliance Trade, Market Browse, Create Order, Hub
 * Inventory, and My Orders — separate namespace, separate storage. No
 * network, no token, no polling (an event-driven MutationObserver instead).
 * Parses the market DOM client-side and annotates each order row in place.
 *
 * Every order is "you GIVE the request, you GET the offer". Alliance Trade
 * has no hub fee (0% commission); the regular Market does, read straight off
 * the game's own displayed rate (Hub Inventory's "X% fee" or a per-order
 * "after N% fee" line) — never guessed or hardcoded. We value both sides
 * with your weights and show the ratio get/give (×1.00 = fair value; >1
 * favours you) plus the value delta.
 *
 * Weights: DEFAULT_WEIGHTS below is the built-in ratio table. Storage only
 * ever holds the *overrides* the user has typed in the inline panel — a
 * blank field simply means "use the default for this resource". This makes
 * the UI unambiguous: greyed-out placeholder = default value in effect,
 * a typed value = your override, clearing the field reverts to default.
 *
 * Edit weights via the inline Ratios panel next to the Fair Trade
 * Calculator, or via the userscript menu → "Set alliance trade resource
 * weights" (raw JSON, same overrides format, for bulk edits).
 */

(function () {
  'use strict';

  // value of one unit of each resource, relative to Ore = 1
  const DEFAULT_WEIGHTS = {
    ore: 1, silicates: 2, hydrogen: 3, alloys: 5, bioextract: 3,
    // cryo-ice / plasma core a notch above hydrogen; quantum dust, dark
    // matter, and antimatter are the late-game rares.
    cryoice: 6, plasmacore: 6, quantumdust: 30, darkmatter: 30, antimatter: 30,
  };

  const norm = (name) => (name || '').toLowerCase().replace(/[^a-z]/g, '');

  // ---- language (explicit user setting, persisted) ----
  // Default English; the user can switch to German via the settings gear
  // in the calculator, and the choice is remembered across sessions.
  const LANG_KEY = 'nexusLang';
  function getStoredLang() {
    try {
      const v = GM_getValue(LANG_KEY, '');
      return (v === 'de' || v === 'en') ? v : null;
    } catch (e) { return null; }
  }
  function setStoredLang(lang) {
    try { GM_setValue(LANG_KEY, lang); } catch (e) { /* ignore */ }
  }

  let LANG = getStoredLang() || 'en';

  const RESOURCE_LABELS = {
    en: {
      ore: 'Ore', silicates: 'Silicates', hydrogen: 'Hydrogen', alloys: 'Alloys',
      bioextract: 'Bio Extract', cryoice: 'Cryo Ice', plasmacore: 'Plasma Core',
      quantumdust: 'Quantum Dust', darkmatter: 'Dark Matter', antimatter: 'Antimatter',
    },
    de: {
      ore: 'Erz', silicates: 'Silikate', hydrogen: 'Wasserstoff', alloys: 'Legierungen',
      bioextract: 'Bioextrakt', cryoice: 'Kryo-Eis', plasmacore: 'Plasmakern',
      quantumdust: 'Quantenstaub', darkmatter: 'Dunkle Materie', antimatter: 'Antimaterie',
    },
  };

  const I18N = {
    en: {
      calcTitle: 'Fair Trade Calculator',
      give: 'Give',
      askExactly: 'ask for exactly',
      orRounded: 'or rounded',
      amountToGive: 'amount to give',
      copyShipsNeeded: 'Copy this number to paste into the ship count field '
        + '(only ship types that can actually carry this resource are counted)',
      notEnoughCargoSpace: 'Not enough cargo space',
      notEnoughCargoSpaceTooltip: (avail, need) =>
        `Combined capacity across all eligible ship types: ${fmt(avail)} available vs. `
        + `${fmt(need)} needed. Some ships (e.g. Tanker, Ore Freighter) can only carry `
        + 'specific resources and are excluded when they can\'t carry this one.',
      copied: 'copied!',
      amountToGet: 'amount to get',
      roundedAmount: 'rounded amount',
      pickDifferent: 'pick two different resources',
      noWeightRate: 'no weight set for one of these — check the userscript menu',
      fairRate: (giveLabel, val, getLabel) => `fair rate  1 ${giveLabel} = ${val} ${getLabel}`,
      askRoundedTooltip: (exactAsk, roundedAsk, getLabel, delta, equivGet) =>
        `rounded ${exactAsk.toFixed(2)} ${getLabel} (exact fair amount) to ${roundedAsk.toLocaleString()} ${getLabel}\n`
        + `${delta >= 0 ? 'profit' : 'loss'} from rounding: ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} value`,
      justCalculating: "Calculator won't automate anything.",
      feeUpdateHint: 'To update your fee cost, open Hub Inventory after research.',
      swapTooltip: 'Swap Give and Ask For',
      ratios: 'Ratios',
      ratiosTooltip: 'These are the default ratios used to value trades. Type a number to override.',
      resetRatios: 'Reset Ratios',
      resetRatiosTooltip: 'Reset all resource ratios back to their defaults (does not affect the fee).',
      settingsTooltip: 'Calculator settings',
      autoFillToggleLabel: 'Enable auto-fill buttons (experimental)',
      autoFillWarning: 'This only fills a quantity field (ship count, or the Create Order '
        + 'amounts) for your review — it never sends the fleet or submits the order itself. '
        + 'Still, if the third-party tool policy changes, this specific feature could become '
        + 'disallowed — you use it at your own risk.',
      autoFillButton: (count, shipName) => `Auto-fill ${count}× ${shipName}`,
      fillCalcTooltip: 'Load this trade into the Fair Trade Calculator',
      fillOrderFormButtonExact: 'Fill exact',
      fillOrderFormButtonRounded: 'Fill rounded',
      languageLabel: 'Language',
      weightPillTitle: (label, def) => `${label} — blank use the default (${def})`,
      noWeightPillTitle: (missing) => `No weight set for "${missing}" — add it via the userscript menu.`,
      youWereBuyer: 'You were the buyer on this trade.',
      youWereSeller: 'You were the seller (order creator) on this trade.',
      buyerTitle: (delta, equivGet, getResource) =>
        `buyer ${delta >= 0 ? 'profit' : 'loss'} ${delta >= 0 ? '+' : ''}${fmt(delta)} value\n`
        + `≈ ${delta >= 0 ? '+' : ''}${Math.round(equivGet).toLocaleString()} ${getResource} `
        + `${delta >= 0 ? 'more' : 'less'} than fair value`,
      sellerTitle: (delta, equivGet, getResource) =>
        `seller ${delta >= 0 ? 'profit' : 'loss'} ${delta >= 0 ? '+' : ''}${fmt(delta)} value\n`
        + `≈ ${delta >= 0 ? '+' : ''}${Math.round(equivGet).toLocaleString()} ${getResource} `
        + `${delta >= 0 ? 'more' : 'less'} than fair value`,
      menuCommand: 'Set alliance trade resource weights',
      promptText: 'Resource weight OVERRIDES as JSON (value per unit, relative to Ore=1).\n'
        + 'Only include resources you want to override — anything omitted uses\n'
        + 'the built-in default:',
      invalidJson: 'Invalid JSON: ',
      feeLabel: 'Fee',
      feeTooltip: 'Market Browse hub fee (%) taken from what you receive when filling an '
        + "order — Alliance Trade has none. Read straight off the game's own hub-inventory "
        + 'rate or per-order net line; shows "error" if neither has ever been seen.',
      feeAppliedNote: (pct) => `\n(${pct}% market fee already deducted from what you receive)`,
      feeAdjustedRate: (val, pct) => `with ${pct}% fee: ask for ${val} instead`,
      feeError: 'open Hub Inventory',
      feeErrorNote: '\n(fee rate unknown — open Hub Inventory once to detect it)',
      feeErrorLine: 'fee rate unknown — open Hub Inventory once to detect it',
      feeToolTipAlliance: 'Alliance Trade has no hub fee — 0% commission.',
      feeNoneAlliance: 'Alliance Trade has no fee — 0% commission.',
    },
    de: {
      calcTitle: 'Fairer-Handel-Rechner',
      give: 'Geben',
      askExactly: 'verlangen genau',
      orRounded: 'oder gerundet',
      amountToGive: 'Menge geben',
      copyShipsNeeded: 'Diese Zahl kopieren, um sie ins Schiffsanzahl-Feld einzufügen '
        + '(nur Schiffstypen, die diese Ressource tatsächlich tragen können, zählen mit)',
      notEnoughCargoSpace: 'Nicht genug Frachtraum',
      notEnoughCargoSpaceTooltip: (avail, need) =>
        `Kombinierte Kapazität über alle geeigneten Schiffstypen: ${fmt(avail)} verfügbar `
        + `gegen ${fmt(need)} benötigt. Manche Schiffe (z.B. Tanker, Ore Freighter) können nur `
        + 'bestimmte Ressourcen tragen und werden ausgeschlossen, wenn sie diese nicht tragen können.',
      copied: 'kopiert!',
      amountToGet: 'Menge erhalten',
      roundedAmount: 'gerundet',
      pickDifferent: 'zwei unterschiedliche Ressourcen wählen',
      noWeightRate: 'für eine davon ist kein Gewicht gesetzt — im Userscript-Menü prüfen',
      fairRate: (giveLabel, val, getLabel) => `fairer Kurs  1 ${giveLabel} = ${val} ${getLabel}`,
      askRoundedTooltip: (exactAsk, roundedAsk, getLabel, delta, equivGet) =>
        `${exactAsk.toFixed(2)} ${getLabel} (genauer fairer Betrag) gerundet auf ${roundedAsk.toLocaleString()} ${getLabel}\n`
        + `${delta >= 0 ? 'Gewinn' : 'Verlust'} durch die Rundung: ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} Wert`,
      justCalculating: 'Der Rechner automatisiert nichts.',
      feeUpdateHint: 'Um deine Gebühr zu aktualisieren, öffne nach der Forschung Hub Inventory.',
      swapTooltip: 'Geben und Verlangen tauschen',
      ratios: 'Verhältnisse',
      ratiosTooltip: 'Das sind die Standard-Verhältnisse zur Bewertung von Trades. Zahl eingeben zum Überschreiben.',
      resetRatios: 'Ratios zurücksetzen',
      resetRatiosTooltip: 'Alle Ressourcen-Verhältnisse auf den Standard zurücksetzen (betrifft nicht die Gebühr).',
      settingsTooltip: 'Rechner-Einstellungen',
      autoFillToggleLabel: 'Auto-Fill-Buttons aktivieren (experimentell)',
      autoFillWarning: 'Füllt nur ein Mengenfeld (Schiffsanzahl oder die Create-Order-Werte) '
        + 'zur Kontrolle aus — schickt die Flotte nie los und sendet die Order nie selbst ab. '
        + 'Sollte sich die Third-Party-Tool-Police ändern, könnte genau dieses Feature künftig '
        + 'nicht mehr erlaubt sein — Nutzung auf eigenes Risiko.',
      autoFillButton: (count, shipName) => `${count}× ${shipName} automatisch eintragen`,
      fillCalcTooltip: 'Diesen Trade in den Fair Trade Calculator laden',
      fillOrderFormButtonExact: 'Exakt übernehmen',
      fillOrderFormButtonRounded: 'Gerundet übernehmen',
      languageLabel: 'Sprache',
      weightPillTitle: (label, def) => `${label} — leer lassen für den Standardwert (${def})`,
      noWeightPillTitle: (missing) => `Kein Gewicht für "${missing}" gesetzt — über das Userscript-Menü hinzufügen.`,
      youWereBuyer: 'Du warst der Käufer in diesem Trade.',
      youWereSeller: 'Du warst der Verkäufer (Ersteller der Order) in diesem Trade.',
      buyerTitle: (delta, equivGet, getResource) =>
        `Käufer-${delta >= 0 ? 'Gewinn' : 'Verlust'} ${delta >= 0 ? '+' : ''}${fmt(delta)} Wert\n`
        + `≈ ${delta >= 0 ? '+' : ''}${Math.round(equivGet).toLocaleString()} ${getResource} `
        + `${delta >= 0 ? 'mehr' : 'weniger'} als der faire Wert`,
      sellerTitle: (delta, equivGet, getResource) =>
        `Verkäufer-${delta >= 0 ? 'Gewinn' : 'Verlust'} ${delta >= 0 ? '+' : ''}${fmt(delta)} Wert\n`
        + `≈ ${delta >= 0 ? '+' : ''}${Math.round(equivGet).toLocaleString()} ${getResource} `
        + `${delta >= 0 ? 'mehr' : 'weniger'} als der faire Wert`,
      menuCommand: 'Alliance-Trade-Ressourcengewichte festlegen',
      promptText: 'Ressourcengewicht-ÜBERSCHREIBUNGEN als JSON (Wert pro Einheit, relativ zu Erz=1).\n'
        + 'Nur Ressourcen angeben, die überschrieben werden sollen — alles andere\n'
        + 'nutzt den eingebauten Standard:',
      invalidJson: 'Ungültiges JSON: ',
      feeLabel: 'Gebühr',
      feeTooltip: 'Markt-Gebühr (%) beim Erfüllen einer Browse-Order, wird vom Erhaltenen '
        + 'abgezogen — Alliance Trade hat keine. Wird direkt aus der Hub-Inventory-Rate oder '
        + 'der Netto-Zeile pro Order gelesen; zeigt "error", falls noch keins davon je '
        + 'gesehen wurde.',
      feeAppliedNote: (pct) => `\n(${pct}% Markt-Gebühr bereits vom Erhaltenen abgezogen)`,
      feeAdjustedRate: (val, pct) => `mit ${pct}% Gebühr: verlange stattdessen ${val}`,
      feeError: 'Hub Inventory öffnen',
      feeErrorNote: '\n(Gebühr unbekannt — einmal Hub Inventory öffnen zum Erkennen)',
      feeErrorLine: 'Gebühr unbekannt — einmal Hub Inventory öffnen zum Erkennen',
      feeToolTipAlliance: 'Alliance Trade hat keine Hub-Gebühr — 0% Kommission.',
      feeNoneAlliance: 'Alliance Trade hat keine Gebühr — 0% Kommission.',
    },
  };
  const t = (key, ...args) => {
    const entry = I18N[LANG][key];
    return typeof entry === 'function' ? entry(...args) : entry;
  };

  const WEIGHTS_KEY = 'nexusAllianceTradeWeights';

  // Storage holds ONLY the user's overrides (normalized key -> number).
  // Anything not present here falls back to DEFAULT_WEIGHTS. Cached in
  // memory and only re-read after we ourselves write a new value (menu
  // command or panel input), so annotateRow() never hits GM storage on
  // every row.
  let cachedOverrides = null;
  function loadOverrides() {
    try {
      const stored = GM_getValue(WEIGHTS_KEY, '');
      if (stored) {
        const obj = JSON.parse(stored);
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
          if (v === '' || v == null) continue;
          const n = Number(v);
          if (Number.isFinite(n)) out[norm(k)] = n;
        }
        return out;
      }
    } catch (e) { /* fall through to no overrides */ }
    return {};
  }
  function overrides() {
    if (!cachedOverrides) cachedOverrides = loadOverrides();
    return cachedOverrides;
  }
  function saveOverrides(obj) {
    // drop empty/invalid entries before persisting
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v == null || v === '') continue;
      const n = Number(v);
      if (Number.isFinite(n)) clean[norm(k)] = n;
    }
    GM_setValue(WEIGHTS_KEY, JSON.stringify(clean));
    cachedOverrides = clean;
  }
  // Updates the SAME in-memory cache used by overrides()/weights()
  // immediately (synchronously) — used by the per-resource weight fields
  // instead of saveOverrides() so that any concurrent refresh (e.g. the
  // global MutationObserver reacting to unrelated game DOM churn, which can
  // fire independently of and faster than our own debounce) always reads
  // the value the user just set, never a stale one. The actual disk write
  // is still debounced separately (persistWeightsDebounced) since that part
  // doesn't need to be synchronous.
  let persistWeightsTimer = null;
  function setOverrideNow(key, rawVal) {
    const merged = { ...overrides() };
    const val = (rawVal == null ? '' : String(rawVal)).trim();
    if (val === '') delete merged[key];
    else {
      const n = Number(val);
      if (Number.isFinite(n)) merged[key] = n;
    }
    const clean = {};
    for (const [k, v] of Object.entries(merged)) {
      if (v == null || v === '') continue;
      const n = Number(v);
      if (Number.isFinite(n)) clean[norm(k)] = n;
    }
    cachedOverrides = clean;  // visible to overrides()/weights() right away
    clearTimeout(persistWeightsTimer);
    persistWeightsTimer = setTimeout(() => {
      try { GM_setValue(WEIGHTS_KEY, JSON.stringify(clean)); } catch (e) { /* ignore */ }
    }, 250);
    return clean;
  }
  // Clears EVERY resource override at once (the Ratios "reset" button) —
  // an infrequent, deliberate action, so persist immediately rather than
  // debouncing like setOverrideNow() does for per-keystroke edits.
  function resetAllOverridesNow() {
    cachedOverrides = {};
    clearTimeout(persistWeightsTimer);
    try { GM_setValue(WEIGHTS_KEY, JSON.stringify({})); } catch (e) { /* ignore */ }
  }
  // effective weights = defaults with overrides layered on top
  function weights() {
    return { ...DEFAULT_WEIGHTS, ...overrides() };
  }

  // ---- optional auto-fill button (opt-in, default OFF) ----
  // Writes a computed ship count into the game's own quantity field for
  // manual review — never clicks Send Fleet itself. Off by default since
  // it's the most policy-sensitive feature in this script; the settings
  // gear in the calculator lets the user turn it on/off explicitly.
  const AUTOFILL_KEY = 'nexusAutoFillEnabled';
  let cachedAutoFillEnabled = null;
  function isAutoFillEnabled() {
    if (cachedAutoFillEnabled === null) {
      try { cachedAutoFillEnabled = GM_getValue(AUTOFILL_KEY, false) === true; }
      catch (e) { cachedAutoFillEnabled = false; }
    }
    return cachedAutoFillEnabled;
  }
  function setAutoFillEnabled(val) {
    cachedAutoFillEnabled = !!val;
    try { GM_setValue(AUTOFILL_KEY, !!val); } catch (e) { /* ignore */ }
  }

  // ---- market fee (Browse/Create Order only — Alliance Trade is 0%) ----
  // Regular Market fills take a hub fee off what you receive; it's
  // reducible via research so we don't hardcode a fixed number and we
  // don't guess one either. Only two real, DIRECTLY-displayed percentages
  // count as a source:
  // 1. Hub Inventory's own per-hub rate — <span class="market-hub-commission">
  //    4.5% fee</span> — the authoritative, already-post-research value.
  // 2. Per-row net line — <span class="market-order-net"> "You get: ~1,071
  //    Alloys after 3% fee" — exact percentage for that specific order.
  // Both are only present while their respective tab/form is open, so once
  // we've seen a rate we remember it (persisted across reloads too) and
  // keep using it until a fresher one shows up. If neither has EVER been
  // seen, feePercent() returns null and the UI shows an error instead of
  // silently assuming a number.
  const LAST_FEE_KEY = 'nexusLastDetectedFeePercent';
  const NET_LINE_RE = /after\s+(\d+(?:[.,]\d+)?)\s*%/i;

  let lastDetectedFeePercent = (() => {
    try {
      const stored = GM_getValue(LAST_FEE_KEY, '');
      const n = Number(stored);
      return stored !== '' && Number.isFinite(n) ? n : null;
    } catch (e) { return null; }
  })();

  // Parses a single row's own net line — used by annotateRow() for
  // per-order precision (falls back to the page-wide feePercent() when a
  // given row doesn't have one, e.g. no amount typed for it).
  function parseNetLine(row) {
    const el = row.querySelector('.market-order-net');
    if (!el) return null;
    const m = (el.textContent || '').match(NET_LINE_RE);
    if (!m) return null;
    const n = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  function detectFeePercent() {
    const hubEl = document.querySelector('.market-hub-commission');
    if (hubEl && !hubEl.closest('.alliance-trade-tab')) {
      const m = (hubEl.textContent || '').match(/(\d+(?:[.,]\d+)?)\s*%/);
      if (m) {
        const n = parseFloat(m[1].replace(',', '.'));
        if (Number.isFinite(n)) return n;
      }
    }
    const netEl = document.querySelector('.market-order-net');
    if (netEl && !netEl.closest('.alliance-trade-tab')) {
      const m = (netEl.textContent || '').match(NET_LINE_RE);
      if (m) {
        const n = parseFloat(m[1].replace(',', '.'));
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  }

  // Returns a percentage, or null when no real source has ever been seen —
  // callers must treat null as "unknown / error", never silently as 0 or
  // any other fabricated number.
  function feePercent() {
    const detected = detectFeePercent();
    if (detected != null) {
      if (detected !== lastDetectedFeePercent) {
        lastDetectedFeePercent = detected;
        try { GM_setValue(LAST_FEE_KEY, String(detected)); } catch (e) { /* ignore */ }
      }
      return detected;
    }
    return lastDetectedFeePercent;
  }

  function refreshAfterWeightChange() {
    // NOTE: deliberately NOT nulling cachedOverrides here — saveOverrides()
    // already updated it directly and correctly. Forcing a reload from
    // GM storage immediately after a write can race with a slightly-delayed
    // GM_setValue flush and read back the stale previous value, which is
    // what caused the field to visibly "snap back" right after a change.
    annotateAll();
    annotateHistory();
    annotateMyOrders();
    if (calcRecalc) calcRecalc();
    syncWeightsPanelInputs();
  }

  GM_registerMenuCommand(t('menuCommand'), () => {
    const cur = JSON.stringify(overrides(), null, 0);
    const next = prompt(t('promptText'), cur);
    if (next === null) return;
    try {
      const parsed = JSON.parse(next); // validate
      saveOverrides(parsed);
      refreshAfterWeightChange();
    } catch (e) { alert(t('invalidJson') + e.message); }
  });

  // ---- parsing (alliance-trade rows only) ----

  function parseAmount(el) {
    // Real markup: <span class="market-resource-amount" title="1.105 Alloys">
    //   <span class="market-resource-value">1.105</span><img alt="Alloys">…
    // (kept the old <strong> fallback too, in case another page variant uses it)
    if (!el) return null;
    const valueEl = el.querySelector('.market-resource-value') || el.querySelector('strong');
    const num = parseInt((valueEl?.textContent || '').replace(/[^\d]/g, ''), 10);
    const res = el.querySelector('img')?.getAttribute('alt')
      || (el.getAttribute('title') || '').replace(/[\d,.\s]/g, '');
    return Number.isFinite(num) ? { amount: num, resource: res } : null;
  }

  // "-74074" -> "-74.074" — same dot-grouping the game itself uses for
  // big numbers, applied to the millions-scaled figure below.
  function addThousands(numStr) {
    const neg = numStr.startsWith('-');
    const digits = neg ? numStr.slice(1) : numStr;
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + grouped;
  }

  const fmt = (n) => {
    const a = Math.abs(n);
    if (a >= 1e6) {
      const bigEnoughForWholeNumber = a >= 1e7;
      const str = (n / 1e6).toFixed(bigEnoughForWholeNumber ? 0 : 1);
      return (bigEnoughForWholeNumber ? addThousands(str) : str) + 'M';
    }
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
    return String(Math.round(n));
  };

  // Rounds to `sig` significant figures (e.g. 13333.33 -> 13300 at 3 sig
  // figs). Scales automatically with magnitude, which fits trades ranging
  // from ~1k up to ~1M without a hardcoded step size: 1,000 stays exact,
  // 13,333 -> 13,300, 133,333 -> 133,000, 1,000,000 stays exact.
  function roundToSigFigs(num, sig) {
    if (!(num > 0)) return 0;
    const magnitudeExp = sig - Math.ceil(Math.log10(num));
    const magnitude = Math.pow(10, magnitudeExp);
    return Math.round(num * magnitude) / magnitude;
  }

  // green→amber→red bands by value ratio (get / give)
  function colorFor(ratio) {
    if (ratio >= 1.05) return '#4ade80';
    if (ratio >= 1.0) return '#a3e635';
    if (ratio >= 0.95) return '#fbbf24';
    if (ratio >= 0.85) return '#fb923c';
    return '#f87171';
  }

  // ====================================================================
  //  Custom hover/click tooltip
  //  A single shared tooltip element, reused for every badge that needs
  //  one. Shows on hover (positioned at the cursor) like a normal tooltip,
  //  but ALSO supports click-to-pin: click once to keep it visible (auto-
  //  hides after 4s), click again to dismiss immediately. This exists
  //  alongside the native `title` attribute (kept as a fallback/
  //  accessibility aid) because native tooltips are unreliable in Firefox.
  // ====================================================================

  // one-time stylesheet: the "load into calculator" button only appears
  // while hovering its own order row — plain CSS :hover, so it works the
  // same in every browser without any JS mouseenter/mouseleave wiring.
  if (!document.getElementById('nxa-fillcalc-style')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'nxa-fillcalc-style';
    styleEl.textContent = '.nxa-fillcalc-btn{opacity:0;transition:opacity .12s}'
      + '.market-order-row:hover .nxa-fillcalc-btn,'
      + '.market-trade-row:hover .nxa-fillcalc-btn,'
      + '.market-book-level:hover .nxa-fillcalc-btn{opacity:1}'
      + '.nxa-ask-output::placeholder{color:#4ade80;opacity:1}'
      + '.nxa-ask-rounded::placeholder{color:#facc15;opacity:1}'
      // Hides the value badge the instant the fill panel opens, via plain
      // CSS matching — no wait for our debounced JS refresh cycle, which
      // is what caused the brief flash at the wrong (drifted) position
      // right after clicking Fill.
      + '.market-order-row:has(.alliance-fill-panel) .nxa-value-badge{display:none}';
    document.head.appendChild(styleEl);
  }

  let sharedTooltipEl = null;
  function getSharedTooltip() {
    if (sharedTooltipEl && sharedTooltipEl.isConnected) return sharedTooltipEl;
    sharedTooltipEl = document.createElement('div');
    sharedTooltipEl.className = 'nxa-tooltip';
    sharedTooltipEl.style.cssText = 'position:fixed;z-index:2147483000;'
      + 'background:#0b1a2b;color:#e2e8f0;border:1px solid #1e3a52;border-radius:6px;'
      + 'padding:6px 10px;font-family:inherit;font-size:12px;line-height:1.5;'
      + 'white-space:pre-line;pointer-events:none;display:none;max-width:280px;'
      + 'box-shadow:0 4px 14px rgba(0,0,0,0.45)';
    document.body.appendChild(sharedTooltipEl);
    return sharedTooltipEl;
  }

  function positionTooltip(tip, x, y) {
    const margin = 10;
    tip.style.left = '0px';
    tip.style.top = '0px';
    tip.style.display = 'block';
    const rect = tip.getBoundingClientRect();
    let left = x + 14;
    let top = y + 18;
    if (left + rect.width > window.innerWidth - margin) left = x - rect.width - 14;
    if (top + rect.height > window.innerHeight - margin) top = y - rect.height - 14;
    tip.style.left = `${Math.max(margin, left)}px`;
    tip.style.top = `${Math.max(margin, top)}px`;
  }

  // Attaches hover+click-to-pin tooltip behavior to `el`. `getText` is
  // called fresh each time the tooltip is shown, so the content always
  // reflects the badge's current values (e.g. after a weight change).
  let currentPinnedEl = null;

  function attachTooltip(el, getText) {
    let hideTimer = null;

    function show(x, y) {
      const tip = getSharedTooltip();
      tip.textContent = getText();
      positionTooltip(tip, x, y);
    }
    function hide() {
      if (sharedTooltipEl) sharedTooltipEl.style.display = 'none';
    }

    el.addEventListener('mouseenter', (e) => { if (currentPinnedEl !== el) show(e.clientX, e.clientY); });
    el.addEventListener('mousemove', (e) => {
      if (currentPinnedEl !== el && sharedTooltipEl && sharedTooltipEl.style.display === 'block') {
        positionTooltip(sharedTooltipEl, e.clientX, e.clientY);
      }
    });
    el.addEventListener('mouseleave', () => { if (currentPinnedEl !== el) hide(); });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(hideTimer);
      if (currentPinnedEl === el) {
        currentPinnedEl = null;
        hide();
      } else {
        currentPinnedEl = el;
        show(e.clientX, e.clientY);
        hideTimer = setTimeout(() => {
          if (currentPinnedEl === el) currentPinnedEl = null;
          hide();
        }, 4000);
      }
    });
  }

  // Hover-only variant (no click-to-pin) — for elements that already have
  // their own click behavior (e.g. a copy-to-clipboard button), so we
  // don't compete with that click for control of the tooltip's pin state.
  function attachHoverTooltip(el, getText) {
    el.addEventListener('mouseenter', (e) => {
      if (currentPinnedEl === el) return;
      const tip = getSharedTooltip();
      tip.textContent = getText();
      positionTooltip(tip, e.clientX, e.clientY);
    });
    el.addEventListener('mousemove', (e) => {
      if (currentPinnedEl !== el && sharedTooltipEl && sharedTooltipEl.style.display === 'block') {
        positionTooltip(sharedTooltipEl, e.clientX, e.clientY);
      }
    });
    el.addEventListener('mouseleave', () => {
      if (currentPinnedEl !== el && sharedTooltipEl) sharedTooltipEl.style.display = 'none';
    });
  }

  // hide any pinned tooltip if the user clicks anywhere else on the page —
  // checked by target identity rather than relying solely on
  // stopPropagation() having stopped the event from reaching here
  document.addEventListener('click', (e) => {
    if (e.target === currentPinnedEl) return;
    currentPinnedEl = null;
    if (sharedTooltipEl) sharedTooltipEl.style.display = 'none';
  });

  const PILL = 'padding:0 6px;border:1px solid;border-radius:6px;'
    + 'font-family:inherit;font-weight:700;font-size:inherit;line-height:1.6;'
    + 'white-space:nowrap';

  function annotateRow(row, ratioW, deltaW, btnGap) {
    // safety guard — this script only ever touches Alliance Trade rows and
    // the regular Market's Browse tab (both share the same row markup),
    // never anything else, even if annotateAll()'s own selector were
    // ever loosened.
    if (!row.closest('.alliance-trade-tab') && !row.closest('.market-browse')) return;

    const give = parseAmount(row.querySelector('.market-order-request .market-resource-amount'));
    const get = parseAmount(row.querySelector('.market-order-offer .market-resource-amount'));
    if (!give || !get) {
      row.querySelectorAll('.nxa-value-badge').forEach((b) => b.remove());
      return;
    }

    const w = weights();
    const wGive = w[norm(give.resource)];
    const wGet = w[norm(get.resource)];
    const inBrowse = !row.closest('.alliance-trade-tab');
    const rowFeePct = inBrowse ? (parseNetLine(row) ?? feePercent()) : 0;

    // Skip destroying/rebuilding the badge when nothing relevant changed
    // since last time — unrelated background refreshes (e.g. the game's
    // own live counters ticking elsewhere) were otherwise replacing this
    // element constantly, which raced with clicks and made the pinned
    // tooltip immediately lose its target.
    const signature = `${give.amount}|${give.resource}|${get.amount}|${get.resource}|`
      + `${JSON.stringify(w)}|${rowFeePct}|${inBrowse}|${LANG}`;
    if (row.dataset.nxaValueSig === signature) {
      const existing = row.querySelector('.nxa-value-badge');
      if (existing) {
        const [rp, dp] = existing.querySelectorAll('span');
        if (rp && dp && ratioW != null && deltaW != null) {
          rp.style.width = `${ratioW}px`;
          dp.style.width = `${deltaW}px`;
        }
        if (btnGap != null) existing.style.right = `${btnGap}px`;
        existing.style.display = row.querySelector('.alliance-fill-panel') ? 'none' : 'inline-flex';
      }
      return;
    }
    row.dataset.nxaValueSig = signature;

    row.querySelectorAll('.nxa-value-badge').forEach((b) => b.remove());

    // one container holds all our pills, so the observer can ignore its own
    // injections by checking a single class
    const wrap = document.createElement('span');
    wrap.className = 'nxa-value-badge';
    wrap.style.cssText = 'display:inline-flex;gap:4px;align-items:center;'
      + 'margin-left:6px;vertical-align:middle';

    if (wGive == null || wGet == null) {
      const missing = wGive == null ? give.resource : get.resource;
      wrap.appendChild(buildUnknownWeightPill(missing));
    } else {
      // Regular Market fills take a hub fee off what you receive; Alliance
      // Trade has none (0% commission), so only apply it outside that tab.
      // Prefer THIS row's own exact net line ("after N% fee") when present;
      // otherwise fall back to the page-wide detected/cached rate. If
      // neither has ever been seen, don't fabricate a number — show the
      // gross (un-deducted) value and flag it as unknown instead.
      const feeUnknown = inBrowse && rowFeePct == null;
      const feeMultiplier = (inBrowse && !feeUnknown) ? (1 - rowFeePct / 100) : 1;
      const { ratio, delta, equivGet } = computeTradeValue(give.amount, wGive, get.amount, wGet, feeMultiplier);
      const color = colorFor(ratio);
      const title = t('buyerTitle', delta, equivGet, get.resource)
        + (feeUnknown ? t('feeErrorNote') : (inBrowse ? t('feeAppliedNote', rowFeePct) : ''));

      // headline pills: ×ratio (solid) + profit/loss (outline), fixed
      // dynamically-computed width (see annotateAll) so every row's pill
      // in this list is exactly as wide as the widest actual value.
      const { ratioPill, pctPill } = buildValuePills(ratio, equivGet, color, title, ratioW, deltaW);
      wrap.append(ratioPill, pctPill);
      wrap.appendChild(buildFillCalcBtn(give, get, ';margin-left:8px'));
    }

    // Mount anchored to the row's own native "Fill" action button (fixed
    // ~10px gap before it) rather than inserting inline after the rate
    // text. Inline insertion pushed the button after it in the flow, so
    // its position drifted depending on how wide the give/get resource
    // text happened to be per row — e.g. "10.000 Plasma Core" vs.
    // "550.000 Ore" — instead of lining up. Absolute positioning takes it
    // out of flow entirely, so the preceding text is free to size
    // naturally and the badge always sits the same distance from Fill.
    // Real markup: <div class="market-order-row"><div class="market-
    // order-info">…give/get/rate, our badge…</div><div class="market-
    // order-actions"><button>…Fill</button></div></div> — for your OWN
    // orders this button says "Cancel" instead (different styling/class),
    // so anchor to WHATEVER action button is in that container rather
    // than requiring the Fill-specific class or "fill" text — otherwise
    // your own orders fell back to the less-precise inline position.
    const nativeFillBtn = row.querySelector('.market-order-actions button')
      || Array.from(row.querySelectorAll('button'))
        .find((b) => !b.classList.contains('nxa-fillcalc-btn') && /fill|cancel/i.test(b.textContent || ''));
    if (nativeFillBtn && btnGap != null) {
      if (getComputedStyle(row).position === 'static') row.style.position = 'relative';
      wrap.style.position = 'absolute';
      wrap.style.top = '50%';
      wrap.style.transform = 'translateY(-50%)';
      wrap.style.marginLeft = '0';
      wrap.style.right = `${btnGap}px`;
      // While "Fill" is clicked, the row expands to fit the fleet-send
      // panel (ship list etc.) — top:50% of that much-taller row would
      // drift the badge down into the middle of that panel instead of
      // staying next to the order info, which just looks like noise
      // floating in the wrong place. Hide it while that panel is open.
      wrap.style.display = row.querySelector('.alliance-fill-panel') ? 'none' : 'inline-flex';
      row.appendChild(wrap);
    } else {
      // fallback: mount right after the game's own rate "(1:1.81)", same
      // as before, if no native Fill button is found on this row
      const anchor = row.querySelector('.market-order-rate')
        || row.querySelector('.market-order-info');
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
      }
    }
  }

  function annotateAll() {
    const rows = document.querySelectorAll(
      '.alliance-trade-tab .market-order-row, .market-browse .market-order-row',
    );
    if (!rows.length) return;
    const groups = new Map();
    rows.forEach((row) => {
      const list = row.parentElement;
      if (!groups.has(list)) groups.set(list, []);
      groups.get(list).push(row);
    });
    const w = weights();
    groups.forEach((groupRows) => {
      let maxBtnGap = 0;
      const entries = groupRows.map((row) => {
        const nativeBtn = row.querySelector('.market-order-actions button')
          || Array.from(row.querySelectorAll('button'))
            .find((b) => !b.classList.contains('nxa-fillcalc-btn') && /fill|cancel/i.test(b.textContent || ''));
        if (nativeBtn) {
          const rowRect = row.getBoundingClientRect();
          const btnRect = nativeBtn.getBoundingClientRect();
          const gap = (rowRect.right - btnRect.left) + 10;
          if (gap > maxBtnGap) maxBtnGap = gap;
        }

        const give = parseAmount(row.querySelector('.market-order-request .market-resource-amount'));
        const get = parseAmount(row.querySelector('.market-order-offer .market-resource-amount'));
        if (!give || !get) return null;
        const wGive = w[norm(give.resource)];
        const wGet = w[norm(get.resource)];
        if (wGive == null || wGet == null) return null;
        const inBrowse = !row.closest('.alliance-trade-tab');
        const rowFeePct = inBrowse ? (parseNetLine(row) ?? feePercent()) : 0;
        const feeUnknown = inBrowse && rowFeePct == null;
        const feeMultiplier = (inBrowse && !feeUnknown) ? (1 - rowFeePct / 100) : 1;
        return computeTradeValue(give.amount, wGive, get.amount, wGet, feeMultiplier);
      });
      const { ratioW, deltaW } = measureMaxPillWidths(entries);
      const btnGap = maxBtnGap > 0 ? Math.ceil(maxBtnGap) : null;
      groupRows.forEach((row) => annotateRow(row, ratioW, deltaW, btnGap));
    });
  }

  // ====================================================================
  //  Order Book value badges (reworked Browse/Order Book page)
  //
  //  Real markup (2026 rework — see the "market-book-level" button in the
  //  Order Book tab): each price level is one <button class="market-book-
  //  level">, with exactly 4 direct <span> children in this order:
  //    1. <span class="market-book-price">1 Silicates → 2,5 Ore</span>
  //    2. <span>158.408 Silicates</span>   — what clicking this row pays
  //    3. <span>396.018 Ore</span>          — what clicking this row gives you
  //    4. <span class="market-book-level-action">…Buy now / Sell now</span>
  //  Amounts here use "." as a thousands separator and have no icons, so
  //  they need their own tiny parser (parsePlainAmount) rather than the
  //  icon-based parseAmount() the old .market-order-row markup used.
  //
  //  If this page changes shape again: the only things that matter are
  //  "does spans[1] hold the pay amount+resource as plain text" and
  //  "does spans[2] hold the receive amount+resource" — update
  //  parsePlainAmount()/the span[1]/span[2] indices below, the rest
  //  (weights, fee, colors, tooltip) is unchanged shared logic.
  // ====================================================================

  function parsePlainAmount(text) {
    const s = (text || '').trim();
    const m = s.match(/^([\d.,]+)\s+(.+)$/);
    if (!m) return null;
    const num = parseInt(m[1].replace(/[^\d]/g, ''), 10);
    const resource = m[2].trim();
    return Number.isFinite(num) ? { amount: num, resource } : null;
  }

  // Right edge of the actual RENDERED text inside `el`, via a Range over
  // its text content — NOT el.getBoundingClientRect().right, which can be
  // much wider than the visible text if the element's box stretches to
  // fill a grid/flex column (as .market-book-price does here).
  function textRight(el) {
    if (!el) return 0;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = range.getClientRects();
    if (!rects.length) return 0;
    return Math.max(...Array.from(rects, (r) => r.right));
  }

  // Left edge of the actual rendered text inside `el` — same idea as
  // textRight() but for anchoring to the START of a column (e.g. a date)
  // instead of the end of one.
  function textLeft(el) {
    if (!el) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = range.getClientRects();
    if (!rects.length) return null;
    return Math.min(...Array.from(rects, (r) => r.left));
  }

  // Renders `text` off-screen with the given pill styling to measure its
  // natural (untruncated) width — used to size a whole column of pills to
  // whichever row's value is actually the widest, instead of guessing a
  // fixed px number that can truncate ("×0.9…") once real data comes in.
  function measurePillWidth(text, extraStyle) {
    const probe = document.createElement('span');
    probe.style.cssText = `${PILL};position:absolute;visibility:hidden;left:-9999px;top:-9999px;`
      + (extraStyle || '');
    probe.textContent = text;
    document.body.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return w;
  }

  // Buyer-perspective value math shared by all three badge types (Alliance
  // Trade/Browse rows, Order Book levels, Trade History entries): you give
  // `giveAmt` of a resource weighted `wGive`, you get `getAmt` weighted
  // `wGet` (optionally reduced by a hub fee). ×1.00 = fair value.
  function computeTradeValue(giveAmt, wGive, getAmt, wGet, feeMultiplier) {
    const giveVal = giveAmt * wGive;
    const getVal = getAmt * wGet * (feeMultiplier == null ? 1 : feeMultiplier);
    const ratio = giveVal > 0 ? getVal / giveVal : 0;
    const delta = getVal - giveVal;
    const equivGet = delta / wGet;  // delta expressed as extra/less of the received resource
    return { ratio, delta, equivGet };
  }

  // Measures the widest actual ratio/delta pill text across a whole list of
  // {ratio, equivGet} entries (skipping nulls for rows with unknown weights
  // etc.), so every pill in that list can share one fixed, always-wide-
  // enough column width instead of a hardcoded guess that could truncate.
  function measureMaxPillWidths(entries) {
    let maxRatioW = 0;
    let maxDeltaW = 0;
    entries.forEach((it) => {
      if (!it) return;
      const rw = measurePillWidth(`×${it.ratio.toFixed(2)}`, 'font-size:14px');
      const dw = measurePillWidth(`${it.equivGet >= 0 ? '+' : ''}${fmt(it.equivGet)}`, 'font-size:14px');
      if (rw > maxRatioW) maxRatioW = rw;
      if (dw > maxDeltaW) maxDeltaW = dw;
    });
    return { ratioW: Math.ceil(maxRatioW) + 4, deltaW: Math.ceil(maxDeltaW) + 4 };
  }

  // Builds the ×ratio (solid) + profit/loss (outline) pill pair — same
  // look everywhere, just sized to whatever fixed width that list computed.
  function buildValuePills(ratio, equivGet, color, title, ratioW, deltaW) {
    const ratioPill = document.createElement('span');
    ratioPill.textContent = `×${ratio.toFixed(2)}`;
    ratioPill.style.cssText = PILL
      + `;font-size:14px;display:inline-block;width:${ratioW}px;text-align:center;`
      + `color:#06121f;background:${color};border-color:${color};cursor:help`;
    attachTooltip(ratioPill, () => title);

    const pctPill = document.createElement('span');
    pctPill.textContent = `${equivGet >= 0 ? '+' : ''}${fmt(equivGet)}`;
    pctPill.style.cssText = PILL
      + `;font-size:14px;display:inline-block;width:${deltaW}px;text-align:center;`
      + `color:${color};background:transparent;border-color:${color};cursor:help`;
    attachTooltip(pctPill, () => title);

    return { ratioPill, pctPill };
  }

  // Builds the 🧮 "send this trade to the calculator" button — same
  // everywhere except a small styling nuance (Alliance Trade adds a
  // margin-left since it sits after the pills there, Order Book doesn't
  // since it's prepended before them there instead).
  function buildFillCalcBtn(give, get, extraStyle) {
    const fillBtn = document.createElement('button');
    fillBtn.type = 'button';
    fillBtn.className = 'nxa-fillcalc-btn';
    fillBtn.textContent = '🧮';
    fillBtn.style.cssText = PILL
      + ';color:#38bdf8;background:transparent;border-color:#38bdf8;cursor:pointer;'
      + `padding:0 6px;line-height:1.6${extraStyle || ''}`;
    attachHoverTooltip(fillBtn, () => t('fillCalcTooltip'));
    fillBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      fillCalculatorFromTrade(norm(give.resource), give.amount, norm(get.resource));
    };
    return fillBtn;
  }

  // The "? resourceName" pill shown when one side's weight isn't set at
  // all — same across every badge type.
  function buildUnknownWeightPill(missing) {
    const pill = document.createElement('span');
    pill.textContent = `? ${missing}`;
    pill.style.cssText = PILL + ';color:#94a3b8;border-color:#475569;cursor:help';
    attachTooltip(pill, () => t('noWeightPillTitle', missing));
    return pill;
  }

  function annotateOrderBookLevel(row, sharedLeftPx, ratioW, deltaW) {
    const spans = row.querySelectorAll(':scope > span');
    const paySpan = spans[1];
    const receiveSpan = spans[2];
    if (!paySpan || !receiveSpan) return;

    // We no longer touch paySpan's own content at all (see below — the
    // badge now lives OUTSIDE it), so its text can just be read directly.
    const give = parsePlainAmount(paySpan.textContent);
    const get = parsePlainAmount(receiveSpan.textContent);
    if (!give || !get) {
      row.querySelectorAll(':scope > .nxa-value-badge').forEach((b) => b.remove());
      return;
    }

    const w = weights();
    const wGive = w[norm(give.resource)];
    const wGet = w[norm(get.resource)];
    const rowFeePct = feePercent();  // this page has no per-row net line to prefer

    const signature = `${give.amount}|${give.resource}|${get.amount}|${get.resource}|`
      + `${JSON.stringify(w)}|${rowFeePct}|${LANG}`;
    if (row.dataset.nxaValueSig === signature) {
      // Nothing about the trade itself changed, but the shared column
      // position/widths can still shift between refreshes (another row's
      // rate text or value got wider) — keep it in sync without
      // rebuilding the pills themselves.
      const existing = row.querySelector(':scope > .nxa-value-badge');
      if (existing) {
        existing.style.left = `${sharedLeftPx}px`;
        const [rp, dp] = existing.querySelectorAll('span');
        if (rp && dp) { rp.style.width = `${ratioW}px`; dp.style.width = `${deltaW}px`; }
      }
      return;
    }
    row.dataset.nxaValueSig = signature;

    row.querySelectorAll(':scope > .nxa-value-badge').forEach((b) => b.remove());

    // Positioned absolutely so it's taken completely out of the row's
    // normal flow — it doesn't add a 5th flex/grid item and doesn't
    // consume any of the pay cell's own width. The pay cell had a fixed
    // width with text-overflow:ellipsis, so anything added INSIDE it (an
    // earlier approach) ate into that budget and truncated the number —
    // moving it outside fixes that at the root. `sharedLeftPx` (computed
    // once per list by annotateOrderBook, from the widest actual rate
    // text among all visible rows) puts every row's badge at the same x,
    // forming one straight, flush-left column.
    const wrap = document.createElement('span');
    wrap.className = 'nxa-value-badge';
    wrap.style.cssText = 'position:absolute;top:50%;transform:translateY(-50%);'
      + `left:${sharedLeftPx}px;`
      + 'display:inline-flex;gap:4px;align-items:center;white-space:nowrap;z-index:1';

    if (wGive == null || wGet == null) {
      const missing = wGive == null ? give.resource : get.resource;
      wrap.appendChild(buildUnknownWeightPill(missing));
    } else {
      // Same buyer-perspective math as annotateRow(): you pay `give`,
      // you receive `get` (minus the hub fee, always present here — this
      // page is never Alliance Trade).
      const feeUnknown = rowFeePct == null;
      const feeMultiplier = feeUnknown ? 1 : (1 - rowFeePct / 100);
      const { ratio, delta, equivGet } = computeTradeValue(give.amount, wGive, get.amount, wGet, feeMultiplier);
      const color = colorFor(ratio);
      const title = t('buyerTitle', delta, equivGet, get.resource)
        + (feeUnknown ? t('feeErrorNote') : t('feeAppliedNote', rowFeePct));

      // Dynamic width (computed once per list from the widest actual
      // value — see annotateOrderBook) so every row's badge takes up
      // exactly the same horizontal space AND is always wide enough to
      // show the full number, never truncating like a hardcoded px guess
      // could once real data came in.
      const { ratioPill, pctPill } = buildValuePills(ratio, equivGet, color, title, ratioW, deltaW);

      // Row itself is a <button> ("Buy now"/"Sell now") — the shared
      // helper already stops propagation so clicking this never also
      // triggers that. Prepended before the pills so it sits on their
      // LEFT per request.
      wrap.append(buildFillCalcBtn(give, get), ratioPill, pctPill);
    }

    if (getComputedStyle(row).position === 'static') row.style.position = 'relative';
    row.appendChild(wrap);
  }

  function annotateOrderBook() {
    const rows = document.querySelectorAll('.market-book-level');
    if (!rows.length) return;
    // Group by list container (there is normally only one visible at a
    // time — Buy offers or Sell offers — but grouping keeps this correct
    // if that ever changes) so the shared anchor is only ever compared
    // against rows that actually sit in the same column.
    const groups = new Map();
    rows.forEach((row) => {
      const list = row.parentElement;
      if (!groups.has(list)) groups.set(list, []);
      groups.get(list).push(row);
    });
    const w = weights();
    const rowFeePct = feePercent();
    groups.forEach((groupRows) => {
      let maxOffset = 0;
      const entries = groupRows.map((row) => {
        const rateSpan = row.querySelector(':scope > span');
        const rowRect = row.getBoundingClientRect();
        const offset = textRight(rateSpan) - rowRect.left;
        if (offset > maxOffset) maxOffset = offset;

        // Same trade math as annotateOrderBookLevel — duplicated here
        // just to get the actual pill values so their real rendered width
        // can be measured before any pill exists yet.
        const spans = row.querySelectorAll(':scope > span');
        const give = spans[1] && parsePlainAmount(spans[1].textContent);
        const get = spans[2] && parsePlainAmount(spans[2].textContent);
        if (!give || !get) return null;
        const wGive = w[norm(give.resource)];
        const wGet = w[norm(get.resource)];
        if (wGive == null || wGet == null) return null;
        const feeMultiplier = rowFeePct == null ? 1 : (1 - rowFeePct / 100);
        return computeTradeValue(give.amount, wGive, get.amount, wGet, feeMultiplier);
      });
      const sharedLeftPx = Math.max(0, maxOffset + 6);
      const { ratioW, deltaW } = measureMaxPillWidths(entries);
      groupRows.forEach((row) => annotateOrderBookLevel(row, sharedLeftPx, ratioW, deltaW));
    });
  }

  // ====================================================================
  //  Trade History value badges
  //  Same ratio/value math as the live orders above, applied to completed
  //  (and cancelled) Trade History entries — so you can see in hindsight
  //  who came out ahead on a given trade.
  //
  //  Real markup: .market-trade-history > .market-trade-row, each row
  //  holding exactly two .market-resource-amount spans in order — give
  //  first, get second — followed by "by X → Y" text and the date.
  // ====================================================================

  function annotateHistoryRow(row, sharedRightPx, container, ratioW, deltaW) {
    const amounts = row.querySelectorAll('.market-resource-amount');
    if (amounts.length < 2) {
      (container || row).querySelectorAll(`.nxa-history-badge[data-nxa-row="${row.dataset.nxaRowId || ''}"]`)
        .forEach((b) => b.remove());
      row.querySelectorAll('.nxa-you-marker').forEach((b) => b.remove());
      return;
    }
    // Perspective fix: like the original script, we value trades from the
    // buyer's (filler's) side, not the order creator's. The row shows
    // "creator gives (left) ⇄ creator gets (right)" — so from the buyer's
    // side it's the mirror image: buyer gives the right resource and gets
    // the left one.
    const give = parseAmount(amounts[1]);
    const get = parseAmount(amounts[0]);
    if (!give || !get) {
      row.querySelectorAll('.nxa-you-marker').forEach((b) => b.remove());
      return;
    }

    const w = weights();
    const wGive = w[norm(give.resource)];
    const wGet = w[norm(get.resource)];
    if (wGive == null || wGet == null) return;  // silently skip unknown resources here

    if (!row.dataset.nxaRowId) {
      row.dataset.nxaRowId = `h${Math.random().toString(36).slice(2)}`;
    }
    const rowId = row.dataset.nxaRowId;

    // History rows never change once written — this signature check makes
    // almost every later rebuild call a no-op, so a pinned tooltip's
    // element never gets swapped out from under a click.
    const signature = `${give.amount}|${give.resource}|${get.amount}|${get.resource}|${JSON.stringify(w)}|${LANG}`;
    const existing = container
      ? container.querySelector(`.nxa-history-badge[data-nxa-row="${rowId}"]`)
      : row.querySelector('.nxa-history-badge');
    if (row.dataset.nxaHistSig === signature) {
      // Trade itself hasn't changed, but the shared date-column anchor,
      // this row's own vertical position, and the shared pill widths can
      // all still shift — keep everything synced without a full rebuild.
      if (existing && sharedRightPx != null) {
        existing.style.right = `${sharedRightPx}px`;
        if (container) {
          const containerRect = container.getBoundingClientRect();
          const rowRect = row.getBoundingClientRect();
          existing.style.top = `${(rowRect.top - containerRect.top) + rowRect.height / 2}px`;
        }
        const [rp, dp] = existing.querySelectorAll('span');
        if (rp && dp && ratioW != null && deltaW != null) {
          rp.style.width = `${ratioW}px`;
          dp.style.width = `${deltaW}px`;
        }
      }
      return;
    }
    row.dataset.nxaHistSig = signature;
    if (existing) existing.remove();
    row.querySelectorAll('.nxa-you-marker').forEach((b) => b.remove());

    const { ratio, delta, equivGet } = computeTradeValue(give.amount, wGive, get.amount, wGet);
    const color = colorFor(ratio);
    const title = t('buyerTitle', delta, equivGet, get.resource);

    const wrap = document.createElement('span');
    wrap.className = 'nxa-history-badge';
    wrap.dataset.nxaRow = rowId;
    wrap.style.cssText = 'display:inline-flex;gap:4px;align-items:center;'
      + 'margin-left:6px;vertical-align:middle';

    // Dynamic width (matching Alliance Trade/Order Book's mechanism and
    // 14px size) instead of auto-width — with auto-width, only the whole
    // badge's OUTER edge stayed flush (via the anchor below); the
    // boundary between the two pills still drifted per row depending on
    // each value's own text length, so neither pill actually lined up
    // with the one above/below it.
    const { ratioPill, pctPill } = buildValuePills(ratio, equivGet, color, title, ratioW, deltaW);
    wrap.append(ratioPill, pctPill);

    const fillBtn = buildFillCalcBtn(give, get);
    wrap.appendChild(fillBtn);

    // Anchored to the date column, mounted on the shared CONTAINER (not
    // this row) — `right` on an absolutely positioned element is relative
    // to its containing block's OWN box, and these rows are NOT all the
    // same width (they size to their own "by X → Y" text). Anchoring each
    // row's badge to that row's own box meant the same `right` value
    // still landed at a different absolute x per row. Mounting on the one
    // shared container and computing `top` from this row's offset within
    // it sidesteps that entirely — there's only one box width involved.
    const dateEl = row.querySelector('.market-trade-date');
    if (dateEl && sharedRightPx != null && container) {
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      const containerRect = container.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      wrap.style.position = 'absolute';
      wrap.style.top = `${(rowRect.top - containerRect.top) + rowRect.height / 2}px`;
      wrap.style.transform = 'translateY(-50%)';
      wrap.style.marginLeft = '0';
      wrap.style.right = `${sharedRightPx}px`;
      container.appendChild(wrap);
      fillBtn.style.opacity = '0';
      fillBtn.style.transition = 'opacity .12s';
      // Hover reveal has to work across BOTH the row and the badge now
      // that the badge is a sibling of the row (not a descendant): moving
      // the pointer from the row onto the badge visually "leaves" the row
      // element underneath (they're stacked, not nested), which fired
      // mouseleave and hid the button right as you tried to click it.
      // Checking relatedTarget on each side keeps it visible while the
      // pointer is on either one, and only hides it once it's left both.
      const showFillBtn = () => { fillBtn.style.opacity = '1'; };
      const hideFillBtnUnless = (keepIfInside) => (e) => {
        if (e.relatedTarget && keepIfInside.contains(e.relatedTarget)) return;
        fillBtn.style.opacity = '0';
      };
      wrap.addEventListener('mouseenter', showFillBtn);
      wrap.addEventListener('mouseleave', hideFillBtnUnless(row));
      if (!row.dataset.nxaHoverBound) {
        row.dataset.nxaHoverBound = '1';
        row.addEventListener('mouseenter', () => {
          const badge = container.querySelector(`.nxa-history-badge[data-nxa-row="${rowId}"]`);
          const btn = badge && badge.querySelector('.nxa-fillcalc-btn');
          if (btn) btn.style.opacity = '1';
        });
        row.addEventListener('mouseleave', (e) => {
          const badge = container.querySelector(`.nxa-history-badge[data-nxa-row="${rowId}"]`);
          if (e.relatedTarget && badge && badge.contains(e.relatedTarget)) return;
          const btn = badge && badge.querySelector('.nxa-fillcalc-btn');
          if (btn) btn.style.opacity = '0';
        });
      }
    } else {
      // fallback: mount right after the "get" amount, before the "by X →
      // Y" text, same as before, if there's no date element to anchor to
      const getWrapper = amounts[1].parentNode;
      getWrapper.parentNode.insertBefore(wrap, getWrapper.nextSibling);
    }

    // "you were involved" marker: the "by Seller → Buyer" text is the one
    // direct-child span of the row that starts with "by " and has no class
    // of its own (unlike the direction pill and the date, which do). If it
    // ends in "by you", you were the buyer (filler); if it starts with
    // "by you", you were the seller (the order's original creator).
    const partySpan = Array.from(row.children)
      .find((el) => el.tagName === 'SPAN' && !el.className && /^by\s/i.test(el.textContent || ''));
    if (partySpan) {
      const partyText = partySpan.textContent || '';
      const wasBuyer = /by you\s*$/i.test(partyText);
      const wasSeller = !wasBuyer && /^by you\b/i.test(partyText);
      if (wasBuyer || wasSeller) {
        const marker = document.createElement('span');
        marker.className = 'nxa-you-marker';
        marker.textContent = ' 🙋';
        marker.style.cssText = `${FONT};color:#4ade80;cursor:help`;
        attachTooltip(marker, () => t(wasBuyer ? 'youWereBuyer' : 'youWereSeller'));
        partySpan.appendChild(marker);
      }
    }
  }

  function annotateHistory() {
    const container = document.querySelector('.market-trade-history');
    if (!container) return;
    const rows = Array.from(container.querySelectorAll('.market-trade-row'));
    if (!rows.length) return;
    // Shared anchor: the LEFTMOST absolute page x any row's date text
    // starts at (i.e. the one produced by the widest/longest date
    // string) — using that page-x guarantees the badge never overlaps
    // any date, no matter which row has the longest one. Positioning is
    // relative to the one shared `container` (see annotateHistoryRow),
    // not each row's own box, since rows here aren't all the same width
    // (they size to their own "by X → Y" text) — anchoring per-row still
    // landed at inconsistent x despite a shared target value.
    let minDateLeftAbs = null;
    rows.forEach((row) => {
      const dateEl = row.querySelector('.market-trade-date');
      const dl = dateEl ? textLeft(dateEl) : null;
      if (dl != null && (minDateLeftAbs == null || dl < minDateLeftAbs)) {
        minDateLeftAbs = dl;
      }
    });
    let sharedRightPx = null;
    if (minDateLeftAbs != null) {
      const containerRect = container.getBoundingClientRect();
      sharedRightPx = Math.max(0, (containerRect.right - minDateLeftAbs) + 8);
    }

    // Same dynamic-width mechanism as Alliance Trade/Order Book: measure
    // every row's actual pill text and use the widest one for the whole
    // list, so the pill columns are flush too, not just the badge's
    // outer edge against the date.
    const w = weights();
    const entries = rows.map((row) => {
      const amounts = row.querySelectorAll('.market-resource-amount');
      if (amounts.length < 2) return null;
      const give = parseAmount(amounts[1]);
      const get = parseAmount(amounts[0]);
      if (!give || !get) return null;
      const wGive = w[norm(give.resource)];
      const wGet = w[norm(get.resource)];
      if (wGive == null || wGet == null) return null;
      return computeTradeValue(give.amount, wGive, get.amount, wGet);
    });
    const { ratioW, deltaW } = measureMaxPillWidths(entries);

    rows.forEach((row) => annotateHistoryRow(row, sharedRightPx, container, ratioW, deltaW));
  }

  // ====================================================================
  //  My Orders value badges
  //  Your own posted orders on the regular Market's "My Orders" tab. Unlike
  //  the live-order/history badges above (valued from the buyer/filler's
  //  side), here YOU are the creator, so the perspective flips: the first
  //  amount is what you're asking for (shown as "filled/total", we use the
  //  total), the second is what you offer in exchange for it.
  //
  //  Real markup: .market-my-orders > .market-my-order-row, each holding
  //  exactly two .market-resource-amount spans in order — ask first, offer
  //  second — with no offer/request wrapper class (unlike live orders).
  // ====================================================================

  function parseAmountTotal(el) {
    // Same as parseAmount, but also handles the "filled/total" progress
    // format (e.g. "100/100 Bio Extract") by taking the total (last number).
    if (!el) return null;
    const valueEl = el.querySelector('.market-resource-value') || el.querySelector('strong');
    const raw = (valueEl?.textContent || '').trim();
    const totalStr = raw.includes('/') ? raw.split('/').pop() : raw;
    const num = parseInt((totalStr || '').replace(/[^\d]/g, ''), 10);
    const res = el.querySelector('img')?.getAttribute('alt')
      || (el.getAttribute('title') || '').replace(/[\d,.\/\s]/g, '');
    return Number.isFinite(num) ? { amount: num, resource: res } : null;
  }

  function annotateMyOrdersRow(row) {
    const amounts = row.querySelectorAll('.market-resource-amount');
    if (amounts.length < 2) {
      row.querySelectorAll('.nxa-myorder-badge').forEach((b) => b.remove());
      return;
    }
    const get = parseAmountTotal(amounts[0]);   // what you (creator) are asking for
    const give = parseAmountTotal(amounts[1]);  // what you (creator) offer in exchange
    if (!get || !give) {
      row.querySelectorAll('.nxa-myorder-badge').forEach((b) => b.remove());
      return;
    }

    const w = weights();
    const wGive = w[norm(give.resource)];
    const wGet = w[norm(get.resource)];
    if (wGive == null || wGet == null) return;  // silently skip unknown resources here

    // Uses the TOTAL amounts (not the filled/progress part), which stay
    // constant for the life of the order — so this signature check makes
    // later rebuild calls a no-op even as the order's fill progress ticks
    // up, protecting a pinned tooltip's element from being swapped out.
    const signature = `${give.amount}|${give.resource}|${get.amount}|${get.resource}|${JSON.stringify(w)}|${LANG}`;
    if (row.dataset.nxaMyOrderSig === signature) return;
    row.dataset.nxaMyOrderSig = signature;
    row.querySelectorAll('.nxa-myorder-badge').forEach((b) => b.remove());

    const { ratio, delta, equivGet } = computeTradeValue(give.amount, wGive, get.amount, wGet);
    const color = colorFor(ratio);
    const title = t('sellerTitle', delta, equivGet, get.resource);

    const wrap = document.createElement('span');
    wrap.className = 'nxa-myorder-badge';
    wrap.style.cssText = 'display:inline-flex;gap:4px;align-items:center;'
      + 'margin-left:6px;vertical-align:middle';

    const ratioPill = document.createElement('span');
    ratioPill.textContent = `×${ratio.toFixed(2)}`;
    ratioPill.style.cssText = PILL
      + `;color:#06121f;background:${color};border-color:${color};cursor:help`;
    attachTooltip(ratioPill, () => title);

    const pctPill = document.createElement('span');
      pctPill.textContent = `${equivGet >= 0 ? '+' : ''}${fmt(equivGet)}`;
    pctPill.style.cssText = PILL
      + `;color:${color};background:transparent;border-color:${color};cursor:help`;
    attachTooltip(pctPill, () => title);

    wrap.append(ratioPill, pctPill);

    // mount right after the offered (second) amount
    const offerWrapper = amounts[1].parentNode;
    offerWrapper.parentNode.insertBefore(wrap, offerWrapper.nextSibling);
  }

  function annotateMyOrders() {
    document.querySelectorAll('.market-my-orders .market-my-order-row').forEach((row) => {
      annotateMyOrdersRow(row);
    });
  }

  // ====================================================================
  //  Fair Trade Calculator
  //  A small panel next to "+ New Order": pick a Give resource and a Get
  //  resource, type how much you want to give, and it computes the exact
  //  amount to ask for so the trade is precisely ×1.00 under your weights.
  //  Pure client-side arithmetic — no network, no game API involved.
  // ====================================================================

  const RESOURCES = [
    'ore', 'silicates', 'hydrogen', 'alloys', 'bioextract',
    'cryoice', 'plasmacore', 'quantumdust', 'darkmatter', 'antimatter',
  ].map((key) => ({ key, label: RESOURCE_LABELS[LANG][key] }));
  const resLabel = (k) => (RESOURCES.find((r) => r.key === k) || {}).label || k;
  // updates RESOURCES' .label fields in place after a language switch —
  // the array/objects are mutated (not replaced), so anything holding a
  // reference to an entry sees the new label immediately
  function refreshResourceLabels() {
    for (const r of RESOURCES) r.label = RESOURCE_LABELS[LANG][r.key];
  }

  // Reuse the game's own resource icons wherever they already appear on the
  // page (e.g. the balance bar, order rows) instead of shipping our own
  // assets. Cached per key since the DOM doesn't change which icon belongs
  // to which resource.
  const iconSrcCache = {};
  function resourceIconSrc(key) {
    if (key in iconSrcCache) return iconSrcCache[key];
    let src = null;
    document.querySelectorAll('img[alt]').forEach((img) => {
      if (src) return;
      if (norm(img.getAttribute('alt')) === key) src = img.currentSrc || img.src;
    });
    iconSrcCache[key] = src;
    return src;
  }
  // small colored dot fallback if no matching icon is found on the page yet
  const FALLBACK_COLOR = {
    ore: '#f59e0b', silicates: '#a78bfa', hydrogen: '#38bdf8', alloys: '#94a3b8',
    bioextract: '#4ade80', cryoice: '#67e8f9', plasmacore: '#f472b6',
    quantumdust: '#c084fc', darkmatter: '#818cf8', antimatter: '#f43f5e',
  };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === 'style') el.style.cssText = v;
      else if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const FONT = 'font-family:inherit;font-weight:700;font-size:15px;line-height:1.5';
  const FONT_NUM = 'font-family:inherit;font-weight:700;font-size:15px;line-height:1.5';
  const FIELD = `${FONT};background:#0b1a2b;color:#cbd5e1;border:1px solid #1e3a52;`
    + 'border-radius:5px;padding:2px 6px';
  const FIELD_NUM = `${FONT_NUM};background:#0b1a2b;color:#cbd5e1;border:1px solid #1e3a52;`
    + 'border-radius:5px;padding:2px 6px';

  function resSelect(value, onchange) {
    const sel = h('select', { style: `${FIELD};min-width:118px;padding:4px 8px`, onchange });
    for (const r of RESOURCES) {
      const opt = h('option', { value: r.key }, r.label);
      if (r.key === value) opt.selected = true;
      sel.append(opt);
    }
    return sel;
  }

  // set by buildCalcPanel() while it's mounted, so a weight change from the
  // menu command / weights panel can refresh the displayed output immediately
  let calcRecalc = null;
  // small API exposed by buildCalcPanel() so the order-form sync below can
  // drive the calculator's OWN fields (never the game's own form fields)
  let calcApi = null;
  // remembers the last trade loaded via a "load into calculator" button, so
  // a freshly (re)mounted panel (e.g. after switching tabs) starts with it
  // instead of resetting to the hardcoded Ore/Silicates default
  let lastFillGiveKey = null;
  let lastFillGiveAmount = null;
  let lastFillGetKey = null;

  function fillCalculatorFromTrade(giveResKey, giveAmt, getResKey) {
    lastFillGiveKey = giveResKey;
    lastFillGiveAmount = giveAmt;
    lastFillGetKey = getResKey;
    if (calcApi) {
      calcApi.fillFromTrade(giveResKey, giveAmt, getResKey);
      const panelEl = document.querySelector('.nxa-calc-panel');
      if (panelEl) {
        panelEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        panelEl.style.boxShadow = '0 0 0 2px #38bdf8';
        setTimeout(() => { panelEl.style.boxShadow = ''; }, 1200);
      }
    }
  }

  function buildCalcPanel(isAlliance) {
    let giveKey = lastFillGiveKey || 'ore';
    let getKey = lastFillGetKey || 'silicates';

    const giveAmount = h('input', { type: 'text', inputmode: 'decimal',
      placeholder: t('amountToGive'),
      value: lastFillGiveAmount != null ? String(lastFillGiveAmount) : '',
      style: `${FONT_NUM};background:transparent;border:none;outline:none;`
        + 'width:100%;padding:0;color:#f1f5f9' });
    const giveStepBtn = (dir, label) => h('button', { type: 'button', tabIndex: '-1',
      onclick: () => {
        const cur = Number(giveAmount.value);
        const base = Number.isFinite(cur) ? cur : 0;
        giveAmount.value = String(Math.max(0, Math.round((base + dir) * 100) / 100));
        recalc();
      }, style: `${FONT};color:#94a3b8;background:transparent;border:none;cursor:pointer;`
        + 'padding:0;width:14px;height:14px;line-height:1;font-size:11px;display:flex;'
        + 'align-items:center;justify-content:center' }, label);
    const giveSteppers = h('span', { style: 'display:flex;flex-direction:column;gap:1px' },
      giveStepBtn(1, '▲'), giveStepBtn(-1, '▼'));
    const giveAmountWrap = h('span', { style: `${FIELD_NUM};display:flex;align-items:center;`
      + 'justify-content:space-between;gap:4px;padding:2px 4px 2px 6px;width:130px' },
      giveAmount, giveSteppers);
    const getOutput = h('input', { type: 'text', readonly: 'true', class: 'nxa-ask-output',
      placeholder: t('amountToGet'), style: `${FIELD_NUM};width:130px;color:#4ade80` });

    // Second column: a read-only "clean" version of the ask amount, rounded
    // to 3 significant figures (13333 -> 13300) purely so you have a
    // round, easy-to-read number on hand if you'd rather use that instead
    // of the exact one in getOutput. It never overwrites getOutput.
    const getOutputClean = h('input', { type: 'text', readonly: 'true', class: 'nxa-ask-rounded',
      placeholder: t('roundedAmount'), style: `${FIELD_NUM};width:130px;color:#facc15` });

    // ±delta badge for the rounded number, same look as the value pill on
    // real order rows. The tooltip carries the precise fair amount and the
    // exact profit/loss this rounding implies.
    let askBadgeTooltipText = '';
    const askDeltaPill = h('span', {
      style: `${PILL};cursor:help;display:none;background:transparent`,
    });
    attachTooltip(askDeltaPill, () => askBadgeTooltipText);
    function clearAskBadge() {
      askDeltaPill.style.display = 'none';
    }

    const rateNote = h('div', { style: 'display:flex;flex-direction:column;gap:2px' },
      h('span', { style: `${FONT};color:#64748b;line-height:1.2` }, ''),
      h('span', { style: `${FONT};color:#38bdf8;line-height:1.2` }, ''));
    const [rateNoFeeEl, rateWithFeeEl] = rateNote.children;
    const warnNote = h('div', { style: 'display:flex;align-items:flex-start;gap:6px' },
      h('span', { style: `${FONT};color:#38bdf8;font-weight:900` }, '!'),
      h('span', { style: `${FONT};color:#64748b` }, t('justCalculating')));
    const feeUpdateHint = h('div', { style:
      'display:flex;align-items:flex-start;gap:6px' },
      h('span', { style: `${FONT};color:#38bdf8;font-weight:900` }, '!'),
      h('span', { style: `${FONT};color:#64748b` }, t('feeUpdateHint')));

    function recalc() {
      const w = weights();
      const wGive = w[norm(giveKey)];
      const wGet = w[norm(getKey)];

      if (giveKey === getKey) {
        getOutput.value = '';
        getOutputClean.value = '';
        rateNoFeeEl.textContent = t('pickDifferent');
        rateWithFeeEl.textContent = '';
        clearAskBadge();
        return;
      }
      if (wGive == null || wGet == null) {
        getOutput.value = '';
        getOutputClean.value = '';
        rateNoFeeEl.textContent = t('noWeightRate');
        rateWithFeeEl.textContent = '';
        clearAskBadge();
        return;
      }

      const fairNoFee = wGive / wGet;  // units of `get` per unit of `give`, ignoring any fee
      rateNoFeeEl.textContent = t('fairRate', resLabel(giveKey), fairNoFee.toFixed(3), resLabel(getKey));

      // Regular Market fills take a hub fee off what you receive; Alliance
      // Trade has none. To still net a fair (×1.00) trade after the fee,
      // you need to ask for more of the received resource to compensate —
      // shown as its own line so the two numbers aren't easy to conflate.
      let fair = fairNoFee;
      if (isAlliance) {
        rateWithFeeEl.textContent = t('feeNoneAlliance');
        rateWithFeeEl.style.color = '#4ade80';
      } else {
        const pct = feePercent();
        if (pct == null) {
          fair = fairNoFee;
          rateWithFeeEl.textContent = t('feeErrorLine');
          rateWithFeeEl.style.color = '#f87171';
        } else {
          fair = fairNoFee / (1 - pct / 100);
          rateWithFeeEl.textContent = t('feeAdjustedRate', fair.toFixed(3), pct);
          rateWithFeeEl.style.color = '#38bdf8';
        }
      }

      const amt = Number(giveAmount.value);
      if (!(amt > 0)) {
        getOutput.value = '';
        getOutputClean.value = '';
        getOutput.title = '';
        clearAskBadge();
        return;
      }
      const exact = amt * fair;  // precise ask amount for an exactly ×1.00 trade
      // strip trailing zeros (e.g. "0.500" -> "0.5", "22" stays "22") without
      // rounding — the point is the exact value, not a rounded-off one that
      // silently becomes "0" for small amounts.
      getOutput.value = String(Math.round(exact));
      getOutput.title = '';

      // Clean, readable version (3 significant figures — scales with trade
      // size across the ~1k-1M range) shown in the second column. Purely
      // informational — never overwrites getOutput.
      const askClean = Math.round(roundToSigFigs(exact, 3));
      getOutputClean.value = askClean > 0 ? String(askClean) : '';

      if (askClean > 0) {
        // Deviation caused purely by ROUNDING exact -> askClean. `exact`
        // already includes the fee compensation (if any), so comparing
        // askClean against it isolates just the rounding effect instead
        // of also picking up the fee markup as a fake "profit".
        const equivGet = askClean - exact;  // resource units
        const delta = equivGet * wGet;      // value units
        const ratio = exact > 0 ? askClean / exact : 0;
        const color = colorFor(ratio);

        askDeltaPill.textContent = `${equivGet >= 0 ? '+' : ''}${fmt(equivGet)}`;
        askDeltaPill.style.color = color;
        askDeltaPill.style.borderColor = color;
        askDeltaPill.style.display = 'inline-flex';

        askBadgeTooltipText = t('askRoundedTooltip', exact, askClean, resLabel(getKey), delta, equivGet);
      } else {
        clearAskBadge();
      }
    }

    const giveSel = resSelect(giveKey, () => { giveKey = giveSel.value; recalc(); });
    const getSel = resSelect(getKey, () => { getKey = getSel.value; recalc(); });
    giveAmount.oninput = recalc;

    calcRecalc = recalc;
    // Exposes calculator state to the outside world (the "load into
    // calculator" 🧮 buttons write into it via fillFromTrade(), the "Fill
    // Order Form" button reads it via getState()) — this calculator is
    // otherwise fully independent, never overwritten by the game's own
    // Create Order form.
    calcApi = {
      // Force-loads a specific trade's give/get resources + amount,
      // regardless of current state — used by the "load into calculator"
      // buttons on order rows.
      fillFromTrade(newGiveKey, giveAmt, newGetKey) {
        if (RESOURCES.some((r) => r.key === newGiveKey)) { giveKey = newGiveKey; giveSel.value = newGiveKey; }
        if (RESOURCES.some((r) => r.key === newGetKey)) { getKey = newGetKey; getSel.value = newGetKey; }
        if (giveAmt != null) giveAmount.value = String(giveAmt);
        recalc();
      },
      // Reads the calculator's current state — used by the "Fill Order
      // Form" button to push these values into the game's own Create
      // Order form.
      getState() {
        return {
          giveKey, getKey,
          giveAmount: giveAmount.value,
          askAmount: getOutput.value,
          askAmountClean: getOutputClean.value,
        };
      },
    };
    recalc();

    const settingsPanel = h('div', { style: 'display:none;flex-direction:column;gap:6px;'
      + 'margin-top:8px;padding:8px 10px;background:#0f1b2e;border:1px solid #1e3a52;'
      + 'border-radius:8px' });
    const autoFillCheckbox = h('input', { type: 'checkbox' });
    autoFillCheckbox.checked = isAutoFillEnabled();
    autoFillCheckbox.onchange = () => {
      setAutoFillEnabled(autoFillCheckbox.checked);
      annotateFleetCargo();
      mountOrderFormFillButton();
    };

    const langBtn = (code, label) => {
      const btn = h('button', { type: 'button', onclick: () => {
        if (LANG === code) return;
        setStoredLang(code);
        LANG = code;
        refreshResourceLabels();
        document.querySelectorAll('.nxa-calc-panel').forEach((p) => p.remove());
        refreshAll();
      }, style: `${FONT};font-size:12px;padding:3px 10px;border-radius:6px;cursor:pointer;`
        + `border:1px solid ${LANG === code ? '#38bdf8' : '#1e3a52'};`
        + `background:${LANG === code ? '#0f2437' : 'transparent'};`
        + `color:${LANG === code ? '#38bdf8' : '#94a3b8'}` }, label);
      return btn;
    };
    const langRow = h('div', { style: 'display:flex;align-items:center;gap:8px' },
      h('span', { style: `${FONT};color:#94a3b8;font-size:12px` }, t('languageLabel')),
      langBtn('en', 'English'), langBtn('de', 'Deutsch'));

    settingsPanel.append(
      h('label', { style: `${FONT};display:flex;align-items:center;gap:8px;cursor:pointer` },
        autoFillCheckbox, t('autoFillToggleLabel')),
      h('div', { style: 'display:flex;align-items:flex-start;gap:6px' },
        h('span', { style: `${FONT};color:#38bdf8;font-weight:900` }, '!'),
        h('span', { style: `${FONT};color:#64748b;font-size:12px` }, t('autoFillWarning'))),
      h('div', { style: 'margin-top:2px;padding-top:6px;border-top:1px solid #1e3a52' }, langRow),
    );

    const settingsBtn = h('button', { type: 'button', onclick: () => {
      settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'flex' : 'none';
    }, onmouseenter: (e) => { e.target.style.color = '#e2e8f0'; },
    onmouseleave: (e) => { e.target.style.color = '#94a3b8'; },
    style: `${FONT};color:#94a3b8;background:transparent;border:none;cursor:pointer;`
      + 'padding:0;font-size:15px;line-height:1' }, '⚙');
    attachHoverTooltip(settingsBtn, () => t('settingsTooltip'));

    // Places `el` into a specific cell of its own small grid, without
    // touching its existing width/color/etc. styling.
    const g = (el, row, col) => { el.style.gridRow = String(row); el.style.gridColumn = String(col); return el; };

    const swapBtn = h('button', { type: 'button', onclick: (e) => {
      const tmpKey = giveKey; giveKey = getKey; getKey = tmpKey;
      giveSel.value = giveKey; getSel.value = getKey;
      if (getOutput.value !== '') giveAmount.value = getOutput.value;
      recalc();
    }, onmouseenter: (e) => { e.target.style.background = '#16324a'; },
    onmouseleave: (e) => { e.target.style.background = '#0f2437'; },
    style: `${FONT};color:#38bdf8;font-weight:800;background:#0f2437;`
      + 'border:1px solid #1e3a52;border-radius:6px;cursor:pointer;'
      + 'padding:2px 8px;line-height:1' }, '⇄');
    attachTooltip(swapBtn, () => t('swapTooltip'));

    // "Give" section is its own single-line flex row (centered against
    // ONLY its own height) — kept separate from the ask section below so
    // it never gets stretched/offset by the taller 2-row ask block.
    const giveRow = h('div', { style: 'display:flex;gap:6px;align-items:center' },
      h('span', { style: `${FONT};color:#94a3b8` }, t('give')),
      giveAmountWrap, giveSel, swapBtn);

    // Ask section is its own 2-row × 3-col mini-grid (label / amount /
    // resource), sized only to its own content — NOT sharing column
    // tracks with giveRow, so row 2 ("or rounded") doesn't inherit a
    // huge empty gap from Give's wide amount/resource columns.
    const askGrid = h('div', { style: 'display:grid;grid-template-columns:auto auto auto;'
      + 'column-gap:6px;row-gap:2px;align-items:center' },
      g(h('span', { style: `${FONT};color:#94a3b8` }, t('askExactly')), 1, 1),
      g(getOutput, 1, 2), g(getSel, 1, 3),
      g(h('span', { style: `${FONT};color:#94a3b8` }, t('orRounded')), 2, 1),
      g(getOutputClean, 2, 2), g(askDeltaPill, 2, 3));

    const leftCol = h('div', { style: 'flex:1;min-width:260px' },
      h('div', { style: 'display:flex;align-items:center;gap:8px' },
        h('div', { style: `${FONT};color:#e2e8f0` }, t('calcTitle')),
        settingsBtn),
      settingsPanel,
      h('div', { style: 'display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:6px' },
        giveRow, askGrid),
      h('div', { style: 'margin-top:0;display:flex;flex-direction:column;gap:2px' },
        rateNoFeeEl, rateWithFeeEl),
      h('div', { style: 'margin-top:10px;padding-top:6px;border-top:1px solid #1e3a52;'
        + 'display:flex;flex-direction:column;gap:5px' },
        warnNote, feeUpdateHint));

    return h('div', { class: 'nxa-calc-panel', style:
      'margin:8px 0;padding:12px 14px;background:#06121f;border:1px solid #1e3a52;'
      + 'border-radius:10px;display:flex;justify-content:space-between;'
      + 'align-items:flex-start;gap:16px;flex-wrap:wrap' },
      leftCol, buildWeightsGrid(isAlliance));
  }

  // ====================================================================
  //  Resource Weights panel
  //  One small number field per resource. The placeholder shows the
  //  built-in default (greyed out, standard browser placeholder styling)
  //  so you always see what's currently in effect even before typing
  //  anything. Typing a number stores it as your override; clearing the
  //  field removes the override and reverts to the default. A tooltip on
  //  each field explains this on hover.
  // ====================================================================

  let weightInputsByKey = {};

  function buildWeightPill(r) {
    const ov = overrides();
    const def = DEFAULT_WEIGHTS[r.key];
    const cur = ov[r.key];

    const iconSrc = resourceIconSrc(r.key);
    const icon = iconSrc
      ? h('img', { src: iconSrc, alt: r.label,
        style: 'width:16px;height:16px;object-fit:contain;flex:none;border-radius:50%;'
          + 'cursor:help' })
      : h('span', { style: 'width:12px;height:12px;border-radius:50%;flex:none;cursor:help;'
        + `background:${FALLBACK_COLOR[r.key] || '#64748b'}` });

    const input = h('input', {
      type: 'text',
      inputmode: 'decimal',
      placeholder: String(def),
      value: String(cur != null ? cur : def),
      style: `${FONT};background:transparent;border:none;outline:none;width:34px;`
        + `padding:0;color:${cur != null ? '#f1f5f9' : '#64748b'};font-weight:800;`
        + 'font-size:14px;line-height:1.2',
    });

    function updateColor() {
      const isOverride = r.key in overrides();
      input.style.color = isOverride ? '#f1f5f9' : '#64748b';
    }

    function commit() {
      setOverrideNow(r.key, input.value);
      updateColor();
      refreshAfterWeightChange();
    }
    input.oninput = commit;

    function step(dir) {
      const cur2 = Number(input.value);
      const base = Number.isFinite(cur2) ? cur2 : def;
      const next = Math.max(0, Math.round((base + dir * 0.1) * 10) / 10);
      input.value = String(next);
      commit();
    }
    const stepBtn = (dir, label) => h('button', { type: 'button', tabIndex: '-1',
      onclick: () => step(dir), style: `${FONT};color:#94a3b8;background:transparent;`
        + 'border:none;cursor:pointer;padding:0;width:14px;height:14px;line-height:1;'
        + 'font-size:11px;display:flex;align-items:center;justify-content:center' }, label);
    const steppers = h('span', { style: 'display:flex;flex-direction:column;gap:1px' },
      stepBtn(1, '▲'), stepBtn(-1, '▼'));

    weightInputsByKey[r.key] = input;
    attachTooltip(icon, () => t('weightPillTitle', r.label, def));
    attachHoverTooltip(input, () => t('weightPillTitle', r.label, def));

    return h('span', {
      style: 'display:flex;align-items:center;justify-content:center;gap:4px;'
        + 'background:#0f1b2e;border:1px solid #1e3a52;border-radius:999px;'
        + 'padding:2px 8px;box-sizing:border-box',
    }, icon, input, steppers);
  }

  let feeDisplayEl = null;

  function feeDisplayText(pct) {
    return pct == null ? t('feeError') : `${pct}%`;
  }

  let feeIsAlliance = false;

  function buildFeeControl(isAlliance) {
    feeIsAlliance = isAlliance;
    const pct = isAlliance ? 0 : feePercent();
    feeDisplayEl = h('span', {
      style: `${FONT};font-weight:800;font-size:13px;color:${pct == null ? '#f87171' : '#f1f5f9'}`,
    }, feeDisplayText(pct));
    const feeWrap = h('span', {
      style: 'display:flex;align-items:center;gap:4px;background:#0f1b2e;cursor:help;'
        + 'border:1px solid #1e3a52;border-radius:999px;padding:3px 10px',
    },
      h('span', { style: `${FONT};color:#94a3b8;font-size:12px` }, t('feeLabel')),
      feeDisplayEl);
    attachTooltip(feeWrap, () => (feeIsAlliance ? t('feeToolTipAlliance') : t('feeTooltip')));
    return feeWrap;
  }

  function buildWeightsGrid(isAlliance) {
    weightInputsByKey = {};
    const ratiosLabel = h('span', { style: 'display:flex;align-items:center;gap:6px;cursor:help' },
      h('span', { style: 'font-size:16px;color:#38bdf8' }, '⚖'),
      h('span', { style: `${FONT};color:#e2e8f0` }, t('ratios')));
    attachTooltip(ratiosLabel, () => t('ratiosTooltip'));

    const resetBtn = h('button', { type: 'button', onclick: () => {
      resetAllOverridesNow();
      refreshAfterWeightChange();
    }, onmouseenter: (e) => { e.target.style.background = '#16324a'; },
    onmouseleave: (e) => { e.target.style.background = '#0f1b2e'; },
    style: `${FONT};color:#94a3b8;background:#0f1b2e;border:1px solid #1e3a52;`
      + 'border-radius:999px;cursor:pointer;padding:5px 16px;font-size:13px;width:100%' },
      t('resetRatios'));
    attachTooltip(resetBtn, () => t('resetRatiosTooltip'));

    return h('div', { style: 'flex:none;width:290px' },
      h('div', { style: 'display:flex;align-items:flex-start;justify-content:center;gap:6px;'
        + 'flex-wrap:wrap' },
        ratiosLabel,
        buildFeeControl(isAlliance)),
      h('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:6px' },
        ...RESOURCES.map((r) => buildWeightPill(r)),
        h('div', { style: 'grid-column:span 2;display:flex;align-items:center;'
          + 'justify-content:center' }, resetBtn)));
  }

  // Keep the panel's own inputs in sync when weights/fee change from
  // elsewhere (the menu commands), without rebuilding the whole panel.
  function syncWeightsPanelInputs() {
    const ov = overrides();
    for (const r of RESOURCES) {
      const input = weightInputsByKey[r.key];
      if (!input || document.activeElement === input) continue; // don't fight the user mid-typing
      const cur = ov[r.key];
      input.value = String(cur != null ? cur : DEFAULT_WEIGHTS[r.key]);
      input.style.color = cur != null ? '#f1f5f9' : '#64748b';
    }
    if (feeDisplayEl) {
      const pct = feeIsAlliance ? 0 : feePercent();
      feeDisplayEl.textContent = feeDisplayText(pct);
      feeDisplayEl.style.color = pct == null ? '#f87171' : '#f1f5f9';
    }
  }

  function mountCalculator() {
    // The calculator belongs in four places: the Alliance Trade "New
    // Order" form, the regular Market's Browse tab, the Create Order form,
    // and Hub Inventory. Everywhere else (My Orders, History, Artifacts,
    // Cosmetics, Trader, …) it must NOT be shown — so we actively remove
    // any leftover panel whenever none of those anchors are found on the
    // current page, rather than only replacing it when rebuilding.
    const tradeTab = document.querySelector('.alliance-trade-tab');
    const orderBtn = tradeTab && Array.from(tradeTab.querySelectorAll('button'))
      .find((b) => /^\+?\s*(new order|cancel)$/i.test((b.textContent || '').trim()));

    const browseTab = document.querySelector('.market-browse');
    const filterRow = browseTab && browseTab.querySelector('.market-filter-row');

    // Reworked Order Book page (2026) — .market-browse/.market-filter-row
    // no longer exist there at all, so it needs its own anchor. Mounted
    // right above .market-order-book, i.e. just under the tabs bar and
    // above the Buy/Sell + resource pickers, so it stays put across
    // switching Buy/Sell or resources (only .market-order-book's OWN
    // insides change, this element itself persists).
    const orderBookPage = document.querySelector('.market-order-book');

    const createForm = document.querySelector('form.market-create-form');
    const createFormOutsideAlliance = createForm && !createForm.closest('.alliance-trade-tab')
      ? createForm : null;

    // Hub Inventory: find the shared ancestor of every hub's fee element
    // and mount just above it (the whole hub card list), rather than
    // guessing a specific class for the tab wrapper.
    const hubFeeEls = Array.from(document.querySelectorAll('.market-hub-commission'))
      .filter((el) => !el.closest('.alliance-trade-tab'));
    let hubListContainer = null;
    if (hubFeeEls.length) {
      let el = hubFeeEls[0];
      while (el && el.parentElement) {
        if (el.parentElement.querySelectorAll('.market-hub-commission').length >= hubFeeEls.length) {
          hubListContainer = el.parentElement;
          break;
        }
        el = el.parentElement;
      }
    }

    // Decide the ONE correct context for right now — each is tagged so we
    // can tell a stale panel from a different context apart from a fresh,
    // correctly-built one instead of just checking "does a panel exist".
    let anchor = null;
    let isAlliance = false;
    let contextTag = null;
    if (orderBtn) { anchor = orderBtn; isAlliance = true; contextTag = 'alliance'; }
    else if (filterRow) { anchor = filterRow; contextTag = 'browse'; }
    else if (orderBookPage) { anchor = orderBookPage; contextTag = 'orderbook'; }
    else if (createFormOutsideAlliance) { anchor = createFormOutsideAlliance; contextTag = 'create'; }
    else if (hubListContainer) { anchor = hubListContainer; contextTag = 'hub'; }

    const existingCalc = document.querySelector('.nxa-calc-panel');

    if (!anchor) {
      if (existingCalc) existingCalc.remove();  // no valid anchor on this page — don't show it
      return;
    }

    // Rebuild whenever the panel is missing, disconnected, OR was built for
    // a different context — this is what actually guards against the
    // Alliance panel silently ending up with the global fee (or vice
    // versa) if a stale node from a previous tab ever lingers.
    if (existingCalc && existingCalc.isConnected && existingCalc.dataset.nxaContext === contextTag) {
      return;
    }
    if (existingCalc) existingCalc.remove();

    const panel = buildCalcPanel(isAlliance);
    panel.dataset.nxaContext = contextTag;
    if (contextTag === 'hub' || contextTag === 'create' || contextTag === 'orderbook') {
      anchor.parentNode.insertBefore(panel, anchor);
    } else {
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    }
  }

  // ====================================================================
  //  "Fill Order Form" button
  //  The calculator is fully independent — you set Give/Ask however you
  //  like, it's never overwritten by whatever happens to already be in the
  //  Create Order form. This button goes the OTHER direction: it pushes
  //  the calculator's current values into the game's own "I offer"/"I
  //  want" fields for you to review and submit yourself. It only ever
  //  fills those two fields — it never touches or clicks "Post Order".
  // ====================================================================

  function keyFromSelect(sel) {
    // option values are the game's own resource keys (e.g. 'cryo_ice',
    // 'dark_matter') — norm() strips the underscore so it lines up with our
    // internal keys directly, no need to go via the visible option text.
    const key = norm(sel.value);
    return RESOURCES.some((r) => r.key === key) ? key : null;
  }

  // Real markup: <form class="market-create-form"><div class="market-form-row">
  // <label>I offer</label><select>…</select><input type="number" …></div>…
  // labelTexts may be a string or an array of candidate strings (e.g. the
  // game's own EN/DE label variants) — the first row matching any of them wins.
  function findFormRow(root, labelTexts) {
    const candidates = (Array.isArray(labelTexts) ? labelTexts : [labelTexts])
      .map((s) => s.toLowerCase());
    const rows = root.querySelectorAll('form.market-create-form .market-form-row');
    for (const row of rows) {
      const label = row.querySelector('label');
      if (label && candidates.includes(label.textContent.trim().toLowerCase())) return row;
    }
    return null;
  }

  // finds the <option> whose value corresponds to our internal resource
  // key — the reverse of keyFromSelect()'s norm()-based matching
  function optionValueForKey(sel, key) {
    const opt = Array.from(sel.options).find((o) => norm(o.value) === key);
    return opt ? opt.value : null;
  }

  function mountOrderFormFillButton() {
    if (!calcApi || !isAutoFillEnabled()) {
      document.querySelectorAll('.nxa-orderform-fill-btn').forEach((b) => b.remove());
      return;
    }
    // search the whole document rather than a specific tab wrapper — the
    // same form.market-create-form component is reused by both the
    // Alliance Trade "New Order" form and the regular Create Order tab.
    const form = document.querySelector('form.market-create-form');
    if (!form) {
      document.querySelectorAll('.nxa-orderform-fill-btn').forEach((b) => b.remove());
      return;
    }
    // Already mounted for this exact (still-live) form — leave it alone.
    // refreshAll() runs on ~every unrelated game DOM update, and rebuilding
    // the buttons every time could remove the very node the user is mid-
    // click on, which is why they sometimes didn't react before.
    if (form.querySelector('.nxa-orderform-fill-btn')) return;
    // form was replaced (e.g. tab switch) — drop any leftover buttons from
    // the old, now-detached form before mounting fresh ones.
    document.querySelectorAll('.nxa-orderform-fill-btn').forEach((b) => b.remove());

    const submitBtn = form.querySelector('button[type="submit"]');
    const offerRow = findFormRow(form, 'I offer');
    const wantRow = findFormRow(form, 'I want');
    if (!submitBtn || !offerRow || !wantRow) return;

    // Shared fill logic — only the ask amount source differs between the
    // two buttons (exact vs rounded-to-clean-number).
    function fill(askAmountField) {
      const state = calcApi.getState();
      const offerSel = offerRow.querySelector('select');
      const offerAmt = offerRow.querySelector('input[type="number"]');
      const wantSel = wantRow.querySelector('select');
      const wantAmt = wantRow.querySelector('input[type="number"]');
      if (offerSel) {
        const val = optionValueForKey(offerSel, state.giveKey);
        if (val != null) fillNativeInput(offerSel, val);
      }
      if (offerAmt && state.giveAmount !== '') fillNativeInput(offerAmt, state.giveAmount);
      if (wantSel) {
        const val = optionValueForKey(wantSel, state.getKey);
        if (val != null) fillNativeInput(wantSel, val);
      }
      if (wantAmt && state[askAmountField] !== '') fillNativeInput(wantAmt, state[askAmountField]);
    }

    function fillBtn(label, askAmountField) {
      const btn = h('button', { type: 'button', class: 'nxa-orderform-fill-btn',
        onclick: () => fill(askAmountField),
        onmouseenter: (e) => { e.target.style.background = '#16324a'; },
        onmouseleave: (e) => { e.target.style.background = '#0f2437'; },
        style: `${FONT};color:#38bdf8;background:#0f2437;border:1px solid #1e3a52;`
          + 'border-radius:6px;cursor:pointer;padding:8px 12px;flex:1' },
        label);
      return btn;
    }

    const wrap = h('div', { class: 'nxa-orderform-fill-btn',
      style: 'display:flex;gap:8px;margin-bottom:8px' },
      fillBtn(t('fillOrderFormButtonExact'), 'askAmount'),
      fillBtn(t('fillOrderFormButtonRounded'), 'askAmountClean'));

    submitBtn.parentNode.insertBefore(wrap, submitBtn);
  }

  // ====================================================================
  //  Fleet cargo → ships-needed badge
  //  When the "Send fleet to deliver X <resource>" panel is open (reached
  //  via "Fill" on a trade order), show how many of that ship type it takes
  //  to carry the required cargo — placed right in that ship's own row (next
  //  to its Cargo/SPD stats), so it's obvious which ship the number is for.
  //  Every other ship type is left untouched — this is purely a read
  //  display, it never changes any quantity input itself.
  //
  //  Real markup: .alliance-fill-panel > .fill-panel-header (contains a
  //  .market-resource-amount with the needed amount) and a list of
  //  .fill-ship-row, each with .fill-ship-name ("Bulk Carrier", …) and
  //  .fill-ship-stats ("Cargo:4.200 SPD:4").
  // ====================================================================

  // navigator.clipboard.writeText() can hang or silently fail in a
  // userscript sandbox (async permission negotiation, document-focus
  // quirks) — try it, but always fall back to the older synchronous
  // execCommand('copy') method via a hidden textarea, which doesn't depend
  // on any of that and just works immediately.
  function copyText(text) {
    let done = false;
    const fallback = () => {
      if (done) return;
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    };
    try {
      navigator.clipboard.writeText(text).then(() => { done = true; }).catch(fallback);
    } catch (e) { /* ignore */ }
    // don't wait on the promise — run the reliable fallback right away too;
    // whichever finishes first, the clipboard ends up with the right text
    fallback();
  }

  // React (and similar frameworks) override the input element's own
  // `value` setter to track changes internally; setting `input.value = x`
  // directly calls that OVERRIDDEN setter, which React's own change
  // detection doesn't register as a real change, so a plain dispatched
  // 'input' event does nothing. Calling the ORIGINAL native setter first
  // (bypassing React's override) makes React's internal tracker see the
  // value as changed, so the subsequent 'input' event correctly fires
  // onChange, exactly as if the player had typed it themselves.
  //
  // This only ever runs from a direct button click the player makes — it
  // fills one quantity field, nothing else. It never touches Send Fleet or
  // any other submit control, and never runs on its own.
  function fillNativeInput(input, value) {
    if (!input) return false;
    try {
      const proto = Object.getPrototypeOf(input);
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')
        && Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (nativeSetter) {
        nativeSetter.call(input, String(value));
      } else {
        input.value = String(value); // fallback for a non-standard input element
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  }

  const CARGO_SHIP_NAMES = new Set([
    'Bulk Carrier', 'Großfrachter', 'Massengutfrachter',
    'Transport Shuttle', 'Transport-Shuttle', 'Transportshuttle',
    'Tanker',
    'Freighter', 'Frachter',
    'Ore Freighter', 'Erzfrachter', 'Ore-Frachter',
  ]);

  // The fleet has to cover a round trip: carry the requested resource TO
  // the creator, then carry the offered resource BACK — cargo space is
  // reused sequentially between the two legs, so the binding constraint is
  // the LARGER of the order's own offer/request amounts, not just the
  // amount shown in the fill panel's header (which only reflects one leg).
  // Read directly from the order row above the panel — fixed and present
  // immediately, unlike the "Cargo: X/Y needed" line inside the panel,
  // which only appears (and changes) once ships have already been entered.
  function readOrderSides(panel) {
    const row = panel.closest('.market-order-row') || panel.parentElement;
    if (!row) return null;
    const parseSide = (sel) => {
      const el = row.querySelector(`${sel} .market-resource-amount`);
      if (!el) return null;
      const strong = el.querySelector('strong');
      const amount = parseInt((strong?.textContent || '').replace(/[^\d]/g, ''), 10);
      const resource = el.querySelector('img')?.getAttribute('alt')
        || (el.getAttribute('title') || '').replace(/[\d,.\s]/g, '');
      return Number.isFinite(amount) && amount > 0 ? { amount, resource } : null;
    };
    const offer = parseSide('.market-order-offer');
    const request = parseSide('.market-order-request');
    return (offer || request) ? { offer, request } : null;
  }

  // Some ship types can only carry specific resources (per their in-game
  // description): Tanker is hydrogen-only ("cannot carry ore/silicates/
  // alloys"); Ore Freighter is ore-and-silicates-only ("cannot carry
  // hydrogen or alloys"). Bulk Carrier / Transport Shuttle / Freighter have
  // no such restriction. Returns null for "no restriction", otherwise a Set
  // of norm()'d resource keys the ship is allowed to carry.
  function shipAllowedResources(name) {
    const n = norm(name);
    if (n === 'tanker') return new Set(['hydrogen']);
    if (n === 'orefreighter' || n === 'erzfrachter') return new Set(['ore', 'silicates']);
    return null;
  }

  function annotateFleetCargo() {
    const panel = document.querySelector('.alliance-fill-panel');
    if (!panel) {
      // panel closed — clean up any leftovers just in case
      document.querySelectorAll('.nxa-fleet-cargo-badge').forEach((b) => b.remove());
      document.querySelectorAll('.nxa-fleet-insufficient-badge').forEach((b) => b.remove());
      document.querySelectorAll('.nxa-autofill-btn').forEach((b) => b.remove());
      document.querySelectorAll('.fill-ship-row').forEach((row) => {
        row.style.removeProperty('box-shadow');
        row.style.removeProperty('border-radius');
      });
      return;
    }

    const header = panel.querySelector('.fill-panel-header');
    if (!header) return;
    const headerAmountEl = header.querySelector('.market-resource-amount');
    const headerQty = parseInt(
      (headerAmountEl?.querySelector('strong')?.textContent || '').replace(/[^\d]/g, ''), 10,
    );
    const headerResource = headerAmountEl?.querySelector('img')?.getAttribute('alt')
      || (headerAmountEl?.getAttribute('title') || '').replace(/[\d,.\s]/g, '');
    const orderSides = readOrderSides(panel);
    const orderCandidates = orderSides ? [orderSides.offer, orderSides.request].filter(Boolean) : [];
    const needed = orderCandidates.length
      ? Math.max(...orderCandidates.map((c) => c.amount))
      : headerQty;
    // BOTH resources of the round trip — the fleet has to carry whichever
    // resource is requested there AND whichever is offered back, so a
    // restricted ship (Tanker, Ore Freighter) is only usable if it can
    // carry EVERY resource involved, not just whichever leg is larger.
    const neededResources = orderCandidates.length
      ? orderCandidates.map((c) => norm(c.resource))
      : [norm(headerResource)].filter(Boolean);
    if (!Number.isFinite(needed) || needed <= 0) return;

    document.querySelectorAll('.nxa-fleet-cargo-badge').forEach((b) => b.remove());
    document.querySelectorAll('.nxa-fleet-insufficient-badge').forEach((b) => b.remove());
    document.querySelectorAll('.nxa-autofill-btn').forEach((b) => b.remove());
    document.querySelectorAll('.fill-ship-row').forEach((row) => {
      row.style.removeProperty('box-shadow');
      row.style.removeProperty('border-radius');
    });

    let totalAvailableCapacity = 0;
    let sawAnyCargoShipRow = false;
    const eligibleRows = [];

    panel.querySelectorAll('.fill-ship-row').forEach((row) => {
      const nameEl = row.querySelector('.fill-ship-name');
      const statsEl = row.querySelector('.fill-ship-stats');
      if (!nameEl || !statsEl) return;
      const name = nameEl.textContent.trim();
      if (!CARGO_SHIP_NAMES.has(name)) return;
      // skip ship types that can't carry EVERY resource in this round trip
      // (e.g. Tanker is hydrogen-only — useless here even if the delivery
      // leg happens to be hydrogen, because it still can't carry back
      // whatever the other side of the trade is)
      const allowed = shipAllowedResources(name);
      if (allowed && neededResources.length
        && !neededResources.every((r) => allowed.has(r))) return;
      const capMatch = statsEl.textContent.match(/Cargo:\s*([\d.,]+)/);
      if (!capMatch) return;
      const capacity = parseInt(capMatch[1].replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(capacity) || capacity <= 0) return;
      const shipsNeeded = Math.ceil(needed / capacity);

      const availEl = row.querySelector('.fill-ship-avail');
      const availMatch = availEl && availEl.textContent.match(/(\d+)/);
      const available = availMatch ? parseInt(availMatch[1], 10) : null;

      // tally combined capacity across ALL eligible cargo ship types,
      // regardless of what we end up displaying — used below to check if
      // you have enough cargo space at all, even split across types
      if (available != null) {
        sawAnyCargoShipRow = true;
        totalAvailableCapacity += available * capacity;
      }

      eligibleRows.push({ row, name, statsEl, capacity, shipsNeeded, available });
    });

    // If a single ship type alone (the one with the LARGEST capacity that
    // you own enough of) can cover the whole delivery, only highlight that
    // one — showing several types at once when one would already do the
    // job is just noise. Only fall back to showing every eligible type
    // when no single type alone suffices, so the user can combine them.
    const sufficientAlone = eligibleRows
      .filter((r) => r.available != null && r.available >= r.shipsNeeded)
      .sort((a, b) => b.capacity - a.capacity);
    const rowsToShow = sufficientAlone.length ? [sufficientAlone[0]] : eligibleRows;
    const singleSufficientRow = sufficientAlone.length ? sufficientAlone[0] : null;

    rowsToShow.forEach(({ row, statsEl, shipsNeeded }) => {
      // highlight the whole row with a blue outline — box-shadow instead
      // of border so it doesn't add to the row's box size and shift the
      // surrounding layout
      row.style.boxShadow = 'inset 0 0 0 1px #3b82f6';
      row.style.borderRadius = '8px';

      // single flat pill: number + a plain copy glyph, no divider — the
      // WHOLE pill is one real <button> so it's unmistakably clickable
      const wrap = document.createElement('button');
      wrap.type = 'button';
      wrap.className = 'nxa-fleet-cargo-badge';
      attachHoverTooltip(wrap, () => t('copyShipsNeeded'));
      wrap.style.cssText = PILL
        + ';display:inline-flex;align-items:center;gap:5px;margin-right:10px;cursor:pointer;'
        + 'color:#38bdf8;background:transparent;border-color:#38bdf8;font-size:calc(1em + 2px)';
      wrap.onmouseenter = () => { wrap.style.background = 'rgba(56,189,248,0.12)'; };
      wrap.onmouseleave = () => { wrap.style.background = 'transparent'; };

      const label = document.createElement('span');
      const trueLabel = `${shipsNeeded}× needed`;
      label.textContent = trueLabel;
      const icon = document.createElement('span');
      icon.textContent = '⧉';
      icon.style.cssText = 'opacity:0.75';

      wrap.append(label, icon);
      let copyCooldown = null;
      wrap.onclick = () => {
        if (copyCooldown) return;  // ignore clicks while the "copied" state is showing
        copyText(String(shipsNeeded));
        label.textContent = t('copied');
        copyCooldown = setTimeout(() => {
          label.textContent = trueLabel;
          copyCooldown = null;
        }, 1000);
      };

      statsEl.parentNode.insertBefore(wrap, statsEl);
    });

    // Optional auto-fill button (off by default, toggled in the
    // calculator's settings gear) — only offered when a single ship type
    // alone covers the delivery, so it's a plain "fill this one field"
    // action rather than a computed split across multiple ship types,
    // which would edge toward automated decision-making. It only ever
    // writes a quantity into the game's own input for manual review —
    // Send Fleet is always still up to the user.
    if (isAutoFillEnabled() && singleSufficientRow) {
      const sendBtn = Array.from(panel.querySelectorAll('button'))
        .find((b) => /send fleet/i.test(b.textContent || ''));
      if (sendBtn && !panel.querySelector('.nxa-autofill-btn')) {
        const qtyInput = singleSufficientRow.row.querySelector(
          '.qty-control input[type="number"], .ship-quantity-stepper input[type="number"]',
        );
        if (qtyInput) {
          const autoFillBtn = h('button', { type: 'button', class: 'nxa-autofill-btn',
            onclick: () => {
              fillNativeInput(qtyInput, singleSufficientRow.shipsNeeded);
            },
            style: `${FONT};color:#38bdf8;background:#0f2437;border:1px solid #1e3a52;`
              + 'border-radius:6px;cursor:pointer;padding:6px 12px;width:100%;margin:6px 0' },
            t('autoFillButton', singleSufficientRow.shipsNeeded, singleSufficientRow.name));
          sendBtn.parentNode.insertBefore(autoFillBtn, sendBtn);
        }
      }
    }

    // combined-capacity warning: even split across BOTH cargo ship types,
    // you don't own enough total cargo space to ever cover this delivery —
    // shown in the order-info row itself (next to our ratio/value badge,
    // right before the Close button), not inside the ship list
    if (sawAnyCargoShipRow && totalAvailableCapacity < needed) {
      const orderRow = panel.closest('.market-order-row');
      const info = orderRow && orderRow.querySelector('.market-order-info');
      if (info) {
        const warn = document.createElement('span');
        warn.className = 'nxa-fleet-insufficient-badge';
        warn.textContent = t('notEnoughCargoSpace');
        warn.style.cssText = PILL
          + ';display:inline-flex;align-items:center;margin-left:6px;vertical-align:middle;'
          + 'color:#f87171;background:transparent;border-color:#f87171;font-size:calc(1em + 3px);'
          + 'cursor:help';
        attachTooltip(warn, () => t('notEnoughCargoSpaceTooltip', totalAvailableCapacity, needed));
        info.appendChild(warn);
      }
    }
  }

  // ====================================================================
  //  Calculator reset on tab switch
  //  The panel is meant to always start fresh (empty fields, default
  //  resources) whenever you enter a tab — but some tabs don't fully
  //  unmount their old DOM when you navigate away and back, so our own
  //  "already mounted for this context" check in mountCalculator() would
  //  otherwise just keep reusing whatever was typed last time. We can't
  //  rely on a specific class for the tab bar (unconfirmed markup), so we
  //  match tab buttons by their exact visible text instead — good enough
  //  since these are short, unique, unlikely-to-collide labels.
  // ====================================================================

  const TAB_NAMES = new Set([
    'browse', 'hub inventory', 'create order', 'my orders',
    'history', 'artifacts', 'cosmetics', 'trader', 'alliance trade',
  ]);

  document.addEventListener('click', (e) => {
    let el = e.target;
    for (let i = 0; i < 4 && el; i++) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if (TAB_NAMES.has(txt)) {
        const existing = document.querySelector('.nxa-calc-panel');
        if (existing) existing.remove();  // forces mountCalculator() to rebuild fresh
        lastFillGiveKey = null;
        lastFillGiveAmount = null;
        lastFillGetKey = null;
        break;
      }
      el = el.parentElement;
    }
  }, true);

  // ---- observer ----
  // The Alliance Trade tab is unmounted and remounted by the SPA whenever you
  // switch to another tab and back — the container is a brand new DOM node
  // each time, so an observer attached to "the container" goes stale the
  // moment you leave the tab once. There is no event-driven way to notice a
  // node being (re)created except watching something above it, so — same as
  // the original script — we run exactly one MutationObserver on
  // document.body. This is not polling: it does nothing on a timer and only
  // wakes up when the DOM actually changes. Mutations that are entirely our
  // own badge injections are ignored so we don't re-annotate in a loop.
  function isOurs(n) {
    return n.nodeType === 1 && (n.classList?.contains('nxa-value-badge')
      || n.classList?.contains('nxa-calc-panel') || n.classList?.contains('nxa-history-badge')
      || n.classList?.contains('nxa-you-marker') || n.classList?.contains('nxa-want-hint')
      || n.classList?.contains('nxa-fleet-cargo-badge') || n.classList?.contains('nxa-myorder-badge')
      || n.classList?.contains('nxa-fleet-insufficient-badge') || n.classList?.contains('nxa-autofill-btn')
      || n.classList?.contains('nxa-orderform-fill-btn')
      || n.closest?.('.nxa-value-badge') || n.closest?.('.nxa-calc-panel')
      || n.closest?.('.nxa-history-badge') || n.closest?.('.nxa-you-marker')
      || n.closest?.('.nxa-want-hint') || n.closest?.('.nxa-fleet-cargo-badge')
      || n.closest?.('.nxa-myorder-badge') || n.closest?.('.nxa-fleet-insufficient-badge')
      || n.closest?.('.nxa-autofill-btn') || n.closest?.('.nxa-orderform-fill-btn'));
  }

  function refreshAll() {
    annotateAll(); annotateHistory(); annotateMyOrders(); annotateOrderBook();
    mountCalculator(); mountOrderFormFillButton(); annotateFleetCargo();
    syncWeightsPanelInputs();
  }

  let debounceObs = null;
  new MutationObserver((muts) => {
    if (muts.every((m) => [...m.addedNodes, ...m.removedNodes].every(isOurs))) {
      return;  // our own injections
    }
    clearTimeout(debounceObs);
    debounceObs = setTimeout(refreshAll, 200);
  }).observe(document.body, { childList: true, subtree: true });

  refreshAll();
})();
