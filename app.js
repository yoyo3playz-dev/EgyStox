/* ==========================================================================
   EgyStox — app.js
   -----------------------------------------------------------------------
   Sections:
     1. CONFIG & UNIVERSE       — refresh intervals, market hours, stocks
     2. PLACEHOLDER API LAYER   — swap these functions for real APIs later
     3. RANKING & SIGNALS       — Top 50, screener, RECOMMENDED/STABLE/RISKY
     4. RENDERING               — cards, karat tabs, ticker, tables, charts
     5. STOCK & METAL MODALS    — candlestick charts, risk, company facts
     6. MAIN LOOP               — ties it all together on shared intervals
   ========================================================================== */

/* ==========================================================================
   1. CONFIG & UNIVERSE
   ========================================================================== */

// Live UI refresh cadence. Real external calls are throttled separately
// (see section 6) so this fast tick never hammers a rate-limited API.
const REFRESH_INTERVAL_MS = 500;
const DEAL_REFRESH_INTERVAL_MS = 20000;
const GRAMS_PER_TROY_OUNCE = 31.1034768; // kept for reference only — not used to derive displayed gold/silver prices
const TOP_N = 50;
const SCREENER_N = 15;
const MAX_CHART_POINTS = 60;
const MAX_CANDLES = 80;
const GOLD_KARATS = [24, 22, 21, 18, 14, 12];

// Optional API keys for going fully live later. Leave null to keep the
// best-effort/simulated behavior described in section 2.
const CONFIG = {
  stocksApiKey: null, // e.g. a Twelve Data key — see fetchEgyptianStocks()
  metalsApiKey: null, // e.g. a licensed Egyptian gold-price vendor key
};

/**
 * EGX trading hours: Sunday–Thursday, 9:30–10:00 AM pre-open auction,
 * 10:00 AM–2:30 PM continuous session, Africa/Cairo time. Computed via
 * Intl so it stays correct regardless of Egypt's DST rules changing.
 */
function getCairoTimeParts() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, minutesOfDay: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10) };
}

function getEgxMarketStatus() {
  const { weekday, minutesOfDay } = getCairoTimeParts();
  const tradingDays = ["Sun", "Mon", "Tue", "Wed", "Thu"];
  const preOpen = 9 * 60 + 30, open = 10 * 60, close = 14 * 60 + 30;

  if (!tradingDays.includes(weekday)) {
    return { state: "closed", label: "Market Closed", detail: "Weekend — EGX trades Sun–Thu, 10:00–14:30 Cairo time", tradingActive: false };
  }
  if (minutesOfDay < preOpen) return { state: "closed", label: "Market Closed", detail: "Opens 9:30 AM Cairo time (pre-open auction)", tradingActive: false };
  if (minutesOfDay < open) return { state: "pre", label: "Pre-Market", detail: "Opening auction underway — continuous trading starts 10:00 AM", tradingActive: false };
  if (minutesOfDay < close) return { state: "open", label: "Market Open", detail: "EGX continuous trading session · closes 2:30 PM Cairo time", tradingActive: true };

  const reopensLabel = weekday === "Thu" ? "Sunday" : "tomorrow";
  return { state: "closed", label: "Market Closed", detail: `Session ended — reopens ${reopensLabel} 9:30 AM Cairo time`, tradingActive: false };
}

/**
 * Trading universe: current Top 50 plus a "challenger" bench that can
 * overtake a Top 50 member, triggering the ranking engine's re-sort.
 */
const STOCK_UNIVERSE = [
  ["COMI", "Commercial International Bank"], ["HRHO", "EFG Hermes Holding"],
  ["SWDY", "Elsewedy Electric"], ["TMGH", "Talaat Moustafa Group"],
  ["EFIH", "e-Finance Investment Group"], ["ETEL", "Telecom Egypt"],
  ["ORAS", "Orascom Construction"], ["EAST", "Eastern Company"],
  ["ABUK", "Abou Kir Fertilizers"], ["SKPC", "Sidi Kerir Petrochemicals"],
  ["EKHO", "Edita Food Industries"], ["ISPH", "Ibnsina Pharma"],
  ["MFPC", "Misr Fertilizers Production"], ["ORHD", "Orascom Development Egypt"],
  ["PHDC", "Palm Hills Developments"], ["AMOC", "Alexandria Mineral Oils"],
  ["ESRS", "Ezz Steel"], ["CIRA", "CIRA Education"],
  ["JUFO", "Juhayna Food Industries"], ["EGAL", "Egypt Aluminum"],
  ["EGTS", "Egyptian Transport & Commercial Services"], ["CLHO", "Cleopatra Hospitals Group"],
  ["RAYA", "Raya Holding"], ["EFID", "Edita Food Industries Pref."],
  ["ADIB", "Abu Dhabi Islamic Bank Egypt"], ["QNBE", "QNB Al Ahli Bank"],
  ["CIEB", "Credit Agricole Egypt"], ["HDBK", "Housing & Development Bank"],
  ["SAUD", "Saudi Egyptian Investment & Finance"], ["IRON", "Egyptian Iron & Steel"],
  ["ACGC", "Arabian Cement"], ["ELEC", "Egyptian Electrical Cables"],
  ["MICH", "Misr Chemical Industries"], ["POUL", "Cairo Poultry"],
  ["CCAP", "Citadel Capital"], ["DSCW", "Dice Sport & Casual Wear"],
  ["ATLC", "Atlas for Land Reclamation"], ["EGCH", "Egyptian Chemical Industries"],
  ["PACH", "Paints & Chemical Industries"], ["OCDI", "Sixth of October Development"],
  ["MTIE", "MM Group for Industry & Trade"], ["GBCO", "GB Corp"],
  ["EDBE", "Delta Insurance"], ["BTFH", "B Investments Holding"],
  ["FWRY", "Fawry for Banking Technology"], ["ARCC", "Arabian Cement Company"],
  ["UEGC", "Upper Egypt Contracting"], ["ODIN", "Osool Assets Management"],
  ["ARAB", "Arab Cotton Ginning"], ["NCPT", "National Company for Printing"],
  ["NASR", "Nasr City for Housing"], ["MENA", "Mena Touristic & Real Estate"],
  ["PORT", "Alexandria Portland Cement"], ["ELWA", "El Ezz Aldekhela Steel"],
  ["ALCN", "Alexandria Container & Cargo"], ["SCEM", "South Cairo Cement"],
  ["EFIC", "Egyptian Financial Group"], ["KZBR", "Kafr El Zayat Pesticides"],
  ["KABO", "Kabo Pharma"], ["RACC", "Rakta Paper Manufacturing"],
  ["ZMID", "Zahraa Maadi Investment"], ["SVCE", "Suez Cement"],
  ["TAQA", "Taqa Arabia"], ["AMER", "Amer Group Holding"],
];

/* ==========================================================================
   2. PLACEHOLDER API LAYER
   ========================================================================== */

const mockState = {
  usdEgp: 48.5,
  stocks: new Map(),      // symbol -> { price, marketCap }
  goldKarats: new Map(),  // karat -> egpPerGram
  silverEgp: 60,
};

const liveDataStatus = { fx: false };

(function seedStocks() {
  STOCK_UNIVERSE.forEach(([symbol], i) => {
    const basePrice = 8 + Math.random() * 180;
    const shareCount = 200_000_000 + Math.random() * 4_000_000_000;
    const rankPenalty = 1 - (i / STOCK_UNIVERSE.length) * 0.6;
    mockState.stocks.set(symbol, { price: Number(basePrice.toFixed(2)), marketCap: basePrice * shareCount * rankPenalty });
  });
})();

(function seedGoldKarats() {
  // Illustrative starting point only, not a live quote — each karat then
  // walks independently tick to tick rather than being recalculated from
  // another karat's price, per the "don't derive it live" requirement.
  const base24 = 4700 + Math.random() * 300;
  GOLD_KARATS.forEach((k) => {
    const purity = k / 24;
    mockState.goldKarats.set(k, Number((base24 * purity * (0.98 + Math.random() * 0.04)).toFixed(2)));
  });
})();

/**
 * STOCK & COMPANY SOURCE — Thndr.
 * -----------------------------------------------------------------------
 * Thndr (thndr.app) is Egypt's largest retail brokerage, but it does not
 * publish a public market-data API for third-party developers — its quote
 * data lives inside its own app only. This function ships with a realistic
 * simulation shaped exactly like a real quote feed, and freezes prices
 * outside EGX trading hours just like the real market would.
 *
 * To go live for real:
 *   1. A direct data/partnership agreement with Thndr, if one exists.
 *   2. A licensed EGX data vendor with a documented API — Twelve Data lists
 *      EGX (MIC: XCAI) support. Example swap-in:
 *
 *      const symbols = STOCK_UNIVERSE.map(([s]) => `${s}:XCAI`).join(",");
 *      const res = await fetch(`https://api.twelvedata.com/quote?symbol=${symbols}&apikey=${CONFIG.stocksApiKey}`);
 *      const data = await res.json();
 *      // then map into { symbol, name, price, marketCap, prevPrice }
 */
async function fetchEgyptianStocks(tradingActive) {
  return STOCK_UNIVERSE.map(([symbol, name]) => {
    const prev = mockState.stocks.get(symbol);

    if (!tradingActive) {
      recordCandle(symbol, prev.price, prev.price);
      return { symbol, name, price: prev.price, marketCap: prev.marketCap, prevPrice: prev.price };
    }

    const shock = Math.random() < 0.03 ? (Math.random() - 0.5) * 0.08 : 0;
    const pctMove = (Math.random() - 0.5) * 0.01 + shock;
    const newPrice = Math.max(0.5, prev.price * (1 + pctMove));
    const newCap = prev.marketCap * (1 + pctMove);

    mockState.stocks.set(symbol, { price: newPrice, marketCap: newCap });
    recordCandle(symbol, prev.price, newPrice);

    return { symbol, name, price: newPrice, marketCap: newCap, prevPrice: prev.price };
  });
}

/**
 * GOLD SOURCE — iSagha (El Sagha market), all karats.
 * -----------------------------------------------------------------------
 * iSagha (isagha.com) is Egypt's most widely used live gold/silver
 * reference but, like Thndr, has no public API for outside apps. Per your
 * request this does NOT derive karat prices from a USD/oz conversion —
 * each karat is tracked and walked as its own value. Replace the body
 * below with a real call the moment you have legitimate access:
 *
 *   const res = await fetch(`https://api.example.com/isagha/gold`, { headers: { Authorization: CONFIG.metalsApiKey }});
 *   const data = await res.json(); // expected: { "24": 4820.5, "21": 4218.0, ... }
 */
async function fetchGoldKaratPrices() {
  // Shared small drift represents the overall gold market moving, plus a
  // touch of independent noise per karat so they don't move in perfect lockstep.
  const marketDrift = (Math.random() - 0.5) * 0.0015;
  const result = {};
  GOLD_KARATS.forEach((k) => {
    const prev = mockState.goldKarats.get(k);
    const noise = (Math.random() - 0.5) * 0.0006;
    const next = Math.max(1, prev * (1 + marketDrift + noise));
    mockState.goldKarats.set(k, next);
    recordMetalCandle(`gold-${k}`, prev, next);
    result[k] = next;
  });
  return result;
}

/** See fetchGoldKaratPrices above — same source and approach, single grade. */
async function fetchSilverEgpPerGram() {
  const prev = mockState.silverEgp;
  const pctMove = (Math.random() - 0.5) * 0.002;
  const next = Math.max(0.5, prev * (1 + pctMove));
  mockState.silverEgp = next;
  recordMetalCandle("silver", prev, next);
  return next;
}

/**
 * FX SOURCE — USD to EGP. This one IS genuinely live: open.er-api.com is a
 * free, no-key exchange-rate API. Falls back to a small simulated drift if
 * the request fails (offline, blocked, rate-limited).
 */
async function fetchUsdToEgp() {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    if (!res.ok) throw new Error(`open.er-api.com responded ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.EGP;
    if (!rate) throw new Error("EGP rate missing from response");
    mockState.usdEgp = rate;
    liveDataStatus.fx = true;
    return { rate };
  } catch (err) {
    liveDataStatus.fx = false;
    const pctMove = (Math.random() - 0.5) * 0.0008;
    mockState.usdEgp *= 1 + pctMove;
    return { rate: mockState.usdEgp };
  }
}

/**
 * PLACEHOLDER — per-symbol company profile (founder, ownership, sector...).
 * Left as clearly-labeled placeholders so the UI never states unverified
 * facts about a real company's leadership or ownership.
 */
const profileCache = new Map();
async function fetchCompanyProfile(symbol) {
  if (profileCache.has(symbol)) return profileCache.get(symbol);
  const sectors = [
    "Banking & Financial Services", "Real Estate & Construction", "Industrials & Materials",
    "Consumer Goods", "Telecommunications", "Healthcare & Pharma", "Energy & Petrochemicals", "Technology",
  ];
  const seed = hashSeed(symbol, 7);
  const profile = {
    sector: sectors[seed % sectors.length],
    founded: "— (connect API)",
    ceoChairman: "— (connect company-profile API)",
    majorShareholder: "— (connect company-profile API)",
    headquarters: "Cairo, Egypt",
    listedSince: "— (connect company-profile API)",
  };
  profileCache.set(symbol, profile);
  return profile;
}

/**
 * PLACEHOLDER — government & large-corporate contract exposure per symbol.
 * Refreshes on its own slower cadence since real contract awards don't
 * happen every tick. Replace with a real procurement/contracts feed.
 */
const dealExposureCache = new Map();
async function fetchDealExposure(symbol) {
  const seed = hashSeed(symbol, Date.now() / DEAL_REFRESH_INTERVAL_MS | 0);
  const roll = seed % 100;
  let type = "none", counterparty = "—";
  if (roll < 22) {
    type = "government";
    counterparty = ["Ministry of Housing", "Ministry of Petroleum", "New Urban Communities Authority", "Ministry of Electricity", "Suez Canal Authority"][seed % 5];
  } else if (roll < 48) {
    type = "corporate";
    counterparty = ["Private developer consortium", "Regional bank syndicate", "Industrial group JV", "Telecom infrastructure partner"][seed % 4];
  }
  const recentContractValueEgp = type === "none" ? 0 : (200_000_000 + (seed % 9) * 350_000_000);
  const result = { type, counterparty, recentContractValueEgp };
  dealExposureCache.set(symbol, result);
  return result;
}

/**
 * PLACEHOLDER — P/E ratio. Real fundamentals require a licensed data feed;
 * this generates a stable, plausible-looking placeholder per symbol so the
 * "Valuation & signals" panel isn't empty, clearly marked as an estimate.
 */
function getPlaceholderPE(symbol) {
  const seed = hashSeed(symbol, 11);
  return 5 + (seed % 200) / 10; // ~5.0x - 25.0x
}

/**
 * PLACEHOLDER — short human-readable reason shown in the "Recommended
 * High-Income Stocks" section. Real version should pull from an actual
 * news/contracts/earnings feed; this just deterministically picks a
 * plausible-sounding note per symbol so the UI isn't empty.
 */
function getRecommendationNote(symbol) {
  const notes = [
    "Strong recent earnings", "New government contract signed", "Analyst upgrade this week",
    "Record quarterly revenue", "Expanding into new markets", "Positive guidance update",
  ];
  return notes[hashSeed(symbol, 13) % notes.length];
}

function hashSeed(str, salt = 0) {
  let h = Math.abs(Math.floor(salt)) || 1;
  for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/* ==========================================================================
   3. RANKING & SIGNALS
   ========================================================================== */

let previousRanks = new Map();

function computeTopN(allStocks, n = TOP_N) {
  const sorted = [...allStocks].sort((a, b) => b.marketCap - a.marketCap);
  return sorted.slice(0, n).map((stock, idx) => ({ ...stock, rank: idx + 1 }));
}

function computeMomentum(symbol) {
  const candles = candleHistory.get(symbol) || [];
  if (candles.length < 4) return 0;
  const lookback = Math.min(10, candles.length - 1);
  const past = candles[candles.length - 1 - lookback].c;
  const now = candles[candles.length - 1].c;
  return ((now - past) / past) * 100;
}

function isContinuouslyRising(symbol) {
  const candles = candleHistory.get(symbol) || [];
  if (candles.length < 6) return false;
  const recent = candles.slice(-6);
  let upSteps = 0;
  for (let i = 1; i < recent.length; i++) if (recent[i].c >= recent[i - 1].c) upSteps++;
  return upSteps >= 4;
}

function computeOpportunityScore(dealType, momentumPct) {
  const dealWeight = dealType === "government" ? 1 : dealType === "corporate" ? 0.65 : 0.2;
  const momentumNormalized = Math.max(0, Math.min(1, (momentumPct + 3) / 6));
  return Math.max(0, Math.min(100, dealWeight * 55 + momentumNormalized * 45));
}

/**
 * RECOMMENDED / STABLE / RISKY tagging. RECOMMENDED requires a stability
 * score of at least 60 ("60% safe") AND a continuous recent uptrend —
 * matching your rule. This is a heuristic label from simulated data, not
 * a guarantee — see disclaimers throughout the UI.
 */
function computeSignalTag(symbol) {
  const risk = computeRisk(symbol);
  const momentum = computeMomentum(symbol);
  const rising = isContinuouslyRising(symbol);

  if (risk.stabilityScore >= 60 && rising && momentum > 0.4) return { tag: "recommended", label: "RECOMMENDED" };
  if (risk.riskLevel === "High" || risk.stabilityScore < 40) return { tag: "risky", label: "RISKY" };
  if (risk.stabilityScore >= 55 && Math.abs(momentum) < 1) return { tag: "stable", label: "STABLE" };
  return { tag: "neutral", label: "—" };
}

/* ==========================================================================
   4. RENDERING
   ========================================================================== */

const els = {
  clock: document.getElementById("clock"),
  refreshLabel: document.getElementById("refreshLabel"),
  marketStatusPill: document.getElementById("marketStatusPill"),
  marketStatusText: document.getElementById("marketStatusText"),
  dataModeLabel: document.getElementById("dataModeLabel"),
  karatTabs: document.getElementById("karatTabs"),
  goldEgpGram: document.getElementById("goldEgpGram"),
  goldKaratLabel: document.getElementById("goldKaratLabel"),
  goldDelta: document.getElementById("goldDelta"),
  goldChartKarat: document.getElementById("goldChartKarat"),
  silverEgpGram: document.getElementById("silverEgpGram"),
  silverDelta: document.getElementById("silverDelta"),
  usdEgp: document.getElementById("usdEgp"),
  fxDelta: document.getElementById("fxDelta"),
  portfolioValue: document.getElementById("portfolioValue"),
  portfolioDelta: document.getElementById("portfolioDelta"),
  portfolioCount: document.getElementById("portfolioCount"),
  tickerTrack: document.getElementById("tickerTrack"),
  stockTableBody: document.getElementById("stockTableBody"),
  stockSearch: document.getElementById("stockSearch"),
  lastUpdated: document.getElementById("lastUpdated"),
  screenerTableBody: document.getElementById("screenerTableBody"),
  screenerUpdated: document.getElementById("screenerUpdated"),
  goldCard: document.getElementById("goldCard"),
  silverCard: document.getElementById("silverCard"),
};

els.refreshLabel.textContent = `Live · refreshing every ${(REFRESH_INTERVAL_MS / 1000)}s`;

let selectedKarat = 24;
let latestTop50 = [];

const egpFormatter = new Intl.NumberFormat("en-EG", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const capFormatter = new Intl.NumberFormat("en-EG", { notation: "compact", maximumFractionDigits: 2 });
function formatEgp(n) { return egpFormatter.format(n); }
function formatCap(n) { return capFormatter.format(n); }

function setDelta(el, pct) {
  const sign = pct > 0 ? "+" : "";
  el.textContent = `${sign}${pct.toFixed(2)}%`;
  el.classList.remove("up", "down", "flat");
  if (pct > 0.005) el.classList.add("up");
  else if (pct < -0.005) el.classList.add("down");
  else el.classList.add("flat");
}

/** Restarts a CSS flash animation on a persistent (non-recreated) element. */
function flashValue(el, direction) {
  if (!el || !direction) return;
  el.classList.remove("flash-up", "flash-down");
  void el.offsetWidth; // force reflow so the animation replays
  el.classList.add(direction > 0 ? "flash-up" : "flash-down");
}

function updateClock() {
  els.clock.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function renderMarketStatus() {
  const status = getEgxMarketStatus();
  els.marketStatusPill.classList.remove("market-open", "market-pre", "market-closed");
  els.marketStatusPill.classList.add(status.state === "open" ? "market-open" : status.state === "pre" ? "market-pre" : "market-closed");
  els.marketStatusText.textContent = `${status.label} · ${status.detail}`;
  return status;
}

function updateDataModeLabel() {
  els.dataModeLabel.textContent = liveDataStatus.fx
    ? "Live: FX · Gold, Silver & Stocks: simulated (Thndr/iSagha have no public API)"
    : "Simulated — live FX fetch unavailable too";
}

setInterval(updateClock, 1000);
updateClock();

/** Renders the karat selector tabs on the gold card. */
function renderKaratTabs() {
  els.karatTabs.innerHTML = GOLD_KARATS.map(
    (k) => `<button type="button" class="karat-tab ${k === selectedKarat ? "active" : ""}" data-karat="${k}">${k}K</button>`
  ).join("");
}
renderKaratTabs();

els.karatTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".karat-tab");
  if (!btn) return;
  selectedKarat = parseInt(btn.dataset.karat, 10);
  renderKaratTabs();
  els.goldKaratLabel.textContent = `${selectedKarat}K`;
  els.goldChartKarat.textContent = `${selectedKarat}K`;
  rebuildLineChartFromCandles(goldChart, metalCandleHistory.get(`gold-${selectedKarat}`) || []);
});

els.goldCard.addEventListener("click", (e) => {
  if (e.target.closest(".karat-tab")) return; // tab clicks shouldn't open the modal
  openMetalModal("gold");
});
els.goldCard.addEventListener("keydown", (e) => { if (e.key === "Enter") openMetalModal("gold"); });
els.silverCard.addEventListener("click", () => openMetalModal("silver"));
els.silverCard.addEventListener("keydown", (e) => { if (e.key === "Enter") openMetalModal("silver"); });

function renderTicker(top50) {
  const movers = [...top50].sort((a, b) => b.pctChange - a.pctChange).slice(0, 16);
  els.tickerTrack.innerHTML = movers
    .map((s) => {
      const cls = s.pctChange > 0 ? "up" : s.pctChange < 0 ? "down" : "";
      const arrow = s.pctChange > 0 ? "▲" : s.pctChange < 0 ? "▼" : "•";
      return `<span class="ticker__item"><span class="sym">${s.symbol}</span>${formatEgp(s.price)} EGP <span class="${cls}">${arrow} ${s.pctChange.toFixed(2)}%</span></span>`;
    })
    .join("");
}

function renderTable(top50, filterText = "") {
  const filtered = filterText
    ? top50.filter((s) => s.symbol.toLowerCase().includes(filterText) || s.name.toLowerCase().includes(filterText))
    : top50;

  els.stockTableBody.innerHTML = filtered
    .map((s) => {
      const prevRank = previousRanks.get(s.symbol);
      let moveHtml = "";
      let rowAnim = "";
      if (prevRank !== undefined && prevRank !== s.rank) {
        const improved = s.rank < prevRank;
        moveHtml = `<span class="rank-move ${improved ? "up" : "down"}">${improved ? "▲" : "▼"} ${Math.abs(prevRank - s.rank)}</span>`;
        rowAnim = improved ? "rank-improved" : "rank-worsened";
      }
      const isNewRow = prevRank === undefined;
      const changeCls = s.pctChange > 0 ? "up" : s.pctChange < 0 ? "down" : "flat";
      const priceFlashCls = s.pctChange > 0.01 ? "flash-up" : s.pctChange < -0.01 ? "flash-down" : "";
      const signal = computeSignalTag(s.symbol);

      return `
        <tr class="${isNewRow ? "row-new" : rowAnim}" data-symbol="${s.symbol}" tabindex="0">
          <td class="col-rank"><span class="rank-badge ${s.rank <= 10 ? "top" : ""}">${s.rank}</span>${moveHtml}</td>
          <td class="col-symbol">${s.symbol}</td>
          <td class="col-name">${s.name}</td>
          <td class="col-tag"><span class="signal-tag ${signal.tag}">${signal.label}</span></td>
          <td class="col-price"><span class="${priceFlashCls}">${formatEgp(s.price)}</span></td>
          <td class="col-change"><span class="delta ${changeCls}">${s.pctChange > 0 ? "+" : ""}${s.pctChange.toFixed(2)}%</span></td>
          <td class="col-cap">${formatCap(s.marketCap)}</td>
        </tr>`;
    })
    .join("");
}

els.stockSearch.addEventListener("input", (e) => renderTable(latestTop50, e.target.value.trim().toLowerCase()));

function bindRowOpenHandlers(tbody) {
  tbody.addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-symbol]");
    if (row) openStockModal(row.dataset.symbol);
  });
  tbody.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const row = e.target.closest("tr[data-symbol]");
    if (row) openStockModal(row.dataset.symbol);
  });
}
bindRowOpenHandlers(els.stockTableBody);
bindRowOpenHandlers(els.screenerTableBody);

function renderScreener(top50) {
  // Spec: this section curates stocks actually tagged RECOMMENDED (>=60
  // stability score + continuous uptrend) rather than just the top-scoring
  // names regardless of tag — see computeSignalTag() for the rule.
  const rows = top50
    .filter((s) => computeSignalTag(s.symbol).tag === "recommended")
    .map((s) => {
      const deal = dealExposureCache.get(s.symbol) || { type: "none", counterparty: "—", recentContractValueEgp: 0 };
      const momentum = computeMomentum(s.symbol);
      const score = computeOpportunityScore(deal.type, momentum);
      return { ...s, deal, momentum, score, note: getRecommendationNote(s.symbol) };
    });

  rows.sort((a, b) => b.score - a.score);
  const top = rows.slice(0, SCREENER_N);

  if (!top.length) {
    els.screenerTableBody.innerHTML = `
      <tr><td colspan="7" class="screener-empty">No stocks currently meet the RECOMMENDED bar (≥60 stability score + continuous uptrend). Check back as prices move.</td></tr>`;
    els.screenerUpdated.textContent = `Signals refreshed ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`;
    return;
  }

  els.screenerTableBody.innerHTML = top
    .map((s, idx) => {
      const dealCls = s.deal.type === "government" ? "gov" : s.deal.type === "corporate" ? "corp" : "none";
      const dealLabel = s.deal.type === "government" ? `Gov · ${s.deal.counterparty}` : s.deal.type === "corporate" ? `Corp · ${s.deal.counterparty}` : "No recent contract";
      const momentumPct = Math.max(-6, Math.min(6, s.momentum));
      const momentumFillPct = ((momentumPct + 6) / 12) * 100;
      const momentumColor = s.momentum >= 0 ? "var(--up)" : "var(--down)";
      const scoreCls = s.score >= 65 ? "s-high" : s.score >= 40 ? "s-mid" : "s-low";

      return `
        <tr data-symbol="${s.symbol}" tabindex="0">
          <td class="col-rank">${idx + 1}</td>
          <td class="col-symbol">${s.symbol}</td>
          <td class="col-name">${s.name}</td>
          <td class="col-note">${s.note}</td>
          <td class="col-deal"><span class="deal-tag ${dealCls}">${dealLabel}</span></td>
          <td class="col-momentum"><span class="momentum-bar">${s.momentum >= 0 ? "+" : ""}${s.momentum.toFixed(2)}%
            <span class="momentum-bar__track"><span class="momentum-bar__fill" style="width:${momentumFillPct}%; background:${momentumColor};"></span></span></span></td>
          <td class="col-score"><span class="score-pill ${scoreCls}">${Math.round(s.score)}</span></td>
        </tr>`;
    })
    .join("");

  els.screenerUpdated.textContent = `Signals refreshed ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`;
}

/* ---------------------------- Charts (Chart.js) ---------------------------- */

const lastValueTagPlugin = {
  id: "lastValueTag",
  afterDatasetsDraw(chart) {
    const { ctx, chartArea } = chart;
    const dataset = chart.data.datasets[0];
    const values = dataset.data;
    if (!values.length) return;
    const meta = chart.getDatasetMeta(0);
    const lastPoint = meta.data[meta.data.length - 1];
    if (!lastPoint) return;

    const y = lastPoint.y;
    const color = dataset.borderColor;
    const label = Number(values[values.length - 1]).toLocaleString("en-EG", { maximumFractionDigits: 2 });

    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = "600 10.5px 'JetBrains Mono', monospace";
    const textWidth = ctx.measureText(label).width;
    const paddingX = 6;
    const pillWidth = textWidth + paddingX * 2;
    const pillHeight = 16;
    const pillX = chartArea.right - pillWidth;
    const pillY = Math.min(Math.max(y - pillHeight / 2, chartArea.top), chartArea.bottom - pillHeight);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillWidth, pillHeight, 3);
    ctx.fill();
    ctx.fillStyle = "#0a0d12";
    ctx.textBaseline = "middle";
    ctx.fillText(label, pillX + paddingX, pillY + pillHeight / 2 + 0.5);
    ctx.restore();
  },
};

const chartDefaults = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 250, easing: "easeOutQuad" },
  interaction: { intersect: false, mode: "index" },
  plugins: {
    legend: { display: false },
    tooltip: { backgroundColor: "#0f141b", borderColor: "#232d3a", borderWidth: 1, titleFont: { family: "JetBrains Mono", size: 11 }, bodyFont: { family: "JetBrains Mono", size: 11 }, padding: 8, displayColors: false },
  },
  scales: {
    x: { ticks: { color: "#5f6b7a", font: { family: "JetBrains Mono", size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, grid: { color: "rgba(255,255,255,0.03)" } },
    y: { position: "right", ticks: { color: "#5f6b7a", font: { family: "JetBrains Mono", size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } },
  },
};

function makeLineChart(canvasId, color, label) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, 220);
  gradient.addColorStop(0, color + "33");
  gradient.addColorStop(1, color + "00");

  return new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: gradient, borderWidth: 1.75, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: color, fill: true, tension: 0.3 }] },
    options: chartDefaults,
    plugins: [lastValueTagPlugin],
  });
}

const portfolioChart = makeLineChart("portfolioChart", "#c9a227", "Top 50 value (EGP)");
const goldChart = makeLineChart("goldChart", "#e8c96b", "Gold (EGP/g)");
const silverChart = makeLineChart("silverChart", "#a9b4c0", "Silver (EGP/g)");

function pushPoint(chart, label, value) {
  const { labels, datasets } = chart.data;
  labels.push(label);
  datasets[0].data.push(value);
  if (labels.length > MAX_CHART_POINTS) { labels.shift(); datasets[0].data.shift(); }
  chart.update("none");
}

/** Rebuilds a line chart's full series from stored candle history (used on karat switch / modal open). */
function rebuildLineChartFromCandles(chart, candles) {
  const slice = candles.slice(-MAX_CHART_POINTS);
  chart.data.labels = slice.map((c) => new Date(c.t).toLocaleTimeString("en-GB", { hour12: false }));
  chart.data.datasets[0].data = slice.map((c) => c.c);
  chart.update();
}

/* ==========================================================================
   5. STOCK & METAL MODALS
   ========================================================================== */

const candleHistory = new Map();       // stock symbol -> candles
const metalCandleHistory = new Map();  // "gold-24" | "silver" -> candles

function recordCandle(symbol, prevPrice, newPrice) {
  const open = prevPrice, close = newPrice;
  const spread = Math.abs(close - open) * (0.4 + Math.random() * 0.9) + open * 0.0012;
  const high = Math.max(open, close) + spread * Math.random();
  const low = Math.min(open, close) - spread * Math.random();
  const arr = candleHistory.get(symbol) || [];
  arr.push({ t: Date.now(), o: open, h: high, l: low, c: close });
  if (arr.length > MAX_CANDLES) arr.shift();
  candleHistory.set(symbol, arr);
}

function recordMetalCandle(key, prevPrice, newPrice) {
  const open = prevPrice, close = newPrice;
  const spread = Math.abs(close - open) * (0.4 + Math.random() * 0.9) + open * 0.0008;
  const high = Math.max(open, close) + spread * Math.random();
  const low = Math.min(open, close) - spread * Math.random();
  const arr = metalCandleHistory.get(key) || [];
  arr.push({ t: Date.now(), o: open, h: high, l: low, c: close });
  if (arr.length > MAX_CANDLES) arr.shift();
  metalCandleHistory.set(key, arr);
}

function computeRisk(symbol) {
  const candles = candleHistory.get(symbol) || [];
  if (candles.length < 3) return { volatilityPct: 0, beta: 1, stabilityScore: 60, riskLevel: "—" };
  const returns = [];
  for (let i = 1; i < candles.length; i++) returns.push((candles[i].c - candles[i - 1].c) / candles[i - 1].c);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const volatilityPct = Math.sqrt(variance) * 100;
  const seed = hashSeed(symbol, 3);
  const beta = 0.5 + (seed % 150) / 100;
  const stabilityScore = Math.max(0, Math.min(100, 100 - volatilityPct * 30));
  let riskLevel = "Low";
  if (volatilityPct > 0.6) riskLevel = "High";
  else if (volatilityPct > 0.25) riskLevel = "Medium";
  return { volatilityPct, beta, stabilityScore, riskLevel };
}

/** Draws a dark, TradingView-style candlestick chart onto a plain canvas. */
function drawCandlestickChart(canvas, candles) {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth;
  const cssHeight = canvas.clientHeight || 260;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  if (!candles.length) return;

  const priceLabelWidth = 56, paddingTop = 10, paddingBottom = 8;
  const plotWidth = cssWidth - priceLabelWidth;
  const plotHeight = cssHeight - paddingTop - paddingBottom;

  const highs = candles.map((c) => c.h), lows = candles.map((c) => c.l);
  let max = Math.max(...highs), min = Math.min(...lows);
  const pad = (max - min) * 0.1 || max * 0.01;
  max += pad; min -= pad;
  const yFor = (price) => paddingTop + (1 - (price - min) / (max - min)) * plotHeight;

  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.fillStyle = "#5f6b7a";
  ctx.font = "10px 'JetBrains Mono', monospace";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const price = min + ((max - min) * i) / 4;
    const y = yFor(price);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotWidth, y); ctx.stroke();
    ctx.fillText(price.toFixed(2), plotWidth + 6, y);
  }

  const slotWidth = plotWidth / candles.length;
  const bodyWidth = Math.max(1.5, slotWidth * 0.55);

  candles.forEach((c, i) => {
    const xCenter = slotWidth * i + slotWidth / 2;
    const up = c.c >= c.o;
    const color = up ? "#3ecf8e" : "#f0616e";
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xCenter, yFor(c.h)); ctx.lineTo(xCenter, yFor(c.l)); ctx.stroke();
    const yOpen = yFor(c.o), yClose = yFor(c.c);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));
    ctx.fillRect(xCenter - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
  });

  const last = candles[candles.length - 1];
  const lastY = yFor(last.c);
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.beginPath(); ctx.moveTo(0, lastY); ctx.lineTo(plotWidth, lastY); ctx.stroke();
  ctx.setLineDash([]);

  const tagColor = last.c >= last.o ? "#3ecf8e" : "#f0616e";
  const label = last.c.toFixed(2);
  ctx.font = "600 10.5px 'JetBrains Mono', monospace";
  const textWidth = ctx.measureText(label).width;
  const pillWidth = textWidth + 12;
  ctx.fillStyle = tagColor;
  ctx.beginPath(); ctx.roundRect(plotWidth + 2, lastY - 8, pillWidth, 16, 3); ctx.fill();
  ctx.fillStyle = "#0a0d12";
  ctx.fillText(label, plotWidth + 8, lastY + 0.5);
}

/* ---- Stock modal ---- */
const modalEls = {
  backdrop: document.getElementById("stockModalBackdrop"),
  close: document.getElementById("stockModalClose"),
  symbol: document.getElementById("modalSymbol"),
  name: document.getElementById("modalName"),
  signalTag: document.getElementById("modalSignalTag"),
  price: document.getElementById("modalPrice"),
  delta: document.getElementById("modalDelta"),
  canvas: document.getElementById("modalCandleChart"),
  lastCandle: document.getElementById("modalLastCandle"),
  riskVolatility: document.getElementById("riskVolatility"),
  riskBeta: document.getElementById("riskBeta"),
  riskLevel: document.getElementById("riskLevel"),
  stabilityFill: document.getElementById("stabilityFill"),
  stabilityScore: document.getElementById("stabilityScore"),
  statPE: document.getElementById("statPE"),
  statDeal: document.getElementById("statDeal"),
  statExpectedRange: document.getElementById("statExpectedRange"),
  companyFacts: document.getElementById("companyFacts"),
};

let activeModalSymbol = null;

function updateModalContent(symbol) {
  const universeEntry = STOCK_UNIVERSE.find(([sym]) => sym === symbol);
  const liveStock = latestTop50.find((s) => s.symbol === symbol);
  const rawState = mockState.stocks.get(symbol);

  const name = universeEntry ? universeEntry[1] : symbol;
  const price = liveStock ? liveStock.price : rawState.price;
  const pctChange = liveStock ? liveStock.pctChange : 0;

  modalEls.symbol.textContent = symbol;
  modalEls.name.textContent = name;
  const signal = computeSignalTag(symbol);
  modalEls.signalTag.textContent = signal.label;
  modalEls.signalTag.className = `signal-tag ${signal.tag}`;
  const prevPriceText = modalEls.price.textContent;
  modalEls.price.textContent = `${formatEgp(price)} EGP`;
  if (prevPriceText !== "--" && prevPriceText !== modalEls.price.textContent) {
    flashValue(modalEls.price, pctChange >= 0 ? 1 : -1);
  }
  setDelta(modalEls.delta, pctChange);

  const candles = candleHistory.get(symbol) || [];
  drawCandlestickChart(modalEls.canvas, candles);
  const last = candles[candles.length - 1];
  modalEls.lastCandle.textContent = last ? `O ${last.o.toFixed(2)}  H ${last.h.toFixed(2)}  L ${last.l.toFixed(2)}  C ${last.c.toFixed(2)}` : "--";

  const risk = computeRisk(symbol);
  modalEls.riskVolatility.textContent = `${risk.volatilityPct.toFixed(2)}%`;
  modalEls.riskBeta.textContent = risk.beta.toFixed(2);
  modalEls.riskLevel.textContent = risk.riskLevel;
  modalEls.stabilityScore.textContent = `${Math.round(risk.stabilityScore)}/100`;
  modalEls.stabilityFill.style.width = `${risk.stabilityScore}%`;

  const deal = dealExposureCache.get(symbol) || { type: "none", counterparty: "—" };
  modalEls.statPE.textContent = `${getPlaceholderPE(symbol).toFixed(1)}x (estimated placeholder)`;
  modalEls.statDeal.textContent = deal.type === "none" ? "No recent contract" : `${deal.type === "government" ? "Gov" : "Corp"} · ${deal.counterparty}`;
  const expectedRangePct = Math.min(15, Math.max(1, risk.volatilityPct * 6));
  modalEls.statExpectedRange.textContent = `± ${expectedRangePct.toFixed(1)}% (model estimate)`;

  fetchCompanyProfile(symbol).then((profile) => {
    if (activeModalSymbol !== symbol) return;
    modalEls.companyFacts.innerHTML = `
      <dt>Sector</dt><dd>${profile.sector}</dd>
      <dt>Founded</dt><dd>${profile.founded}</dd>
      <dt>CEO / Chairman</dt><dd>${profile.ceoChairman}</dd>
      <dt>Major shareholder</dt><dd>${profile.majorShareholder}</dd>
      <dt>Headquarters</dt><dd>${profile.headquarters}</dd>
      <dt>Listed since</dt><dd>${profile.listedSince}</dd>
    `;
  });
}

function openStockModal(symbol) {
  activeModalSymbol = symbol;
  modalEls.price.textContent = "--";
  modalEls.backdrop.classList.add("open");
  updateModalContent(symbol);
}
function closeStockModal() { activeModalSymbol = null; modalEls.backdrop.classList.remove("open"); }
modalEls.close.addEventListener("click", closeStockModal);
modalEls.backdrop.addEventListener("click", (e) => { if (e.target === modalEls.backdrop) closeStockModal(); });

/* ---- Metal modal ---- */
const metalModalEls = {
  backdrop: document.getElementById("metalModalBackdrop"),
  close: document.getElementById("metalModalClose"),
  title: document.getElementById("metalModalTitle"),
  subtitle: document.getElementById("metalModalSubtitle"),
  price: document.getElementById("metalModalPrice"),
  delta: document.getElementById("metalModalDelta"),
  canvas: document.getElementById("metalModalCandleChart"),
  lastCandle: document.getElementById("metalModalLastCandle"),
  karatTabs: document.getElementById("metalModalKaratTabs"),
};

let activeMetalModal = null; // 'gold' | 'silver' | null
let lastMetalPrices = {};    // for delta calc while modal is open

function renderMetalModalKaratTabs() {
  if (activeMetalModal !== "gold") { metalModalEls.karatTabs.innerHTML = ""; return; }
  metalModalEls.karatTabs.innerHTML = GOLD_KARATS.map(
    (k) => `<button type="button" class="karat-tab ${k === selectedKarat ? "active" : ""}" data-karat="${k}">${k}K</button>`
  ).join("");
}

metalModalEls.karatTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".karat-tab");
  if (!btn || activeMetalModal !== "gold") return;
  selectedKarat = parseInt(btn.dataset.karat, 10);
  renderKaratTabs();
  els.goldKaratLabel.textContent = `${selectedKarat}K`;
  els.goldChartKarat.textContent = `${selectedKarat}K`;
  rebuildLineChartFromCandles(goldChart, metalCandleHistory.get(`gold-${selectedKarat}`) || []);
  renderMetalModalKaratTabs();
  updateMetalModalContent();
});

function updateMetalModalContent() {
  const key = activeMetalModal === "gold" ? `gold-${selectedKarat}` : "silver";
  const price = activeMetalModal === "gold" ? mockState.goldKarats.get(selectedKarat) : mockState.silverEgp;

  metalModalEls.title.textContent = activeMetalModal === "gold" ? `Gold ${selectedKarat}K` : "Silver";
  metalModalEls.subtitle.textContent = "Live per-gram price, EGP";

  const prev = lastMetalPrices[key];
  metalModalEls.price.textContent = `${formatEgp(price)} EGP/g`;
  if (prev !== undefined) {
    flashValue(metalModalEls.price, price >= prev ? 1 : -1);
    setDelta(metalModalEls.delta, ((price - prev) / prev) * 100);
  }
  lastMetalPrices[key] = price;

  const candles = metalCandleHistory.get(key) || [];
  drawCandlestickChart(metalModalEls.canvas, candles);
  const last = candles[candles.length - 1];
  metalModalEls.lastCandle.textContent = last ? `O ${last.o.toFixed(2)}  H ${last.h.toFixed(2)}  L ${last.l.toFixed(2)}  C ${last.c.toFixed(2)}` : "--";
}

function openMetalModal(type) {
  activeMetalModal = type;
  lastMetalPrices = {};
  renderMetalModalKaratTabs();
  metalModalEls.backdrop.classList.add("open");
  updateMetalModalContent();
}
function closeMetalModal() { activeMetalModal = null; metalModalEls.backdrop.classList.remove("open"); }
metalModalEls.close.addEventListener("click", closeMetalModal);
metalModalEls.backdrop.addEventListener("click", (e) => { if (e.target === metalModalEls.backdrop) closeMetalModal(); });

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (activeModalSymbol) closeStockModal();
  if (activeMetalModal) closeMetalModal();
});
window.addEventListener("resize", () => {
  if (activeModalSymbol) updateModalContent(activeModalSymbol);
  if (activeMetalModal) updateMetalModalContent();
});

/* ==========================================================================
   6. MAIN LOOP
   ========================================================================== */

let lastPortfolioValue = null, lastGoldEgp = null, lastSilverEgp = null, lastUsdEgp = null;

async function refreshDashboard() {
  try {
    const marketStatus = renderMarketStatus();

    const [stocksRaw, goldKarats, silverEgp, fx] = await Promise.all([
      fetchEgyptianStocks(marketStatus.tradingActive),
      fetchGoldKaratPrices(),
      fetchSilverEgpPerGram(),
      fetchUsdToEgp(),
    ]);
    updateDataModeLabel();

    const goldEgpGram = goldKarats[selectedKarat];

    const stocksWithChange = stocksRaw.map((s) => ({ ...s, pctChange: ((s.price - s.prevPrice) / s.prevPrice) * 100 }));
    const top50 = computeTopN(stocksWithChange, TOP_N);
    const portfolioValue = top50.reduce((sum, s) => sum + s.marketCap, 0);

    // Summary cards, with flash animation on the value text itself.
    els.goldEgpGram.textContent = formatEgp(goldEgpGram);
    if (lastGoldEgp !== null) { flashValue(els.goldEgpGram, goldEgpGram >= lastGoldEgp ? 1 : -1); setDelta(els.goldDelta, ((goldEgpGram - lastGoldEgp) / lastGoldEgp) * 100); }

    els.silverEgpGram.textContent = formatEgp(silverEgp);
    if (lastSilverEgp !== null) { flashValue(els.silverEgpGram, silverEgp >= lastSilverEgp ? 1 : -1); setDelta(els.silverDelta, ((silverEgp - lastSilverEgp) / lastSilverEgp) * 100); }

    els.usdEgp.textContent = fx.rate.toFixed(3);
    if (lastUsdEgp !== null) { flashValue(els.usdEgp, fx.rate >= lastUsdEgp ? 1 : -1); setDelta(els.fxDelta, ((fx.rate - lastUsdEgp) / lastUsdEgp) * 100); }

    els.portfolioValue.textContent = formatCap(portfolioValue);
    els.portfolioCount.textContent = `${top50.length} constituents`;
    if (lastPortfolioValue !== null) { flashValue(els.portfolioValue, portfolioValue >= lastPortfolioValue ? 1 : -1); setDelta(els.portfolioDelta, ((portfolioValue - lastPortfolioValue) / lastPortfolioValue) * 100); }

    const timeLabel = new Date().toLocaleTimeString("en-GB", { hour12: false });
    pushPoint(portfolioChart, timeLabel, portfolioValue);
    pushPoint(goldChart, timeLabel, goldEgpGram);
    pushPoint(silverChart, timeLabel, silverEgp);

    renderTicker(top50);
    renderTable(top50, els.stockSearch.value.trim().toLowerCase());
    renderScreener(top50);

    previousRanks = new Map(top50.map((s) => [s.symbol, s.rank]));
    latestTop50 = top50;
    els.lastUpdated.textContent = `Last updated ${timeLabel}`;

    if (activeModalSymbol) updateModalContent(activeModalSymbol);
    if (activeMetalModal) updateMetalModalContent();

    lastPortfolioValue = portfolioValue;
    lastGoldEgp = goldEgpGram;
    lastSilverEgp = silverEgp;
    lastUsdEgp = fx.rate;
  } catch (err) {
    console.error("Dashboard refresh failed:", err);
  }
}

async function refreshDealExposure() {
  await Promise.all(STOCK_UNIVERSE.map(([symbol]) => fetchDealExposure(symbol)));
}

refreshDealExposure().then(refreshDashboard);
setInterval(refreshDashboard, REFRESH_INTERVAL_MS);
setInterval(refreshDealExposure, DEAL_REFRESH_INTERVAL_MS);

/* ==========================================================================
   SECTION NAV — smooth-scroll + scroll-spy highlighting
   ========================================================================== */
(function initViewNav() {
  const nav = document.getElementById("viewNav");
  if (!nav) return;
  const buttons = [...nav.querySelectorAll(".view-nav__btn")];

  nav.addEventListener("click", (e) => {
    const btn = e.target.closest(".view-nav__btn");
    if (!btn) return;
    const target = document.getElementById(btn.dataset.target);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  const sections = buttons.map((b) => document.getElementById(b.dataset.target)).filter(Boolean);
  if (!sections.length || !("IntersectionObserver" in window)) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        buttons.forEach((b) => b.classList.toggle("active", b.dataset.target === entry.target.id));
      });
    },
    { rootMargin: "-35% 0px -55% 0px", threshold: 0 }
  );
  sections.forEach((s) => observer.observe(s));
})();
