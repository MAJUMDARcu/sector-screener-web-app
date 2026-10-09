/*
 * engine.js — client-side port of factor_engine.py + note_generator.py
 *
 * This mirrors the Python pipeline exactly (same weights, same z-score
 * math, same rating-band logic, same borderline/small-sample flags, same
 * note-generation fixes) so the web version and the CLI version produce
 * the same analysis for the same input data. See the Python project's
 * README for the full methodology writeup — this file is the JS
 * equivalent of factor_engine.py + note_generator.py combined.
 */

const REQUIRED_COLUMNS = [
  "ticker", "name", "pe_ratio", "pb_ratio", "ev_ebitda",
  "roe_pct", "roce_pct", "net_margin_pct",
  "revenue_growth_yoy_pct", "eps_growth_yoy_pct",
  "debt_to_equity", "price_return_6m_pct", "pct_off_52w_high",
];

const DEFAULT_WEIGHTS = {
  profitability: 0.30,
  growth: 0.25,
  valuation: 0.20,
  momentum: 0.15,
  leverage: 0.10,
};

const RATING_QUANTILES = { buy: 0.70, sell: 0.30 };
const BORDERLINE_MARGIN = 0.05;
const MIN_RECOMMENDED_SAMPLE = 15;

// metric -> [bucket, higherIsBetter]
const METRIC_MAP = {
  pe_ratio: ["valuation", false],
  pb_ratio: ["valuation", false],
  ev_ebitda: ["valuation", false],
  roe_pct: ["profitability", true],
  roce_pct: ["profitability", true],
  net_margin_pct: ["profitability", true],
  revenue_growth_yoy_pct: ["growth", true],
  eps_growth_yoy_pct: ["growth", true],
  debt_to_equity: ["leverage", false],
  price_return_6m_pct: ["momentum", true],
  pct_off_52w_high: ["momentum", true],
};

const BUCKET_LABELS = {
  valuation: "valuation",
  profitability: "profitability",
  growth: "growth",
  leverage: "balance-sheet leverage",
  momentum: "price momentum",
};

const IMPROVE_MAP = {
  valuation: "a re-rating toward peer multiples as the market gives it credit for its fundamentals",
  profitability: "further margin, ROE, or ROCE expansion versus peers",
  growth: "revenue or EPS growth continuing to outpace the peer set",
  leverage: "the balance sheet staying conservative while peers releverage, supporting a premium multiple",
  momentum: "price strength continuing as the market catches up to the fundamentals",
};
const DETERIORATE_MAP = {
  valuation: "a de-rating if growth or profitability disappoints and closes the current gap to peers",
  profitability: "margin, ROE, or ROCE compression versus peers",
  growth: "revenue or EPS growth decelerating faster than the peer set",
  leverage: "leverage rising further without a commensurate return on the added debt",
  momentum: "price momentum fading or reversing versus peers",
};

// ---------- CSV parsing ----------
// Deliberately simple: splits on commas, no quoted-field support. Fine for
// plain numeric fundamentals data; if a company name ever needs a comma,
// edit that cell to avoid one (e.g. "L&T Technology Services", not "L&T, Tech").
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV needs a header row plus at least one data row.");
  const headers = lines[0].split(",").map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length) {
    throw new Error(`Missing required column(s): ${missing.join(", ")}`);
  }
  const rows = lines.slice(1).map((line, idx) => {
    const cells = line.split(",").map((c) => c.trim());
    const row = {};
    headers.forEach((h, i) => {
      if (!REQUIRED_COLUMNS.includes(h)) return;
      const raw = cells[i];
      if (h === "ticker" || h === "name") {
        row[h] = raw ?? "";
      } else {
        const v = raw === undefined || raw === "" ? NaN : parseFloat(raw);
        row[h] = v;
      }
    });
    row.__rowNum = idx + 2; // +2: header row + 1-indexing, for error messages
    return row;
  });
  return rows;
}

// ---------- Factor scoring ----------
function mean(values) {
  const v = values.filter((x) => !Number.isNaN(x));
  if (!v.length) return NaN;
  return v.reduce((a, b) => a + b, 0) / v.length;
}
function std(values, m) {
  const v = values.filter((x) => !Number.isNaN(x));
  if (v.length < 1) return NaN;
  const variance = v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length; // population std, matches pandas ddof=0
  return Math.sqrt(variance);
}
function zscore(values) {
  const m = mean(values);
  const s = std(values, m);
  if (Number.isNaN(s) || s === 0) return values.map(() => 0);
  return values.map((x) => (Number.isNaN(x) ? 0 : (x - m) / s));
}

// Linear-interpolation quantile, matching pandas'/numpy's default method.
function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function scoreSector(rawRows, weights = DEFAULT_WEIGHTS) {
  const rows = rawRows.map((r) => ({ ...r }));
  const buckets = Object.keys(weights);

  const bucketZCols = {};
  buckets.forEach((b) => { bucketZCols[b] = []; });

  Object.entries(METRIC_MAP).forEach(([metric, [bucket, higherIsBetter]]) => {
    const values = rows.map((r) => r[metric]);
    let z = zscore(values);
    if (!higherIsBetter) z = z.map((x) => -x);
    rows.forEach((r, i) => { r[`z_${metric}`] = z[i]; });
    if (bucketZCols[bucket]) bucketZCols[bucket].push(`z_${metric}`);
  });

  buckets.forEach((b) => {
    const cols = bucketZCols[b];
    rows.forEach((r) => {
      r[`score_${b}`] = cols.length ? mean(cols.map((c) => r[c])) : 0;
    });
  });

  rows.forEach((r) => {
    r.composite_score = buckets.reduce((sum, b) => sum + r[`score_${b}`] * weights[b], 0);
  });

  rows.sort((a, b) => b.composite_score - a.composite_score);
  rows.forEach((r, i) => { r.rank = i + 1; });

  const scores = rows.map((r) => r.composite_score);
  const qHi = quantile(scores, RATING_QUANTILES.buy);
  const qLo = quantile(scores, RATING_QUANTILES.sell);

  rows.forEach((r) => {
    if (r.composite_score >= qHi) r.screen_rating = "BUY";
    else if (r.composite_score <= qLo) r.screen_rating = "SELL";
    else r.screen_rating = "HOLD";
    r.borderline = Math.abs(r.composite_score - qHi) <= BORDERLINE_MARGIN
      || Math.abs(r.composite_score - qLo) <= BORDERLINE_MARGIN;
  });

  const n = rows.length;
  const meta = {
    n_names: n,
    small_sample: n < MIN_RECOMMENDED_SAMPLE,
    min_recommended_sample: MIN_RECOMMENDED_SAMPLE,
    buy_cutoff_score: Math.round(qHi * 10000) / 10000,
    sell_cutoff_score: Math.round(qLo * 10000) / 10000,
    buy_quantile: RATING_QUANTILES.buy,
    sell_quantile: RATING_QUANTILES.sell,
    borderline_margin: BORDERLINE_MARGIN,
  };

  return { rows, meta };
}

// ---------- Note generation ----------
function strengthWeakness(row) {
  const buckets = Object.keys(BUCKET_LABELS);
  let strongest = buckets[0], weakest = buckets[0];
  buckets.forEach((b) => {
    if (row[`score_${b}`] > row[`score_${strongest}`]) strongest = b;
    if (row[`score_${b}`] < row[`score_${weakest}`]) weakest = b;
  });
  return { strongest, weakest };
}

function valuationPhrase(row) {
  if (row.score_valuation > 0.5) return `trading cheap versus peers at ${row.pe_ratio.toFixed(1)}x P/E and ${row.ev_ebitda.toFixed(1)}x EV/EBITDA`;
  if (row.score_valuation < -0.5) return `trading rich versus peers at ${row.pe_ratio.toFixed(1)}x P/E and ${row.ev_ebitda.toFixed(1)}x EV/EBITDA`;
  return `trading roughly in line with peers at ${row.pe_ratio.toFixed(1)}x P/E and ${row.ev_ebitda.toFixed(1)}x EV/EBITDA`;
}
function profitabilityPhrase(row) {
  return `an ROE of ${row.roe_pct.toFixed(1)}%, ROCE of ${row.roce_pct.toFixed(1)}%, and a net margin of ${row.net_margin_pct.toFixed(1)}%`;
}
function growthPhrase(row) {
  return `revenue growth of ${row.revenue_growth_yoy_pct.toFixed(1)}% YoY and EPS growth of ${row.eps_growth_yoy_pct.toFixed(1)}% YoY`;
}
function leveragePhrase(row) {
  const de = row.debt_to_equity;
  if (de < 0.15) return `a conservative balance sheet (D/E ${de.toFixed(2)}x)`;
  if (de < 0.4) return `moderate leverage (D/E ${de.toFixed(2)}x)`;
  return `elevated leverage relative to the sector (D/E ${de.toFixed(2)}x)`;
}
function momentumPhrase(row) {
  const r6m = row.price_return_6m_pct;
  const offHigh = row.pct_off_52w_high;
  const trend = r6m >= 0 ? "up" : "down";
  let highPhrase;
  if (offHigh >= 0) {
    highPhrase = offHigh === 0 ? "sitting at a fresh 52-week high" : `trading ${offHigh.toFixed(1)}% above its recorded 52-week high`;
  } else {
    highPhrase = `sitting ${Math.abs(offHigh).toFixed(1)}% below its 52-week high`;
  }
  return `${trend} ${Math.abs(r6m).toFixed(1)}% over six months and ${highPhrase}`;
}
const PHRASE_FN = {
  valuation: valuationPhrase,
  profitability: profitabilityPhrase,
  growth: growthPhrase,
  leverage: leveragePhrase,
  momentum: momentumPhrase,
};

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function borderlineCaveat(row) {
  if (!row.borderline) return "";
  return " This call sits close to the cutoff versus the neighboring rating band — with a peer set this size, a small data revision could flip it, so treat it as the tentative end of the range rather than a high-conviction call.";
}

function buildThesis(row, sectorName, strongest, weakest) {
  const rating = row.screen_rating;
  const valuationIsExtremal = strongest === "valuation" || weakest === "valuation";
  const valuationAside = valuationIsExtremal ? "" : ` On valuation, it's ${valuationPhrase(row)}.`;
  const caveat = borderlineCaveat(row);

  if (rating === "BUY") {
    return `${row.name} screens at the top of the ${sectorName} peer set, anchored by standout `
      + `${BUCKET_LABELS[strongest]} — ${PHRASE_FN[strongest](row)}.${valuationAside} `
      + `Main watch-item for the call: ${BUCKET_LABELS[weakest]} — the weak point is ${PHRASE_FN[weakest](row)}.${caveat}`;
  }
  if (rating === "SELL") {
    return `${row.name} screens at the bottom of the ${sectorName} peer set, dragged down by weak `
      + `${BUCKET_LABELS[weakest]} — ${PHRASE_FN[weakest](row)}.${valuationAside} Even where the stock `
      + `looks better, on ${BUCKET_LABELS[strongest]} (${PHRASE_FN[strongest](row)}), it isn't enough on `
      + `its own to offset the broader shortfall. Reduce/avoid until the weak factor(s) show a clear inflection.${caveat}`;
  }
  return `${row.name} sits in the middle of the ${sectorName} peer set — no single factor is a strong `
    + `enough outlier to force a directional call.${valuationAside} It stands out most on `
    + `${BUCKET_LABELS[strongest]} (${PHRASE_FN[strongest](row)}) and lags most on ${BUCKET_LABELS[weakest]} `
    + `(${PHRASE_FN[weakest](row)}). Hold pending a clearer signal in either direction.${caveat}`;
}

function catalystsAndRisks(rating, strongest, weakest) {
  if (rating === "BUY") {
    const catalysts = [cap(IMPROVE_MAP[strongest]) + "."];
    if (strongest !== "valuation") catalysts.push(cap(IMPROVE_MAP.valuation) + ".");
    const risks = [cap(DETERIORATE_MAP[weakest]) + "."];
    return { catalysts, risks };
  }
  if (rating === "SELL") {
    const catalysts = [cap(IMPROVE_MAP[weakest]) + "."];
    const risks = [cap(DETERIORATE_MAP[weakest]) + "."];
    if (strongest !== weakest) risks.push(`${cap(DETERIORATE_MAP[strongest])}, removing the one offsetting positive.`);
    return { catalysts, risks };
  }
  return {
    catalysts: [cap(IMPROVE_MAP[weakest]) + "."],
    risks: [cap(DETERIORATE_MAP[strongest]) + "."],
  };
}

function buildNoteRecord(row, sectorName) {
  const { strongest, weakest } = strengthWeakness(row);
  const rating = row.screen_rating;
  const thesis = buildThesis(row, sectorName, strongest, weakest);
  const { catalysts, risks } = catalystsAndRisks(rating, strongest, weakest);

  return {
    ticker: row.ticker, name: row.name, rating, rank: row.rank,
    composite_score: Math.round(row.composite_score * 100) / 100,
    borderline: !!row.borderline,
    thesis, catalysts, risks,
    metrics: {
      "P/E": `${row.pe_ratio.toFixed(1)}x`,
      "P/B": `${row.pb_ratio.toFixed(1)}x`,
      "EV/EBITDA": `${row.ev_ebitda.toFixed(1)}x`,
      "ROE": `${row.roe_pct.toFixed(1)}%`,
      "ROCE": `${row.roce_pct.toFixed(1)}%`,
      "Net margin": `${row.net_margin_pct.toFixed(1)}%`,
      "Revenue growth (YoY)": `${row.revenue_growth_yoy_pct.toFixed(1)}%`,
      "EPS growth (YoY)": `${row.eps_growth_yoy_pct.toFixed(1)}%`,
      "Debt/Equity": `${row.debt_to_equity.toFixed(2)}x`,
      "6M price return": `${row.price_return_6m_pct.toFixed(1)}%`,
      "Off 52W high": `${row.pct_off_52w_high.toFixed(1)}%`,
    },
  };
}

window.SectorScreener = {
  REQUIRED_COLUMNS, DEFAULT_WEIGHTS, BUCKET_LABELS,
  parseCSV, scoreSector, buildNoteRecord,
};
