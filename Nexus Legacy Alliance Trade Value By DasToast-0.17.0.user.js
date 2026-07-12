// ==UserScript==
// @name        Nexus Legacy Alliance Trade Value By DasToast
// @namespace   nexuslegacy-alliance-tools
// @description Annotates Alliance Trade orders with their value ratio under your own resource weights. Standalone — completely independent from the Market Value script.
// @version     0.17.0
// @match       https://*.nexuslegacy.space/*
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @run-at      document-idle
// @noframes
// ==/UserScript==

/*
 * Standalone display tool for the ALLIANCE TRADE tab only — separate script,
 * separate namespace, separate storage. No network, no token, no polling, no
 * alerts. Parses the alliance-trade DOM client-side and annotates each order
 * row in place.
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

  function refreshAfterWeightChange() {
    cachedOverrides = null; // force a re-read from storage next call
    annotateAll();
    annotateHistory();
    if (calcRecalc) calcRecalc();
    syncWeightsPanelInputs();
  }

  GM_registerMenuCommand('Set alliance trade resource weights', () => {
    const cur = JSON.stringify(overrides(), null, 0);
    const next = prompt(
      'Resource weight OVERRIDES as JSON (value per unit, relative to Ore=1).\n'
      + 'Only include resources you want to override — anything omitted uses\n'
      + 'the built-in default:', cur);
    if (next === null) return;
    try {
      const parsed = JSON.parse(next); // validate
      saveOverrides(parsed);
      refreshAfterWeightChange();
    } catch (e) { alert('Invalid JSON: ' + e.message); }
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
    + 'font:600 11px/1.6 "JetBrains Mono",monospace;white-space:nowrap';

  function annotateRow(row) {
    // safety guard — this script must never touch a row outside Alliance
    // Trade, even if annotateAll()'s own selector were ever loosened.
    if (!row.closest('.alliance-trade-tab')) return;

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
      pill.title = `No weight set for "${missing}" — add it via the userscript menu.`;
      pill.style.cssText = PILL + ';color:#94a3b8;border-color:#475569';
      wrap.appendChild(pill);
    } else {
      const giveVal = give.amount * wGive;
      const getVal = get.amount * wGet;
      const ratio = giveVal > 0 ? getVal / giveVal : 0;
      const delta = getVal - giveVal;  // buyer's (filler's) profit/loss vs. ×1.00
      const pct = (ratio - 1) * 100;   // same, expressed as a percentage — the headline number
      const color = colorFor(ratio);
      const equivGive = delta / wGive;  // delta converted back into give-resource units
      const title =
        `buyer ${delta >= 0 ? 'profit' : 'loss'} ${delta >= 0 ? '+' : ''}${fmt(delta)} value\n`
        + `≈ ${delta >= 0 ? '+' : ''}${Math.round(equivGive).toLocaleString()} ${give.resource} `
        + `worth of ${delta >= 0 ? 'savings' : 'overpayment'}, in what you actually paid with`;

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
        scamPill.textContent = 'SCAMMER';
        scamPill.title = 'Fun fact: this order pays well under fair value.';
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
    document.querySelectorAll('.alliance-trade-tab .market-order-row').forEach((row) => {
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
    const pct = (ratio - 1) * 100;   // same, expressed as a percentage — the headline number
    const color = colorFor(ratio);
    const equivGive = delta / wGive;  // delta converted back into give-resource units
    const title =
      `buyer ${delta >= 0 ? 'profit' : 'loss'} ${delta >= 0 ? '+' : ''}${fmt(delta)} value\n`
      + `≈ ${delta >= 0 ? '+' : ''}${Math.round(equivGive).toLocaleString()} ${give.resource} `
      + `worth of ${delta >= 0 ? 'savings' : 'overpayment'}, in what you actually paid with`;

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
      marker.title = 'You were the buyer on this trade.';
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
  //  Fair Trade Calculator
  //  A small panel next to "+ New Order": pick a Give resource and a Get
  //  resource, type how much you want to give, and it computes the exact
  //  amount to ask for so the trade is precisely ×1.00 under your weights.
  //  Pure client-side arithmetic — no network, no game API involved.
  // ====================================================================

  const RESOURCES = [
    { key: 'ore', label: 'Ore' },
    { key: 'silicates', label: 'Silicates' },
    { key: 'hydrogen', label: 'Hydrogen' },
    { key: 'alloys', label: 'Alloys' },
    { key: 'bioextract', label: 'Bio Extract' },
    { key: 'cryoice', label: 'Cryo Ice' },
    { key: 'plasmacore', label: 'Plasma Core' },
    { key: 'quantumdust', label: 'Quantum Dust' },
    { key: 'darkmatter', label: 'Dark Matter' },
    { key: 'antimatter', label: 'Antimatter' },
  ];
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
  const FONT = 'font:600 12px/1.5 "JetBrains Mono",ui-monospace,monospace';
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

  function buildCalcPanel() {
    let giveKey = 'alloys';
    let getKey = 'silicates';

    const giveAmount = h('input', { type: 'number', min: '0', step: 'any',
      placeholder: 'amount to give', style: `${FIELD};width:130px` });
    const getOutput = h('input', { type: 'text', readonly: 'true',
      placeholder: 'amount to get', style: `${FIELD};width:150px;color:#4ade80` });
    const rateNote = h('span', { style: `${FONT};color:#64748b` }, '');
    const warnNote = h('div', { style: 'display:flex;align-items:flex-start;gap:6px' },
      h('span', { style: `${FONT};color:#38bdf8;font-weight:900` }, '!'),
      h('span', { style: `${FONT};color:#64748b` },
        "Just calculating? Don't open a new Order or cancel the order."));
    const wantHintNote = h('div', { style: 'display:flex;align-items:flex-start;gap:6px' },
      h('span', { style: `${FONT};color:#38bdf8;font-weight:900` }, '!'),
      h('span', { style: `${FONT};color:#64748b` },
        "Calculator won't auto-fill this field.*"));

    function recalc() {
      const w = weights();
      const wGive = w[norm(giveKey)];
      const wGet = w[norm(getKey)];

      if (giveKey === getKey) {
        getOutput.value = '';
        rateNote.textContent = 'pick two different resources';
        return;
      }
      if (wGive == null || wGet == null) {
        getOutput.value = '';
        rateNote.textContent = 'no weight set for one of these — check the userscript menu';
        return;
      }

      const fair = wGive / wGet;  // units of `get` per unit of `give`, at ×1.00
      rateNote.textContent = `fair rate  1 ${resLabel(giveKey)} = ${fair.toFixed(3)} ${resLabel(getKey)}`;

      const amt = Number(giveAmount.value);
      if (!(amt > 0)) { getOutput.value = ''; return; }
      const exact = amt * fair;
      getOutput.value = String(Math.round(exact));
      getOutput.title = `unrounded: ${exact.toFixed(3)}`;
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
      h('div', { style: `${FONT};color:#e2e8f0` }, 'Fair Trade Calculator'),
      h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px' },
        h('span', { style: `${FONT};color:#94a3b8` }, 'Give'),
        giveAmount, giveSel,
        h('span', { style: `${FONT};color:#38bdf8;font-weight:800` }, '⇄'),
        h('span', { style: `${FONT};color:#94a3b8` }, 'ask for exactly'),
        getOutput, getSel),
      h('div', { style: 'margin-top:6px' }, rateNote),
      h('div', { style: 'margin-top:12px;padding-top:8px;border-top:1px solid #1e3a52;'
        + 'display:flex;flex-direction:column;gap:5px' },
        warnNote,
        wantHintNote));

    return h('div', { class: 'nxa-calc-panel', style:
      'margin:8px 0;padding:12px 14px;background:#06121f;border:1px solid #1e3a52;'
      + 'border-radius:10px;display:flex;justify-content:space-between;'
      + 'align-items:flex-start;gap:16px;flex-wrap:wrap' },
      leftCol, buildWeightsGrid());
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
      title: `${r.label} — blank use the default (${def})`,
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
      title: `${r.label} — blank use the default (${def})`,
      style: 'display:flex;align-items:center;justify-content:center;gap:4px;'
        + 'background:#0f1b2e;border:1px solid #1e3a52;border-radius:999px;'
        + 'padding:2px 8px;box-sizing:border-box',
    }, icon, input);
  }

  function buildWeightsGrid() {
    weightInputsByKey = {};
    return h('div', { style: 'flex:none;width:290px' },
      h('div', { style: 'display:flex;align-items:center;justify-content:center;gap:6px', title:
        'These are the default ratios used to value trades. Type a number to override.' },
        h('span', { style: 'font-size:16px;color:#38bdf8' }, '⚖'),
        h('span', { style: `${FONT};color:#e2e8f0;font-size:13px;font-weight:800` }, 'Ratios')),
      h('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:6px' },
        ...RESOURCES.map((r) => buildWeightPill(r))));
  }

  // Keep the panel's own inputs in sync when weights change from elsewhere
  // (the raw-JSON menu command), without rebuilding the whole panel.
  function syncWeightsPanelInputs() {
    const ov = overrides();
    for (const r of RESOURCES) {
      const input = weightInputsByKey[r.key];
      if (!input || document.activeElement === input) continue; // don't fight the user mid-typing
      const cur = ov[r.key];
      input.value = cur != null ? String(cur) : '';
    }
  }

  function mountCalculator() {
    const tab = document.querySelector('.alliance-trade-tab');
    if (!tab) return;

    const existingCalc = document.querySelector('.nxa-calc-panel');
    if (existingCalc && existingCalc.isConnected) return; // already mounted and live
    if (existingCalc) existingCalc.remove();  // stale leftover from a previous tab instance

    // anchor next to the "+ New Order" button — we don't rely on a specific
    // class for it since we don't control that markup, just its label
    const orderBtn = Array.from(tab.querySelectorAll('button'))
      .find((b) => /new order/i.test(b.textContent || ''));
    if (!orderBtn) return;  // page not rendered (yet) in the shape we expect

    orderBtn.parentNode.insertBefore(buildCalcPanel(), orderBtn.nextSibling);
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
  function findFormRow(root, labelText) {
    const rows = root.querySelectorAll('form.market-create-form .market-form-row');
    for (const row of rows) {
      const label = row.querySelector('label');
      if (label && label.textContent.trim().toLowerCase() === labelText.toLowerCase()) return row;
    }
    return null;
  }

  function wireOrderForm() {
    if (!calcApi) return;
    const tab = document.querySelector('.alliance-trade-tab');
    if (!tab) return;

    const offerRow = findFormRow(tab, 'I offer');
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

    const wantRow = findFormRow(tab, 'I want');
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
      // types the calculator's result into it by hand. A small asterisk
      // marks this, matching the footnote in the calculator panel above.
      const wantAmount = wantRow.querySelector('input[type="number"]');
      if (wantAmount && !wantRow.querySelector('.nxa-want-hint')) {
        const hint = h('span', { class: 'nxa-want-hint',
          style: `${FONT};color:#38bdf8;font-weight:900;font-size:15px;line-height:1;`
            + 'margin-left:8px',
        }, '*');
        wantAmount.parentNode.insertBefore(hint, wantAmount.nextSibling);
      }
    }
  }

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
      || n.closest?.('.nxa-value-badge') || n.closest?.('.nxa-calc-panel')
      || n.closest?.('.nxa-history-badge') || n.closest?.('.nxa-you-marker')
      || n.closest?.('.nxa-want-hint'));
  }

  function refreshAll() { annotateAll(); annotateHistory(); mountCalculator(); wireOrderForm(); }

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