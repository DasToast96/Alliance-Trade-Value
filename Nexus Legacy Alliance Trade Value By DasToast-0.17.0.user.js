// ==UserScript==
// @name        Nexus Legacy Trade Value By DasToast
// @namespace   nexuslegacy-alliance-tools
// @author      DasToast
// @description Annotates Alliance Trade orders with their value ratio under your own resource weights. Standalone — completely independent from the Market Value script.
// @version     1.3.0
// @match       https://*.nexuslegacy.space/*
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @run-at      document-idle
// @noframes
// ==/UserScript==

/*
 * Display tool for the Alliance Trade tab, the regular Market's Browse tab,
 * and My Orders — separate namespace, separate storage. No network, no
 * token, no polling, no alerts. Parses the market DOM client-side and
 * annotates each order row in place.
 *
 * Each Alliance Trade order is "you GIVE the request, you GET the offer".
 * Alliance Trade has no hub fee (0% commission), so the value you get is
 * simply the gross offer amount — there is no "after N% fee" line to parse.
 * We value both sides with your weights and show the ratio  get / give
 * (×1.00 = fair value; >1 favours you).
 *
 * Weights: DEFAULT_WEIGHTS below is the built-in ratio table. Storage only
 * ever holds the *overrides* the user has typed in the inline panel — a
 * blank field simply means "use the default for this resource". This makes
 * the UI unambiguous: greyed-out placeholder = default value in effect,
 * a typed value = your override, clearing the field reverts to default.
 *
 * Edit weights via the inline "Ressourcen-Gewichte" panel next to "+ New
 * Order", or via the userscript menu → "Set alliance trade resource
 * weights" (raw JSON, same overrides format, for bulk edits).
 * Everything in this script — the observer, the storage key, the badge
 * class — only ever touches the Alliance Trade container; it never looks
 * at or reacts to anything outside it.
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

  // ---- language detection ----
  // The page has an EN/DE language switcher (button.lang-btn, aria-label
  // "English"/"Deutsch"). We read whichever button is marked active/current,
  // fall back to <html lang="">, then to the browser's own language.
  function computeLang() {
    try {
      const activeBtn = document.querySelector(
        '.lang-btn.active, .lang-btn.is-active, .lang-btn[aria-pressed="true"], '
        + '.lang-btn.selected, .lang-btn.current, .lang-btn[aria-current="true"]');
      if (activeBtn) {
        const label = (activeBtn.getAttribute('aria-label') || activeBtn.textContent || '').trim().toLowerCase();
        if (label === 'deutsch' || label === 'german' || label === 'de') return 'de';
        if (label === 'english' || label === 'en') return 'en';
      }
    } catch (e) { /* ignore */ }
    try {
      const htmlLang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
      if (htmlLang.startsWith('de')) return 'de';
      if (htmlLang.startsWith('en')) return 'en';
    } catch (e) { /* ignore */ }
    return (navigator.language || '').toLowerCase().startsWith('de') ? 'de' : 'en';
  }

  let LANG = computeLang();

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
      amountToGive: 'amount to give',
      amountToGet: 'amount to get',
      pickDifferent: 'pick two different resources',
      noWeightRate: 'no weight set for one of these — check the userscript menu',
      fairRate: (giveLabel, val, getLabel) => `fair rate  1 ${giveLabel} = ${val} ${getLabel}`,
      unrounded: (v) => `unrounded: ${v}`,
      justCalculating: "Calculator won't automate anything.",
      feeUpdateHint: 'To update your fee cost, open Hub Inventory after research.',
      swapTooltip: 'Swap Give and Ask For',
      ratios: 'Ratios',
      ratiosTooltip: 'These are the default ratios used to value trades. Type a number to override.',
      weightPillTitle: (label, def) => `${label} — blank use the default (${def})`,
      noWeightPillTitle: (missing) => `No weight set for "${missing}" — add it via the userscript menu.`,
      scamLabel: 'SCAMMER',
      scamTitle: 'Fun fact: this order pays well under fair value.',
      youWereBuyer: 'You were the buyer on this trade.',
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
      feeError: 'error',
      feeErrorNote: '\n(fee rate unknown — open Hub Inventory once to detect it)',
      feeErrorLine: 'fee rate unknown — open Hub Inventory once to detect it',
      feeToolTipAlliance: 'Alliance Trade has no hub fee — 0% commission.',
      feeNoneAlliance: 'Alliance Trade has no fee — 0% commission.',
    },
    de: {
      calcTitle: 'Fairer-Handel-Rechner',
      give: 'Geben',
      askExactly: 'verlangen genau',
      amountToGive: 'Menge zum Geben',
      amountToGet: 'Menge zum Erhalten',
      pickDifferent: 'zwei unterschiedliche Ressourcen wählen',
      noWeightRate: 'für eine davon ist kein Gewicht gesetzt — im Userscript-Menü prüfen',
      fairRate: (giveLabel, val, getLabel) => `fairer Kurs  1 ${giveLabel} = ${val} ${getLabel}`,
      unrounded: (v) => `ungerundet: ${v}`,
      justCalculating: 'Der Rechner automatisiert nichts.',
      feeUpdateHint: 'Um deine Gebühr zu aktualisieren, öffne nach der Forschung Hub Inventory.',
      swapTooltip: 'Geben und Verlangen tauschen',
      ratios: 'Verhältnisse',
      ratiosTooltip: 'Das sind die Standard-Verhältnisse zur Bewertung von Trades. Zahl eingeben zum Überschreiben.',
      weightPillTitle: (label, def) => `${label} — leer lassen für den Standardwert (${def})`,
      noWeightPillTitle: (missing) => `Kein Gewicht für "${missing}" gesetzt — über das Userscript-Menü hinzufügen.`,
      scamLabel: 'ABZOCKER',
      scamTitle: 'Nur zum Spaß: diese Order zahlt deutlich unter fairem Wert.',
      youWereBuyer: 'Du warst der Käufer in diesem Trade.',
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
      feeError: 'error',
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
  // effective weights = defaults with overrides layered on top
  function weights() {
    return { ...DEFAULT_WEIGHTS, ...overrides() };
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
      lastDetectedFeePercent = detected;
      try { GM_setValue(LAST_FEE_KEY, String(detected)); } catch (e) { /* ignore */ }
      return detected;
    }
    return lastDetectedFeePercent;
  }

  function refreshAfterWeightChange() {
    cachedOverrides = null; // force a re-read from storage next call
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

  const fmt = (n) => {
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
    return String(Math.round(n));
  };

  // green→amber→red bands by value ratio (get / give)
  function colorFor(ratio) {
    if (ratio >= 1.05) return '#4ade80';
    if (ratio >= 1.0) return '#a3e635';
    if (ratio >= 0.95) return '#fbbf24';
    if (ratio >= 0.85) return '#fb923c';
    return '#f87171';
  }

  const PILL = 'padding:0 6px;border:1px solid;border-radius:6px;'
    + 'font:600 11px/1.6 "Lucida Console",Menlo,Monaco,"Roboto Mono",monospace;'
    + 'white-space:nowrap';

  function annotateRow(row) {
    // safety guard — this script only ever touches Alliance Trade rows and
    // the regular Market's Browse tab (both share the same row markup),
    // never anything else, even if annotateAll()'s own selector were
    // ever loosened.
    if (!row.closest('.alliance-trade-tab') && !row.closest('.market-browse')) return;

    row.querySelectorAll('.nxa-value-badge').forEach((b) => b.remove());

    const give = parseAmount(row.querySelector('.market-order-request .market-resource-amount'));
    const get = parseAmount(row.querySelector('.market-order-offer .market-resource-amount'));
    if (!give || !get) return;

    // one container holds all our pills, so the observer can ignore its own
    // injections by checking a single class
    const wrap = document.createElement('span');
    wrap.className = 'nxa-value-badge';
    wrap.style.cssText = 'display:inline-flex;gap:4px;align-items:center;'
      + 'margin-left:6px;vertical-align:middle';

    const w = weights();
    const wGive = w[norm(give.resource)];
    const wGet = w[norm(get.resource)];

    if (wGive == null || wGet == null) {
      const missing = wGive == null ? give.resource : get.resource;
      const pill = document.createElement('span');
      pill.textContent = `? ${missing}`;
      pill.title = t('noWeightPillTitle', missing);
      pill.style.cssText = PILL + ';color:#94a3b8;border-color:#475569';
      wrap.appendChild(pill);
    } else {
      const giveVal = give.amount * wGive;
      // Regular Market fills take a hub fee off what you receive; Alliance
      // Trade has none (0% commission), so only apply it outside that tab.
      // Prefer THIS row's own exact net line ("after N% fee") when present;
      // otherwise fall back to the page-wide detected/cached rate. If
      // neither has ever been seen, don't fabricate a number — show the
      // gross (un-deducted) value and flag it as unknown instead.
      const inBrowse = !row.closest('.alliance-trade-tab');
      const rowFeePct = inBrowse ? (parseNetLine(row) ?? feePercent()) : 0;
      const feeUnknown = inBrowse && rowFeePct == null;
      const feeMultiplier = (inBrowse && !feeUnknown) ? (1 - rowFeePct / 100) : 1;
      const getVal = get.amount * wGet * feeMultiplier;
      const ratio = giveVal > 0 ? getVal / giveVal : 0;
      const delta = getVal - giveVal;  // buyer's (filler's) profit/loss vs. ×1.00
      const color = colorFor(ratio);
      const equivGet = delta / wGet;  // delta expressed as extra/less of the received resource
      const title = t('buyerTitle', delta, equivGet, get.resource)
        + (feeUnknown ? t('feeErrorNote') : (inBrowse ? t('feeAppliedNote', rowFeePct) : ''));

      // headline pills: ×ratio (solid) + profit/loss as % (outline). Absolute
      // value and the resource-equivalent are still one hover away in the
      // tooltip — they're different views of the same underlying number.
      const ratioPill = document.createElement('span');
      ratioPill.textContent = `×${ratio.toFixed(2)}`;
      ratioPill.style.cssText = PILL
        + `;color:#06121f;background:${color};border-color:${color}`;
      ratioPill.title = title;

      const pctPill = document.createElement('span');
      pctPill.textContent = `${delta >= 0 ? '+' : ''}${fmt(delta)}`;
      pctPill.style.cssText = PILL
        + `;color:${color};background:transparent;border-color:${color}`;
      pctPill.title = title;

      wrap.append(ratioPill, pctPill);

      // fun fact, live orders only (not Trade History): a steep red ratio
      // gets called out with an extra "SCAMMER" field, just for laughs.
      if (color === '#f87171') {
        const scamPill = document.createElement('span');
        scamPill.textContent = t('scamLabel');
        scamPill.title = t('scamTitle');
        scamPill.style.cssText = PILL
          + ';color:#f87171;background:transparent;border-color:#f87171;font-weight:800';
        wrap.appendChild(scamPill);
      }
    }

    // mount right after the game's own rate "(1:1.81)"
    const anchor = row.querySelector('.market-order-rate')
      || row.querySelector('.market-order-info');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    }
  }

  function annotateAll() {
    document.querySelectorAll(
      '.alliance-trade-tab .market-order-row, .market-browse .market-order-row',
    ).forEach((row) => {
      annotateRow(row);
    });
  }

  // ====================================================================
  //  Trade History value badges
  //  Same ratio/value math as the live orders above, applied to completed
  //  (and cancelled) Trade History entries — so you can see in hindsight
  //  who came out ahead on a given trade. No "SCAMMER" fun-fact tag here on
  //  purpose — that's only for the live, still-open orders further up.
  //
  //  Real markup: .market-trade-history > .market-trade-row, each row
  //  holding exactly two .market-resource-amount spans in order — give
  //  first, get second — followed by "by X → Y" text and the date.
  // ====================================================================

  function annotateHistoryRow(row) {
    row.querySelectorAll('.nxa-history-badge, .nxa-you-marker').forEach((b) => b.remove());

    const amounts = row.querySelectorAll('.market-resource-amount');
    if (amounts.length < 2) return;
    // Perspective fix: like the original script, we value trades from the
    // buyer's (filler's) side, not the order creator's. The row shows
    // "creator gives (left) ⇄ creator gets (right)" — so from the buyer's
    // side it's the mirror image: buyer gives the right resource and gets
    // the left one.
    const give = parseAmount(amounts[1]);
    const get = parseAmount(amounts[0]);
    if (!give || !get) return;

    const w = weights();
    const wGive = w[norm(give.resource)];
    const wGet = w[norm(get.resource)];
    if (wGive == null || wGet == null) return;  // silently skip unknown resources here

    const giveVal = give.amount * wGive;
    const getVal = get.amount * wGet;
    const ratio = giveVal > 0 ? getVal / giveVal : 0;
    const delta = getVal - giveVal;  // buyer's (filler's) profit/loss vs. ×1.00
    const color = colorFor(ratio);
    const equivGet = delta / wGet;  // delta expressed as extra/less of the received resource
    const title = t('buyerTitle', delta, equivGet, get.resource);

    const wrap = document.createElement('span');
    wrap.className = 'nxa-history-badge';
    wrap.style.cssText = 'display:inline-flex;gap:4px;align-items:center;'
      + 'margin-left:6px;vertical-align:middle';

    // headline pills: ×ratio (solid) + profit/loss as % (outline). Absolute
    // value and the resource-equivalent are still one hover away in the
    // tooltip.
    const ratioPill = document.createElement('span');
    ratioPill.textContent = `×${ratio.toFixed(2)}`;
    ratioPill.style.cssText = PILL
      + `;color:#06121f;background:${color};border-color:${color}`;
    ratioPill.title = title;

    const pctPill = document.createElement('span');
    pctPill.textContent = `${delta >= 0 ? '+' : ''}${fmt(delta)}`;
    pctPill.style.cssText = PILL
      + `;color:${color};background:transparent;border-color:${color}`;
    pctPill.title = title;

    wrap.append(ratioPill, pctPill);

    // mount right after the "get" amount, before the "by X → Y" text
    const getWrapper = amounts[1].parentNode;
    getWrapper.parentNode.insertBefore(wrap, getWrapper.nextSibling);

    // "you bought this" marker: the "by Seller → Buyer" text is the one
    // direct-child span of the row that starts with "by " and has no class
    // of its own (unlike the direction pill and the date, which do). If it
    // ends in "by you", you were the buyer on this historical trade.
    const partySpan = Array.from(row.children)
      .find((el) => el.tagName === 'SPAN' && !el.className && /^by\s/i.test(el.textContent || ''));
    if (partySpan && /by you\s*$/i.test(partySpan.textContent || '')) {
      const marker = document.createElement('span');
      marker.className = 'nxa-you-marker';
      marker.textContent = ' 🙋';
      marker.title = t('youWereBuyer');
      marker.style.cssText = `${FONT};color:#4ade80`;
      partySpan.appendChild(marker);
    }
  }

  function annotateHistory() {
    document.querySelectorAll('.market-trade-history .market-trade-row').forEach((row) => {
      annotateHistoryRow(row);
    });
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
    row.querySelectorAll('.nxa-myorder-badge').forEach((b) => b.remove());

    const amounts = row.querySelectorAll('.market-resource-amount');
    if (amounts.length < 2) return;
    const get = parseAmountTotal(amounts[0]);   // what you (creator) are asking for
    const give = parseAmountTotal(amounts[1]);  // what you (creator) offer in exchange
    if (!get || !give) return;

    const w = weights();
    const wGive = w[norm(give.resource)];
    const wGet = w[norm(get.resource)];
    if (wGive == null || wGet == null) return;  // silently skip unknown resources here

    const giveVal = give.amount * wGive;
    const getVal = get.amount * wGet;
    const ratio = giveVal > 0 ? getVal / giveVal : 0;
    const delta = getVal - giveVal;
    const color = colorFor(ratio);
    const equivGet = delta / wGet;
    const title = t('sellerTitle', delta, equivGet, get.resource);

    const wrap = document.createElement('span');
    wrap.className = 'nxa-myorder-badge';
    wrap.style.cssText = 'display:inline-flex;gap:4px;align-items:center;'
      + 'margin-left:6px;vertical-align:middle';

    const ratioPill = document.createElement('span');
    ratioPill.textContent = `×${ratio.toFixed(2)}`;
    ratioPill.style.cssText = PILL
      + `;color:#06121f;background:${color};border-color:${color}`;
    ratioPill.title = title;

    const pctPill = document.createElement('span');
    pctPill.textContent = `${delta >= 0 ? '+' : ''}${fmt(delta)}`;
    pctPill.style.cssText = PILL
      + `;color:${color};background:transparent;border-color:${color}`;
    pctPill.title = title;

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
  const FONT = 'font:600 12px/1.5 "Lucida Console",Menlo,Monaco,"Roboto Mono",ui-monospace,monospace';
  const FIELD = `${FONT};background:#0b1a2b;color:#cbd5e1;border:1px solid #1e3a52;`
    + 'border-radius:5px;padding:2px 6px';

  function resSelect(value, onchange) {
    const sel = h('select', { style: FIELD, onchange });
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

  function buildCalcPanel(isAlliance) {
    let giveKey = 'ore';
    let getKey = 'silicates';

    const giveAmount = h('input', { type: 'number', min: '0', step: 'any',
      placeholder: t('amountToGive'), style: `${FIELD};width:130px` });
    const getOutput = h('input', { type: 'text', readonly: 'true',
      placeholder: t('amountToGet'), style: `${FIELD};width:150px;color:#4ade80` });
    const rateNote = h('div', { style: 'display:flex;flex-direction:column;gap:2px' },
      h('span', { style: `${FONT};color:#64748b` }, ''),
      h('span', { style: `${FONT};color:#38bdf8` }, ''));
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
        rateNoFeeEl.textContent = t('pickDifferent');
        rateWithFeeEl.textContent = '';
        return;
      }
      if (wGive == null || wGet == null) {
        getOutput.value = '';
        rateNoFeeEl.textContent = t('noWeightRate');
        rateWithFeeEl.textContent = '';
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
      if (!(amt > 0)) { getOutput.value = ''; return; }
      const exact = amt * fair;
      // strip trailing zeros (e.g. "0.500" -> "0.5", "22" stays "22") without
      // rounding — the point is the exact value, not a rounded-off one that
      // silently becomes "0" for small amounts.
      getOutput.value = String(Math.round(exact));
      getOutput.title = '';
    }

    const giveSel = resSelect(giveKey, () => { giveKey = giveSel.value; recalc(); });
    const getSel = resSelect(getKey, () => { getKey = getSel.value; recalc(); });
    giveAmount.oninput = recalc;

    calcRecalc = recalc;
    // Sync API: only ever WRITES to this calculator's own giveSel/getSel/
    // giveAmount — never touches the game's "I offer"/"I want" form. Used
    // by wireOrderForm() below to mirror the resource + amount the user
    // already picked in the order form, so they don't have to pick the
    // same resource twice.
    calcApi = {
      setGive(key) {
        if (!RESOURCES.some((r) => r.key === key) || key === giveKey) return;
        giveKey = key; giveSel.value = key; recalc();
      },
      setGet(key) {
        if (!RESOURCES.some((r) => r.key === key) || key === getKey) return;
        getKey = key; getSel.value = key; recalc();
      },
      setGiveAmount(val) {
        if (document.activeElement === giveAmount) return; // don't fight manual typing
        if (giveAmount.value === String(val)) return;
        giveAmount.value = val; recalc();
      },
    };
    recalc();

    const leftCol = h('div', { style: 'flex:1;min-width:260px' },
      h('div', { style: `${FONT};color:#e2e8f0` }, t('calcTitle')),
      h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px' },
        h('span', { style: `${FONT};color:#94a3b8` }, t('give')),
        giveAmount, giveSel,
        h('button', { type: 'button', title: t('swapTooltip'), onclick: () => {
          const tmpKey = giveKey; giveKey = getKey; getKey = tmpKey;
          giveSel.value = giveKey; getSel.value = getKey;
          if (getOutput.value !== '') giveAmount.value = getOutput.value;
          recalc();
        }, style: `${FONT};color:#38bdf8;font-weight:800;background:transparent;`
          + 'border:none;cursor:pointer;padding:0' }, '⇄'),
        h('span', { style: `${FONT};color:#94a3b8` }, t('askExactly')),
        getOutput, getSel),
      h('div', { style: 'margin-top:6px' }, rateNote),
      h('div', { style: 'margin-top:15px;padding-top:8px;border-top:1px solid #1e3a52;'
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
        style: 'width:16px;height:16px;object-fit:contain;flex:none;border-radius:50%' })
      : h('span', { style: 'width:12px;height:12px;border-radius:50%;flex:none;'
        + `background:${FALLBACK_COLOR[r.key] || '#64748b'}` });

    const input = h('input', {
      type: 'number',
      min: '0',
      step: '0.1',
      placeholder: String(def),
      value: cur != null ? String(cur) : '',
      style: `${FONT};background:transparent;border:none;outline:none;width:38px;`
        + 'padding:0;color:#f1f5f9;font-weight:800;font-size:15px',
      title: t('weightPillTitle', r.label, def),
    });

    let debounce = null;
    input.oninput = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const current = overrides();
        const val = input.value.trim();
        if (val === '') delete current[r.key];
        else current[r.key] = Number(val);
        saveOverrides(current);
        refreshAfterWeightChange();
      }, 250);
    };

    weightInputsByKey[r.key] = input;

    return h('span', {
      title: t('weightPillTitle', r.label, def),
      style: 'display:flex;align-items:center;justify-content:center;gap:4px;'
        + 'background:#0f1b2e;border:1px solid #1e3a52;border-radius:999px;'
        + 'padding:2px 8px;box-sizing:border-box',
    }, icon, input);
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
    return h('span', {
      title: isAlliance ? t('feeToolTipAlliance') : t('feeTooltip'),
      style: 'display:flex;align-items:center;gap:4px;background:#0f1b2e;'
        + 'border:1px solid #1e3a52;border-radius:999px;padding:3px 10px',
    },
      h('span', { style: `${FONT};color:#94a3b8;font-size:12px` }, t('feeLabel')),
      feeDisplayEl);
  }

  function buildWeightsGrid(isAlliance) {
    weightInputsByKey = {};
    return h('div', { style: 'flex:none;width:290px' },
      h('div', { style: 'display:flex;align-items:center;justify-content:center;gap:6px;'
        + 'flex-wrap:wrap' },
        h('span', { style: 'display:flex;align-items:center;gap:6px', title: t('ratiosTooltip') },
          h('span', { style: 'font-size:16px;color:#38bdf8' }, '⚖'),
          h('span', { style: `${FONT};color:#e2e8f0;font-size:13px;font-weight:800` }, t('ratios'))),
        buildFeeControl(isAlliance)),
      h('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:6px' },
        ...RESOURCES.map((r) => buildWeightPill(r))));
  }

  // Keep the panel's own inputs in sync when weights/fee change from
  // elsewhere (the menu commands), without rebuilding the whole panel.
  function syncWeightsPanelInputs() {
    const ov = overrides();
    for (const r of RESOURCES) {
      const input = weightInputsByKey[r.key];
      if (!input || document.activeElement === input) continue; // don't fight the user mid-typing
      const cur = ov[r.key];
      input.value = cur != null ? String(cur) : '';
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
      .find((b) => /new order/i.test(b.textContent || ''));

    const browseTab = document.querySelector('.market-browse');
    const filterRow = browseTab && browseTab.querySelector('.market-filter-row');

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
    if (contextTag === 'hub' || contextTag === 'create') {
      anchor.parentNode.insertBefore(panel, anchor);
    } else {
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    }
  }

  // ====================================================================
  //  Order-form read-only sync
  //  When the "New Order" form is open, it has its own "I offer" resource
  //  + amount and "I want" resource fields. Instead of making the user pick
  //  the same two resources again up in the calculator, we mirror the
  //  resource choices (and the "I offer" amount, since it's the same value
  //  as "amount to give") into the calculator's OWN inputs.
  //
  //  This is strictly one-way and read-only from the game's perspective:
  //  we only ever READ the "I offer"/"I want" selects and the "I offer"
  //  amount input, and only ever WRITE into the calculator panel we built
  //  ourselves. We never write into the game's own form fields (that would
  //  cross the line into automating order creation, which this script does
  //  not do) — the computed "amount to get" still has to be typed into
  //  "I want" by hand.
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

  function wireOrderForm() {
    if (!calcApi) return;
    // search the whole document rather than a specific tab wrapper — the
    // same form.market-create-form component is reused by both the
    // Alliance Trade "New Order" form and the regular Create Order tab.
    const offerRow = findFormRow(document, 'I offer');
    if (offerRow) {
      const sel = offerRow.querySelector('select');
      const amountInput = offerRow.querySelector('input[type="number"]');
      if (sel) {
        const key = keyFromSelect(sel);
        if (key) calcApi.setGive(key);
        if (!sel.dataset.nxaWired) {
          sel.dataset.nxaWired = '1';
          sel.addEventListener('change', () => {
            const k = keyFromSelect(sel);
            if (k) calcApi.setGive(k);
          });
        }
      }
      if (amountInput && !amountInput.dataset.nxaWired) {
        amountInput.dataset.nxaWired = '1';
        amountInput.addEventListener('input', () => {
          if (amountInput.value !== '') calcApi.setGiveAmount(amountInput.value);
        });
      }
    }

    const wantRow = findFormRow(document, 'I want');
    if (wantRow) {
      const sel = wantRow.querySelector('select');
      if (sel) {
        const key = keyFromSelect(sel);
        if (key) calcApi.setGet(key);
        if (!sel.dataset.nxaWired) {
          sel.dataset.nxaWired = '1';
          sel.addEventListener('change', () => {
            const k = keyFromSelect(sel);
            if (k) calcApi.setGet(k);
          });
        }
      }
      // "I want" Amount input is intentionally never touched — the user
      // types the calculator's result into it by hand.
    }
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

  const CARGO_SHIP_NAMES = new Set([
    'Bulk Carrier', 'Großfrachter', 'Massengutfrachter',
    'Transport Shuttle', 'Transport-Shuttle', 'Transportshuttle',
  ]);

  function annotateFleetCargo() {
    document.querySelectorAll('.nxa-fleet-cargo-badge').forEach((b) => b.remove());

    const panel = document.querySelector('.alliance-fill-panel');
    if (!panel) return;

    const header = panel.querySelector('.fill-panel-header');
    const strongEl = header && header.querySelector('.market-resource-amount strong');
    const needed = parseInt((strongEl?.textContent || '').replace(/[^\d]/g, ''), 10);
    if (!header || !Number.isFinite(needed) || needed <= 0) return;

    panel.querySelectorAll('.fill-ship-row').forEach((row) => {
      const nameEl = row.querySelector('.fill-ship-name');
      const statsEl = row.querySelector('.fill-ship-stats');
      if (!nameEl || !statsEl) return;
      const name = nameEl.textContent.trim();
      if (!CARGO_SHIP_NAMES.has(name)) return;
      const capMatch = statsEl.textContent.match(/Cargo:\s*([\d.,]+)/);
      if (!capMatch) return;
      const capacity = parseInt(capMatch[1].replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(capacity) || capacity <= 0) return;
      const shipsNeeded = Math.ceil(needed / capacity);
      const pill = document.createElement('span');
      pill.className = 'nxa-fleet-cargo-badge';
      pill.textContent = `${shipsNeeded}× needed`;
      pill.style.cssText = PILL
        + ';color:#38bdf8;background:transparent;border-color:#38bdf8;margin-left:10px';
      statsEl.parentNode.insertBefore(pill, statsEl.nextSibling);
    });
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
      || n.closest?.('.nxa-value-badge') || n.closest?.('.nxa-calc-panel')
      || n.closest?.('.nxa-history-badge') || n.closest?.('.nxa-you-marker')
      || n.closest?.('.nxa-want-hint') || n.closest?.('.nxa-fleet-cargo-badge')
      || n.closest?.('.nxa-myorder-badge'));
  }

  function refreshAll() {
    annotateAll(); annotateHistory(); annotateMyOrders();
    mountCalculator(); wireOrderForm(); annotateFleetCargo();
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
