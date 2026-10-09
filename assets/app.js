(function () {
  const { REQUIRED_COLUMNS, DEFAULT_WEIGHTS, BUCKET_LABELS, parseCSV, scoreSector, buildNoteRecord } = window.SectorScreener;

  const BUCKET_ORDER = Object.keys(DEFAULT_WEIGHTS); // profitability, growth, valuation, momentum, leverage

  // Inline fallback of the sample CSV so "Use sample data" works even when
  // this page is opened directly from disk (file://) rather than served,
  // where a fetch() for assets/sample_it_sector.csv would be blocked by
  // the browser's local-file CORS policy.
  const SAMPLE_CSV = `ticker,name,pe_ratio,pb_ratio,ev_ebitda,roe_pct,roce_pct,net_margin_pct,revenue_growth_yoy_pct,eps_growth_yoy_pct,debt_to_equity,price_return_6m_pct,pct_off_52w_high
TCS.NS,Tata Consultancy Services,27.4,13.8,18.9,45.2,58.1,19.8,6.1,7.9,0.02,4.2,-9.5
INFY.NS,Infosys,24.1,8.6,16.2,29.6,36.4,17.1,5.4,6.8,0.09,-1.8,-14.2
WIPRO.NS,Wipro,22.8,3.4,13.5,16.9,20.1,13.2,3.2,4.1,0.11,-5.6,-19.8
HCLTECH.NS,HCL Technologies,25.6,6.9,15.8,23.4,29.7,15.9,5.8,8.4,0.07,7.1,-6.3
TECHM.NS,Tech Mahindra,29.3,4.8,17.6,14.2,17.5,8.6,1.9,-3.2,0.05,-9.4,-24.1
LTIM.NS,LTIMindtree,32.1,7.2,19.4,22.8,27.9,13.4,7.6,9.5,0.03,11.8,-4.7
MPHASIS.NS,Mphasis,26.9,6.1,15.1,20.3,24.6,14.7,4.5,5.2,0.06,2.9,-11.6
PERSISTENT.NS,Persistent Systems,48.7,12.4,28.3,24.1,29.4,11.9,18.4,22.7,0.04,32.6,-2.1
COFORGE.NS,Coforge,41.2,9.8,22.7,21.6,25.8,10.4,14.2,16.3,0.18,24.3,-3.8
LTTS.NS,L&T Technology Services,34.8,8.9,19.9,25.7,31.2,12.8,9.3,10.1,0.08,-2.4,-16.9`;

  const $ = (id) => document.getElementById(id);
  const sectorNameEl = $("sector-name");
  const topNEl = $("top-n");
  const bottomNEl = $("bottom-n");
  const csvInputEl = $("csv-input");
  const errorBanner = $("error-banner");
  const weightsGrid = $("weights-grid");

  let lastRanked = null;
  let lastMeta = null;
  let lastSectorName = "";
  let lastTopPicks = [];
  let lastBottomPicks = [];

  // ---------- Weight sliders ----------
  const weightState = { ...DEFAULT_WEIGHTS };
  function renderWeightSliders() {
    weightsGrid.innerHTML = "";
    BUCKET_ORDER.forEach((bucket) => {
      const wrap = document.createElement("div");
      wrap.className = "weight-item";
      const pct = Math.round(weightState[bucket] * 100);
      wrap.innerHTML = `
        <div class="weight-item-label">
          <span>${BUCKET_LABELS[bucket][0].toUpperCase() + BUCKET_LABELS[bucket].slice(1)}</span>
          <span class="weight-item-value" data-value-for="${bucket}">${pct}%</span>
        </div>
        <input type="range" min="0" max="100" value="${pct}" data-bucket="${bucket}" />
      `;
      weightsGrid.appendChild(wrap);
    });
    weightsGrid.querySelectorAll("input[type=range]").forEach((input) => {
      input.addEventListener("input", () => {
        const bucket = input.dataset.bucket;
        weightState[bucket] = parseInt(input.value, 10) / 100;
        weightsGrid.querySelector(`[data-value-for="${bucket}"]`).textContent = `${input.value}%`;
      });
    });
  }
  renderWeightSliders();

  function normalizedWeights() {
    const sum = BUCKET_ORDER.reduce((s, b) => s + weightState[b], 0);
    if (sum <= 0) return { ...DEFAULT_WEIGHTS }; // guard: all sliders at 0
    const out = {};
    BUCKET_ORDER.forEach((b) => { out[b] = weightState[b] / sum; });
    return out;
  }

  // ---------- Toolbar actions ----------
  $("load-sample-btn").addEventListener("click", () => {
    csvInputEl.value = SAMPLE_CSV;
    sectorNameEl.value = "Indian IT Services (illustrative demo data)";
    hideError();
  });
  $("clear-btn").addEventListener("click", () => { csvInputEl.value = ""; hideError(); });
  $("csv-upload").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { csvInputEl.value = reader.result; hideError(); };
    reader.onerror = () => showError("Could not read that file — try pasting the CSV contents directly instead.");
    reader.readAsText(file);
  });

  function showError(msg) { errorBanner.textContent = msg; errorBanner.hidden = false; }
  function hideError() { errorBanner.hidden = true; }

  // ---------- Run ----------
  $("run-btn").addEventListener("click", runScreen);

  function runScreen() {
    hideError();
    const csvText = csvInputEl.value.trim();
    if (!csvText) {
      showError("Paste some fundamentals data first, or click \u201cUse sample data\u201d to try it with a demo sector.");
      return;
    }
    const sectorName = sectorNameEl.value.trim() || "Sector Screen";
    const topN = Math.max(1, parseInt(topNEl.value, 10) || 1);
    const bottomN = Math.max(1, parseInt(bottomNEl.value, 10) || 1);

    let rows;
    try {
      rows = parseCSV(csvText);
    } catch (e) {
      showError(e.message + ` Required columns: ${REQUIRED_COLUMNS.join(", ")}.`);
      return;
    }
    if (rows.length < 4) {
      showError(`Only found ${rows.length} data row(s) — the screen needs a real peer set (at least 4-5 names, ideally 15+) for the ranking to mean anything.`);
      return;
    }
    if (topN + bottomN > rows.length) {
      showError(`Top picks (${topN}) + bottom picks (${bottomN}) is more than the ${rows.length} names you gave it. Lower those counts or add more names.`);
      return;
    }

    const weights = normalizedWeights();
    const { rows: ranked, meta } = scoreSector(rows, weights);

    lastRanked = ranked;
    lastMeta = meta;
    lastSectorName = sectorName;
    lastTopPicks = ranked.slice(0, topN).map((r) => buildNoteRecord(r, sectorName));
    lastBottomPicks = ranked.slice(-bottomN).map((r) => buildNoteRecord(r, sectorName));

    renderResults();
    renderNotes();
    $("results-panel").hidden = false;
    $("notes-panel").hidden = false;
    if (typeof $("results-panel").scrollIntoView === "function") {
      $("results-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // ---------- Rendering: ledger ----------
  function renderResults() {
    const buyPct = Math.round((1 - lastMeta.buy_quantile) * 100);
    const sellPct = Math.round(lastMeta.sell_quantile * 100);
    $("rating-band-note").textContent =
      `Rating bands are relative to this ${lastMeta.n_names}-name peer set: top ${buyPct}% of scores `
      + `(\u2265 ${lastMeta.buy_cutoff_score.toFixed(2)}) rated BUY, bottom ${sellPct}% (\u2264 ${lastMeta.sell_cutoff_score.toFixed(2)}) rated SELL, rest HOLD.`;

    const sampleWarning = $("sample-warning");
    if (lastMeta.small_sample) {
      sampleWarning.hidden = false;
      sampleWarning.textContent =
        `Small sample: only ${lastMeta.n_names} names screened (recommended minimum ~${lastMeta.min_recommended_sample}). `
        + `Percentile bands are noisy at this size — rows marked "Borderline" are within ${lastMeta.borderline_margin} composite-score points of a cutoff and should be read as tentative.`;
    } else {
      sampleWarning.hidden = true;
    }

    const counts = { BUY: 0, HOLD: 0, SELL: 0 };
    lastRanked.forEach((r) => { counts[r.screen_rating]++; });
    $("rating-summary").innerHTML = `
      <span class="rating-chip buy">${counts.BUY} BUY</span>
      <span class="rating-chip hold">${counts.HOLD} HOLD</span>
      <span class="rating-chip sell">${counts.SELL} SELL</span>
    `;

    const maxAbs = Math.max(...lastRanked.map((r) => Math.abs(r.composite_score)), 0.01);
    const ledger = $("ledger");
    ledger.innerHTML = lastRanked.map((r) => {
      const ratingClass = r.screen_rating.toLowerCase();
      const widthPct = (Math.abs(r.composite_score) / maxAbs) * 50; // half-track max, since axis is centered
      const barStyle = r.composite_score >= 0
        ? `left:50%; width:${widthPct}%;`
        : `right:50%; width:${widthPct}%;`;
      return `
        <div class="ledger-row">
          <span class="ledger-rank">${r.rank}</span>
          <div class="ledger-name-col">
            <span class="ledger-ticker">${escapeHtml(r.ticker)}</span>
            <span class="ledger-name">${escapeHtml(r.name)}${r.borderline ? '<span class="ledger-borderline">BORDERLINE</span>' : ""}</span>
          </div>
          <div class="ledger-bar-track">
            <div class="ledger-bar-axis"></div>
            <div class="ledger-bar-fill ${ratingClass}" style="${barStyle}"></div>
          </div>
          <div class="ledger-score-col">
            <span class="ledger-score">${r.composite_score.toFixed(2)}</span>
            <span class="ledger-rating ${ratingClass}">${r.screen_rating}</span>
          </div>
        </div>
      `;
    }).join("");
  }

  // ---------- Rendering: note cards ----------
  function noteCardHtml(rec) {
    const ratingClass = rec.rating.toLowerCase();
    const metricsHtml = Object.entries(rec.metrics).map(([k, v]) => `
      <div class="metric-cell"><span class="k">${k}</span><span class="v">${v}</span></div>
    `).join("");
    return `
      <article class="note-card">
        <div class="note-card-header">
          <span class="note-card-name">${escapeHtml(rec.name)}</span>
          <span class="note-card-ticker">${escapeHtml(rec.ticker)}</span>
          <span class="note-card-badge ${ratingClass}">${rec.rating}</span>
        </div>
        <p class="note-card-sub">Sector rank ${rec.rank} &middot; Composite score ${rec.composite_score}${rec.borderline ? ' &middot; <span class="borderline-tag">Borderline call</span>' : ""}</p>
        <p class="note-section-label">Thesis</p>
        <p class="thesis">${escapeHtml(rec.thesis)}</p>
        <p class="note-section-label">Key metrics</p>
        <div class="metrics-grid">${metricsHtml}</div>
        <p class="note-section-label">Catalysts</p>
        <ul>${rec.catalysts.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
        <p class="note-section-label">Key risks</p>
        <ul>${rec.risks.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
      </article>
    `;
  }
  function renderNotes() {
    $("top-notes").innerHTML = lastTopPicks.map(noteCardHtml).join("");
    $("bottom-notes").innerHTML = lastBottomPicks.map(noteCardHtml).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- Downloads ----------
  function downloadBlob(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  $("download-csv-btn").addEventListener("click", () => {
    if (!lastRanked) return;
    const cols = ["rank", "ticker", "name", "composite_score", "screen_rating", "borderline",
      "score_valuation", "score_profitability", "score_growth", "score_leverage", "score_momentum"];
    const lines = [cols.join(",")];
    lastRanked.forEach((r) => {
      lines.push(cols.map((c) => (typeof r[c] === "number" ? r[c].toFixed(4) : r[c])).join(","));
    });
    downloadBlob("ranked_sector.csv", lines.join("\n"), "text/csv");
  });

  $("download-md-btn").addEventListener("click", () => {
    if (!lastRanked) return;
    const lines = [`# ${lastSectorName} — Written Stock Calls\n`];
    if (lastMeta.small_sample) {
      lines.push(`> Small sample: only ${lastMeta.n_names} names screened (recommended minimum ~${lastMeta.min_recommended_sample}). Borderline calls should be read as tentative.\n`);
    }
    lines.push("## Top Picks\n");
    lastTopPicks.forEach((rec) => lines.push(noteMarkdown(rec)));
    lines.push("## Bottom Picks\n");
    lastBottomPicks.forEach((rec) => lines.push(noteMarkdown(rec)));
    downloadBlob("stock_notes.md", lines.join("\n"), "text/markdown");
  });

  function noteMarkdown(rec) {
    const lines = [];
    lines.push(`### ${rec.name} (${rec.ticker}) — ${rec.rating}`);
    lines.push(`*Sector rank ${rec.rank} | Composite score ${rec.composite_score}${rec.borderline ? " | Borderline call" : ""}*\n`);
    lines.push(`**Thesis.** ${rec.thesis}\n`);
    lines.push("**Key metrics**\n");
    lines.push("| Metric | Value |");
    lines.push("|---|---|");
    Object.entries(rec.metrics).forEach(([k, v]) => lines.push(`| ${k} | ${v} |`));
    lines.push("");
    lines.push("**Catalysts**");
    rec.catalysts.forEach((c) => lines.push(`- ${c}`));
    lines.push("\n**Key risks**");
    rec.risks.forEach((r) => lines.push(`- ${r}`));
    lines.push("\n---\n");
    return lines.join("\n");
  }

  $("download-docx-btn").addEventListener("click", async () => {
    if (!lastRanked) return;
    const statusEl = $("download-status");
    statusEl.textContent = "Building Word document\u2026";
    try {
      const docx = await import("https://cdn.jsdelivr.net/npm/docx@8.5.0/+esm");
      const blob = await buildDocx(docx, lastRanked, lastMeta, lastSectorName, lastTopPicks, lastBottomPicks, normalizedWeights());
      downloadBlob(`${lastSectorName.replace(/[^a-z0-9]+/gi, "_")}_report.docx`, blob, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      statusEl.textContent = "Downloaded.";
    } catch (e) {
      console.error(e);
      statusEl.textContent = "Couldn't build the Word doc (needs an internet connection to load the docx library) — try Markdown instead.";
    }
    setTimeout(() => { statusEl.textContent = ""; }, 5000);
  });

  async function buildDocx(docx, ranked, meta, sectorName, topPicks, bottomPicks, weights) {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType, PageBreak } = docx;
    const RATING_COLOR = { BUY: "1B7A3D", HOLD: "946F00", SELL: "B3261E" };
    const PAGE_W = 12240, PAGE_H = 15840, MARGIN = 1080, CONTENT_W = PAGE_W - 2 * MARGIN;

    const weightLine = Object.entries(weights).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k[0].toUpperCase() + k.slice(1)} ${Math.round(v * 100)}%`).join(" \u00b7 ");
    const buyPct = Math.round((1 - meta.buy_quantile) * 100);
    const sellPct = Math.round(meta.sell_quantile * 100);
    const methodology = `Every name is scored on five factor buckets using metrics z-scored across the peer set. `
      + `"Lower is better" metrics (P/E, P/B, EV/EBITDA, Debt/Equity) are sign-flipped so a higher bucket score `
      + `always means better. The top ${buyPct}% of names by composite score is rated BUY (score >= ${meta.buy_cutoff_score.toFixed(2)}), `
      + `the bottom ${sellPct}% SELL (score <= ${meta.sell_cutoff_score.toFixed(2)}), rest HOLD -- percentile bands over `
      + `this specific peer set, not fixed absolute thresholds.`;

    function metricsTable(metrics) {
      const entries = Object.entries(metrics);
      const colW = Math.floor(CONTENT_W / 2);
      const rows = [];
      for (let i = 0; i < entries.length; i += 2) {
        const pair = [entries[i], entries[i + 1]];
        rows.push(new TableRow({ children: pair.map((e) => {
          if (!e) return new TableCell({ width: { size: colW, type: WidthType.DXA }, children: [new Paragraph("")] });
          const [k, v] = e;
          return new TableCell({
            width: { size: colW, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill: "F7F7F7" },
            margins: { top: 60, bottom: 60, left: 120, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: k + ": ", bold: true, size: 19 }), new TextRun({ text: String(v), size: 19 })] })],
          });
        }) }));
      }
      return new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [colW, colW], rows });
    }

    function summaryTable(rows) {
      const headers = ["Rank", "Ticker", "Name", "Score", "Rating"];
      const widths = [700, 1600, 4200, 1200, 1400];
      const headerRow = new TableRow({ children: headers.map((h, i) => new TableCell({
        width: { size: widths[i], type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: "2B2B2B" },
        margins: { top: 80, bottom: 80, left: 100, right: 100 },
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: "FFFFFF", size: 19 })] })],
      })) });
      const dataRows = rows.map((r) => new TableRow({ children: [
        String(r.rank), r.ticker, r.name, r.composite_score.toFixed(2), r.screen_rating,
      ].map((val, i) => new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: i === 4 ? "FFFFFF" : "FFFFFF" },
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new Paragraph({ children: [new TextRun({ text: val, size: 19, bold: i === 4, color: i === 4 ? RATING_COLOR[val] : "000000" })] })],
      })) }));
      return new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: widths, rows: [headerRow, ...dataRows] });
    }

    function stockSection(pick) {
      const children = [];
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 80 }, children: [
        new TextRun({ text: `${pick.name} `, bold: true, size: 26 }),
        new TextRun({ text: `(${pick.ticker})  `, size: 22, color: "666666" }),
        new TextRun({ text: ` ${pick.rating} `, bold: true, color: "FFFFFF", size: 22, shading: { type: ShadingType.CLEAR, fill: RATING_COLOR[pick.rating] } }),
      ] }));
      const subtitle = [new TextRun({ text: `Sector rank ${pick.rank} \u00b7 Composite score ${pick.composite_score}`, italics: true, size: 19, color: "777777" })];
      if (pick.borderline) subtitle.push(new TextRun({ text: "   Borderline call", italics: true, bold: true, size: 19, color: "AA6600" }));
      children.push(new Paragraph({ children: subtitle, spacing: { after: 140 } }));
      children.push(new Paragraph({ children: [new TextRun({ text: "THESIS", bold: true, size: 20, color: "555555" })], spacing: { before: 100, after: 60 } }));
      children.push(new Paragraph({ children: [new TextRun({ text: pick.thesis, size: 21 })], spacing: { after: 160 } }));
      children.push(new Paragraph({ children: [new TextRun({ text: "KEY METRICS", bold: true, size: 20, color: "555555" })], spacing: { before: 100, after: 60 } }));
      children.push(metricsTable(pick.metrics));
      children.push(new Paragraph({ children: [new TextRun({ text: "CATALYSTS", bold: true, size: 20, color: "555555" })], spacing: { before: 160, after: 60 } }));
      pick.catalysts.forEach((c) => children.push(new Paragraph({ children: [new TextRun({ text: c, size: 21 })], bullet: { level: 0 }, spacing: { after: 60 } })));
      children.push(new Paragraph({ children: [new TextRun({ text: "KEY RISKS", bold: true, size: 20, color: "555555" })], spacing: { before: 160, after: 60 } }));
      pick.risks.forEach((r) => children.push(new Paragraph({ children: [new TextRun({ text: r, size: 21 })], bullet: { level: 0 }, spacing: { after: 60 } })));
      children.push(new Paragraph({ border: { bottom: { style: "single", size: 6, color: "CCCCCC", space: 4 } }, spacing: { after: 200 } }));
      return children;
    }

    const doc = new Document({ sections: [{
      properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
      children: [
        new Paragraph({ children: [new TextRun({ text: "SECTOR SCREEN & STOCK CALLS", bold: true, size: 20, color: "888888" })], spacing: { after: 80 } }),
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: sectorName, bold: true, size: 44 })], spacing: { after: 100 } }),
        new Paragraph({ children: [new TextRun({ text: `Quant screen of ${meta.n_names} names \u00b7 Factor weights: ${weightLine}`, size: 20, color: "555555" })], spacing: { after: 60 } }),
        new Paragraph({ children: [new TextRun({ text: "Built with the Sector Screener web tool.", italics: true, size: 18, color: "AA6600" })], spacing: { after: 300 } }),
        new Paragraph({ border: { bottom: { style: "single", size: 6, color: "CCCCCC", space: 4 } }, spacing: { after: 200 } }),
        new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Methodology", spacing: { before: 200, after: 120 } }),
        new Paragraph({ children: [new TextRun({ text: methodology, size: 21 })], spacing: { after: 160 } }),
        ...(meta.small_sample ? [new Paragraph({ children: [
          new TextRun({ text: "Small-sample caveat: ", bold: true, size: 21, color: "AA6600" }),
          new TextRun({ text: `Only ${meta.n_names} names were screened (recommended minimum ~${meta.min_recommended_sample}) -- percentile bands are noisy at this size; borderline calls should be read as tentative.`, size: 21, color: "AA6600" }),
        ], spacing: { after: 200 } })] : []),
        new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Ranked Sector Screen", spacing: { before: 240, after: 120 } }),
        summaryTable(ranked),
        new Paragraph({ children: [new PageBreak()] }),
        new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Top Picks", spacing: { before: 0, after: 120 } }),
        ...topPicks.flatMap(stockSection),
        new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Bottom Picks", spacing: { before: 200, after: 120 } }),
        ...bottomPicks.flatMap(stockSection),
      ],
    }] });

    return Packer.toBlob(doc);
  }
})();
