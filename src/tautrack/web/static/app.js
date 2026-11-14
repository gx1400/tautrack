/* tautrack client.
 *
 * Read-only. Charts are uPlot (Q6); the sky view is hand-drawn SVG because it needs
 * semantics a generic polar scatter does not provide: per-PRN labels, colour by
 * signal, tracked-vs-acquiring, and the elevation-mask ring.
 */
"use strict";

const SPAN_SECONDS = {
  "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "6h": 21600, "12h": 43200,
  "24h": 86400, "3d": 259200, "1w": 604800, "2w": 1209600,
  "1mo": 2592000, "6mo": 15552000, "1y": 31536000,
};

const state = {
  span: "1h",
  charts: new Map(),   // metric -> {plot, host, card}
  trails: false,
  satPlot: null,       // the per-PRN signal chart
  satIndex: new Map(), // prn -> series index, for hover focus from the table
  states: [],          // mode spans for the current window, shared by every chart
  adevPlot: null,
};

/* Lock state drives both the strip and the bands behind every sparkline, so the
 * colours live in one place. Locked is deliberately unshaded: it is the normal
 * condition and shading it would tint the entire chart on a healthy day, which
 * carries no information and makes the exceptions harder to see. */
const MODE_STYLE = [
  { match: "holdover", label: "Holdover", colour: "#d1242f" },
  { match: "recovery", label: "Recovery", colour: "#bf8700" },
  { match: "power-up", label: "Power-up", colour: "#8b949e" },
  { match: "locked",   label: "Locked",   colour: null },
];
const modeStyle = (text) => {
  const t = (text || "").toLowerCase();
  return MODE_STYLE.find((m) => t.includes(m.match)) || { label: text || "unknown", colour: "#8b949e" };
};

/* Distinct hues for up to a dozen simultaneous satellites. Chosen to stay separable
 * in both themes and to avoid the red reserved for faults. */
const PRN_COLOURS = [
  "#4aa3ff", "#3fb950", "#d29922", "#a371f7", "#1f9ec4", "#e06c9f",
  "#7ec699", "#f0883e", "#6cb6ff", "#c9a227", "#8b949e", "#56d4dd",
];
const prnColour = (i) => PRN_COLOURS[i % PRN_COLOURS.length];

/* Every chart joins one cursor group, so hovering any of them draws the crosshair at
 * the same instant on all the others. Reading a spike in one metric is only half the
 * question - the other half is what every other metric was doing at that moment.
 * Only the x scale is shared; the y scales carry different units and must not be. */
const CURSOR_SYNC = uPlot.sync("tautrack");
const syncCursor = () => ({
  key: CURSOR_SYNC.key,
  // Series focus stays local: hovering a sparkline must not reach over and change
  // which satellite is highlighted on the per-PRN chart.
  setSeries: false,
  scales: ["x", null],
});

// Metric help, embedded by the server so tiles can be labelled on first paint.
const HELP = (() => {
  try {
    return JSON.parse(document.getElementById("metric-help").textContent);
  } catch {
    return {};
  }
})();

/* Help popover. A title attribute alone would be invisible on a phone, where there is
 * no hover - hence an explicit button that works for touch, keyboard and mouse alike. */
const pop = {
  el: null,
  show(btn) {
    const key = btn.dataset.help;
    const h = HELP[key];
    if (!h) return;
    if (!this.el) {
      this.el = document.getElementById("help-pop");
      document.getElementById("help-pop-title").textContent = "";
    }
    document.getElementById("help-pop-title").textContent = h.title || key;
    document.getElementById("help-pop-text").textContent = h.text || "";
    this.el.hidden = false;
    // Place below the control, nudged inside the viewport on narrow screens.
    const r = btn.getBoundingClientRect();
    const w = Math.min(340, window.innerWidth - 24);
    this.el.style.width = w + "px";
    let left = r.left + window.scrollX;
    left = Math.min(left, window.scrollX + window.innerWidth - w - 12);
    left = Math.max(left, window.scrollX + 12);
    this.el.style.left = left + "px";
    this.el.style.top = r.bottom + window.scrollY + 8 + "px";
    this.current = btn;
  },
  hide() {
    if (this.el) this.el.hidden = true;
    this.current = null;
  },
};

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".help-btn");
  if (btn) {
    e.preventDefault();
    e.stopPropagation();
    if (pop.current === btn) pop.hide();
    else pop.show(btn);
    return;
  }
  if (!e.target.closest(".help-pop")) pop.hide();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") pop.hide();
});

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

async function getJSON(url) {
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

function fmt(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  if (a >= 100000) return v.toExponential(2);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(a < 1 ? 3 : digits);
}

/* ------------------------------------------------------------------ status */

function stateClass(mode) {
  if (!mode) return "";
  if (/^Locked/i.test(mode)) return "ok";
  if (/Holdover/i.test(mode)) return "bad";
  if (/Recovery|stabiliz/i.test(mode)) return "warn";
  return "";
}

function tile(label, value, sub, cls, helpKey) {
  const d = document.createElement("div");
  d.className = "tile" + (cls ? " " + cls : "");
  d.innerHTML =
    `<div class="label"></div><div class="value"></div><div class="sub"></div>`;
  const labelEl = d.querySelector(".label");
  labelEl.textContent = label;
  const h = helpKey ? HELP[helpKey] : null;
  if (h) {
    // Native title for a quick mouse hover, plus a button that also works on touch.
    d.title = `${h.title}\n\n${h.text}`;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "help-btn";
    b.dataset.help = helpKey;
    b.setAttribute("aria-label", `About ${h.title}`);
    b.innerHTML = "&#9432;";
    labelEl.append(b);
  }
  d.querySelector(".value").textContent = value;
  d.querySelector(".sub").textContent = sub || "";
  return d;
}

function renderStatus(s) {
  const dot = document.getElementById("conn-dot");
  const txt = document.getElementById("conn-text");
  dot.className = "dot " + (s.connected ? "ok" : "bad");
  txt.textContent = s.connected ? "polling" : (s.last_error ? "disconnected" : "waiting");

  document.getElementById("device").textContent = s.device
    ? `${s.device.model || "?"}  ·  S/N ${s.device.serial || "?"}  ·  fw ${s.device.firmware || "?"}`
    : "no device has reported yet";

  const L = s.latest || {};
  const num = (k) => (L[k] ? L[k].value : null);
  const str = (k) => (L[k] ? L[k].text : null);

  const tiles = document.getElementById("tiles");
  tiles.textContent = "";

  const mode = str("mode");
  tiles.append(tile("SmartClock", mode || "—", str("sync_banner") || "", stateClass(mode), "mode"));

  const ffom = num("ffom"), tfom = num("tfom");
  tiles.append(tile("FFOM / TFOM", `${fmt(ffom)} / ${fmt(tfom)}`,
    ffom === 0 ? "loop settled" : "settling", ffom === 0 ? "ok" : "warn", "ffom"));

  const ti = num("pps_ti_ns");
  tiles.append(tile("1PPS offset", ti === null ? "—" : `${fmt(ti, 1)} ns`,
    ti === null ? "unavailable while unlocked" : "vs GPS", "", "pps_ti_ns"));

  tiles.append(tile("EFC", `${fmt(num("efc_percent"), 4)} %`,
    num("efc_dac") !== null ? `DAC ${fmt(num("efc_dac"))}` : "", "", "efc_percent"));

  const trk = num("satellites_tracked");
  tiles.append(tile("Satellites", fmt(trk),
    num("satellites_visible") !== null ? `${fmt(num("satellites_visible"))} visible` : "",
    trk >= 4 ? "ok" : (trk >= 1 ? "warn" : "bad"), "satellites_tracked"));

  const pm = str("position_mode");
  tiles.append(tile("Position", pm || "—", str("survey_blocked") || "", "", "position_mode"));

  // While the unit is actually in holdover the forecast is the less interesting
  // number: what matters is how long this episode has run and what it has cost.
  const pred = num("holdover_predict_us_24h");
  const hdur = num("holdover_duration_s");
  const hnow = num("holdover_present_us");
  if (hdur) {
    const mins = Math.floor(hdur / 60), secs = Math.round(hdur % 60);
    tiles.append(tile("In holdover",
      mins ? `${mins}m ${secs}s` : `${secs}s`,
      hnow === null ? `${fmt(pred, 1)} µs/24h predicted` : `${fmt(hnow, 2)} µs accrued`,
      "warn", "holdover_present_us"));
  } else {
    tiles.append(tile("Holdover predict", pred === null ? "—" : `${fmt(pred, 1)} µs`,
      "per 24 h", "", "holdover_predict_us_24h"));
  }

  // The unit keeps its own diagnostic log. We cannot read the entries over the
  // commands we allow ourselves, but the count tells us when it wrote one - which is
  // otherwise invisible, including for anything that happened while we were
  // disconnected.
  const diag = num("diag_log_count");
  if (diag !== null) {
    if (state.diagSeen === undefined) state.diagSeen = diag;
    const added = diag - state.diagSeen;
    tiles.append(tile("Diagnostic log", `${fmt(diag)}`,
      added > 0 ? `+${fmt(added)} since page load` : "entries logged by the unit",
      added > 0 ? "warn" : "", "diag_log_count"));
  }

  const health = num("health_ok");
  tiles.append(tile("Health", health === null ? "—" : (health ? "OK" : "FAULT"),
    str("health_detail") || "", health === null ? "" : (health ? "ok" : "bad"),
    "health_ok"));

  // Clocks. All unit-derived values share one format so they compare by eye.
  const c = s.clocks || {};
  document.getElementById("clk-unit").textContent = c.unit_reported || "—";
  document.getElementById("clk-unit-note").textContent = c.unit_unconfirmed
    ? "time not yet confirmed by GPS"
    : "verbatim, date affected by rollover";
  document.getElementById("clk-utc").textContent = c.unit_corrected_utc || "—";
  document.getElementById("clk-local").textContent = c.unit_corrected_local || "—";
  document.getElementById("clk-local-note").textContent =
    c.rollover_days ? `offset ${c.rollover_days} d applied` : "no rollover offset";
  document.getElementById("clk-tzname").textContent = c.zone_label || c.timezone || "";

  document.getElementById("clk-host").textContent =
    c.host_local ? `${c.host_local} ${c.zone_label || ""}`.trim() : "—";

  // The delta is only meaningful against a live device. Under replay it is just the
  // age of the recorded screen, so say so rather than implying instrument error.
  const deltaEl = document.getElementById("clk-delta");
  if (c.host_delta_seconds === null || c.host_delta_seconds === undefined) {
    deltaEl.textContent = "";
    deltaEl.className = "hostclock-delta";
  } else if (c.live === false) {
    deltaEl.textContent = `replay — recorded ${humanDelta(c.host_delta_seconds)} ago`;
    deltaEl.className = "hostclock-delta replay";
  } else {
    const d = c.host_delta_seconds;
    deltaEl.textContent = `unit ${d >= 0 ? "behind" : "ahead of"} host by ${humanDelta(Math.abs(d))}`;
    deltaEl.className = "hostclock-delta " + (Math.abs(d) <= 2 ? "ok" : "warn");
  }
}

function humanDelta(seconds) {
  const s = Math.round(Math.abs(seconds));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/* ------------------------------------------------------------------ charts */

/* Shows the value under the cursor. Without this a sparkline can be read for shape
 * but not for magnitude, which is half of why anyone looks at one. */
function cursorTooltip(unit) {
  let tip;
  return {
    hooks: {
      init: (u) => {
        tip = document.createElement("div");
        tip.className = "u-tip";
        tip.hidden = true;
        u.over.appendChild(tip);
      },
      setCursor: (u) => {
        const i = u.cursor.idx;
        if (i === null || i === undefined) {
          tip.hidden = true;
          return;
        }
        const x = u.data[0][i];
        const y = u.data[1][i];
        if (y === null || y === undefined) {
          tip.hidden = true;
          return;
        }
        // Charts sample at different cadences, so the synced index can land on a point
        // well away from the pointer's actual time. Suppress the tooltip rather than
        // report a value from the wrong moment.
        if (u.cursor.sync && u.cursor.sync.scales) {
          const want = u.posToVal(u.cursor.left, "x");
          const slack = Math.max((u.scales.x.max - u.scales.x.min) / 60, 1);
          if (Number.isFinite(want) && Math.abs(x - want) > slack) {
            tip.hidden = true;
            return;
          }
        }
        const when = new Date(x * 1000).toLocaleString([], {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
        const lo = u.data[2] ? u.data[2][i] : null;
        const hi = u.data[3] ? u.data[3][i] : null;
        // On downsampled spans the band matters more than the mean, so show it.
        const range = (lo !== null && hi !== null && lo !== undefined && hi !== undefined)
          ? `<br><span class="u-tip-range">min ${fmt(lo)} / max ${fmt(hi)}</span>` : "";
        tip.innerHTML = `<b>${fmt(y)}</b> ${unit || ""}<br><span class="u-tip-when">${when}</span>${range}`;
        tip.hidden = false;
        const left = u.valToPos(x, "x");
        tip.style.left = Math.min(Math.max(left, 4), u.bbox.width / devicePixelRatio - 4) + "px";
      },
    },
  };
}

/* Shades spans with no data and marks their edges, so an outage reads as missing
 * rather than as a flat measured line. The nulls inserted server-side already break
 * the stroke; this makes the absence legible rather than merely invisible. */
function gapShading(getGaps) {
  return {
    hooks: {
      draw: [(u) => {
        const gaps = getGaps();
        if (!gaps || !gaps.length) return;
        const ctx = u.ctx;
        const top = u.bbox.top;
        const h = u.bbox.height;
        ctx.save();
        for (const [from, to] of gaps) {
          const x0 = u.valToPos(from, "x", true);
          const x1 = u.valToPos(to, "x", true);
          if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue;
          const w = Math.max(x1 - x0, 1);
          ctx.fillStyle = css("--muted") || "#8b98a9";
          ctx.globalAlpha = 0.12;
          ctx.fillRect(x0, top, w, h);
          // Dashed edges, so a gap narrower than a pixel or two is still visible.
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = css("--muted") || "#8b98a9";
          ctx.setLineDash([2, 3]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x0, top); ctx.lineTo(x0, top + h);
          ctx.moveTo(x1, top); ctx.lineTo(x1, top + h);
          ctx.stroke();
        }
        ctx.restore();
      }],
    },
  };
}

/* Shades the periods the unit was not locked, behind the data rather than over it
 * (FR-16, the Smokeping loss-shading analogue). Drawn on drawClear so the series is
 * rendered on top; drawn from the shared span list so all charts agree. */
function stateBands() {
  return {
    hooks: {
      drawClear: [(u) => {
        if (!state.states.length) return;
        const ctx = u.ctx;
        ctx.save();
        for (const sp of state.states) {
          const { colour } = modeStyle(sp.text);
          if (!colour) continue;
          const x0 = u.valToPos(sp.start, "x", true);
          const x1 = u.valToPos(sp.end, "x", true);
          if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue;
          const l = Math.max(x0, u.bbox.left);
          const r = Math.min(x1, u.bbox.left + u.bbox.width);
          if (r <= l) continue;
          ctx.fillStyle = colour;
          ctx.globalAlpha = 0.13;
          ctx.fillRect(l, u.bbox.top, Math.max(r - l, 1), u.bbox.height);
        }
        ctx.restore();
      }],
    },
  };
}

function makePlot(host, title, zeroLine, unit, getGaps) {
  const accent = css("--accent") || "#4aa3ff";
  const grid = css("--line") || "#273041";
  const muted = css("--muted") || "#8b98a9";

  const opts = {
    width: host.clientWidth || 300,
    height: 120,
    padding: [8, 8, 0, 0],
    cursor: { show: true, y: false, drag: { x: false, y: false }, sync: syncCursor() },
    legend: { show: false },
    scales: { x: { time: true } },
    axes: [
      { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid },
        size: 28, font: "10px ui-monospace, monospace" },
      {
        stroke: muted,
        grid: { stroke: grid, width: 1 },
        ticks: { stroke: grid },
        font: "10px ui-monospace, monospace",
        // Size the gutter to the widest label actually drawn. A fixed 44px clipped
        // six-figure values - the raw EFC DAC count rendered as "i9,300" with the
        // leading digits of 809,300 cut off, which is worse than useless.
        size: (u, values) => {
          const widest = (values || []).reduce((m, v) => Math.max(m, String(v).length), 3);
          return Math.min(14 + widest * 6.2, 80);
        },
        // Thousands separators on a six-figure DAC count, which is otherwise a wall
        // of digits; small values keep their decimals.
        values: (u, ticks) =>
          ticks.map((v) =>
            Math.abs(v) >= 10000 ? v.toLocaleString() : String(v),
          ),
      },
    ],
    plugins: [stateBands(), gapShading(getGaps), cursorTooltip(unit)],
    series: [
      {},
      {
        stroke: accent,
        width: 1.6,
        fill: accent + "22",
        points: { show: false },
        // Gaps are real: a transport outage must read as missing data, not as a
        // straight line interpolated across it (FR-6).
        spanGaps: false,
      },
      { stroke: accent + "55", width: 1, points: { show: false }, spanGaps: false },
      { stroke: accent + "55", width: 1, points: { show: false }, spanGaps: false },
      // Optional context series - satellites visible behind satellites tracked.
      // Dashed and muted so it reads as background rather than a second reading.
      {
        stroke: muted,
        width: 1,
        dash: [3, 3],
        points: { show: false },
        spanGaps: false,
      },
    ],
  };
  if (zeroLine) {
    opts.hooks = {
      draw: [(u) => {
        const y = u.valToPos(0, "y", true);
        if (!Number.isFinite(y)) return;
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = muted;
        ctx.globalAlpha = 0.45;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(u.bbox.left, y);
        ctx.lineTo(u.bbox.left + u.bbox.width, y);
        ctx.stroke();
        ctx.restore();
      }],
    };
  }
  return new uPlot(opts, [[], [], [], [], []], host);
}

async function loadChart(card) {
  const metric = card.dataset.metric;
  const host = card.querySelector('[data-role="host"]');
  const lastEl = card.querySelector('[data-role="last"]');
  const resEl = card.querySelector('[data-role="res"]');

  let d;
  try {
    d = await getJSON(`/api/series?metric=${encodeURIComponent(metric)}&span=${state.span}`);
  } catch {
    host.innerHTML = '<div class="empty">no data yet</div>';
    return;
  }

  if (!d.ts || d.ts.length === 0) {
    host.innerHTML = '<div class="empty">no data in this window</div>';
    state.charts.delete(metric);
    lastEl.textContent = "—";
    resEl.textContent = "";
    return;
  }

  // Say which storage tier answered rather than implying raw fidelity over a year.
  // A derived series says which statistic it is; a stored one says which tier answered.
  const resText = d.stat ? d.stat : (d.resolution === "raw" ? "" :
    (d.resolution === "hour" ? "hourly min/avg/max" : "daily min/avg/max"));
  const nGaps = (d.gaps || []).length;
  resEl.textContent = nGaps
    ? (resText ? `${resText} · ${nGaps} gap${nGaps > 1 ? "s" : ""}` : `${nGaps} gap${nGaps > 1 ? "s" : ""}`)
    : resText;
  resEl.title = nGaps ? "Shaded bands mark periods with no data" : "";

  const vals = d.value.map((v) => (v === null ? null : v));
  const series = [d.ts, vals];
  // Trends carry min and max so a brief excursion stays visible after downsampling.
  series.push(d.min ? d.min : vals.map(() => null));
  series.push(d.max ? d.max : vals.map(() => null));

  // Optional context line on the same axis. Fetched separately and aligned onto this
  // chart's timestamps, because the two metrics are not guaranteed to share samples.
  const overlay = card.dataset.overlay;
  let over = vals.map(() => null);
  if (overlay) {
    try {
      const o = await getJSON(
        `/api/series?metric=${encodeURIComponent(overlay)}&span=${state.span}`);
      const at = new Map(o.ts.map((t, i) => [t, o.value[i]]));
      let last = null;
      over = d.ts.map((t) => {
        if (at.has(t)) last = at.get(t);
        return last;
      });
    } catch { /* the context line is optional; the chart stands without it */ }
  }
  series.push(over);

  let entry = state.charts.get(metric);
  if (!entry || !host.querySelector(".uplot")) {
    host.textContent = "";
    // The plugin reads gaps lazily, so a span change updates them without
    // rebuilding the plot.
    entry = { gaps: [], host };
    entry.plot = makePlot(
      host, metric, card.dataset.zero === "1", card.dataset.unit, () => entry.gaps,
    );
    state.charts.set(metric, entry);
  }
  // EFC aging only means anything over weeks; on short spans the slope is the
  // oven chasing room temperature.
  if (metric === "efc_percent" && SPAN_SECONDS[state.span] >= 7 * 86400) {
    const a = efcAging(d.ts, d.value);
    if (a) {
      const years = a.daysLeft / 365;
      lastEl.title =
        `EFC trending ${a.slope > 0 ? "+" : ""}${a.slope.toFixed(4)} %/day ` +
        `(r² ${a.r2.toFixed(2)}); at this rate it reaches the end of its tuning ` +
        `range in about ${years >= 1 ? `${years.toFixed(1)} years` : `${Math.round(a.daysLeft)} days`}.`;
      resEl.textContent = (resEl.textContent ? `${resEl.textContent} · ` : "") +
        `${a.slope > 0 ? "+" : ""}${a.slope.toFixed(3)} %/day`;
    }
  }

  entry.gaps = d.gaps || [];
  entry.plot.setSize({ width: host.clientWidth || 300, height: 120 });
  entry.plot.setData(series);

  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i] !== null) { lastEl.textContent = fmt(vals[i]); break; }
  }
}

async function loadAllCharts() {
  const cards = [...document.querySelectorAll(".chart-card")];
  await Promise.all(cards.map((c) => loadChart(c).catch(() => {})));
}

/* ------------------------------------------------------------------ sky */

const SKY = { cx: 160, cy: 160, r: 138 };

function skyXY(elevation, azimuth) {
  // Zenith at the centre, horizon at the rim; north up, east right.
  const rr = SKY.r * (1 - Math.max(0, Math.min(90, elevation)) / 90);
  const a = ((azimuth - 90) * Math.PI) / 180;
  return [SKY.cx + rr * Math.cos(a), SKY.cy + rr * Math.sin(a)];
}

function signalColour(ss) {
  if (ss === null || ss === undefined) return css("--muted") || "#8b98a9";
  if (ss >= 80) return css("--ok") || "#3fb950";
  if (ss >= 45) return css("--accent") || "#4aa3ff";
  return css("--warn") || "#d29922";
}

function renderSky(data) {
  const svg = document.getElementById("sky");
  const grid = css("--line") || "#273041";
  const muted = css("--muted") || "#8b98a9";
  const parts = [];

  for (const el of [0, 30, 60]) {
    const rr = SKY.r * (1 - el / 90);
    parts.push(`<circle cx="${SKY.cx}" cy="${SKY.cy}" r="${rr.toFixed(1)}" fill="none" stroke="${grid}" stroke-width="1"/>`);
  }
  for (let az = 0; az < 360; az += 30) {
    const [x, y] = skyXY(0, az);
    parts.push(`<line x1="${SKY.cx}" y1="${SKY.cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${grid}" stroke-width="0.6"/>`);
  }
  // The elevation-mask ring: satellites below it are never used, so showing it makes
  // the receiver's own cutoff visible rather than implied.
  if (data.elevation_mask) {
    const rr = SKY.r * (1 - data.elevation_mask / 90);
    parts.push(`<circle cx="${SKY.cx}" cy="${SKY.cy}" r="${rr.toFixed(1)}" fill="none" stroke="${css("--warn")}" stroke-width="1" stroke-dasharray="4 3" opacity="0.75"/>`);
  }
  for (const [label, az] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
    const [x, y] = skyXY(-6, az);
    parts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${muted}" font-size="10" text-anchor="middle" dominant-baseline="middle">${label}</text>`);
  }

  if (state.trails && data.history && data.history.length) {
    const byPrn = new Map();
    for (const h of data.history) {
      if (h.elevation === null || h.azimuth === null) continue;
      if (!byPrn.has(h.prn)) byPrn.set(h.prn, []);
      byPrn.get(h.prn).push(skyXY(h.elevation, h.azimuth));
    }
    for (const pts of byPrn.values()) {
      if (pts.length < 2) continue;
      const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
      parts.push(`<path d="${d}" fill="none" stroke="${css("--accent")}" stroke-width="1" opacity="0.28"/>`);
    }
  }

  for (const s of data.current || []) {
    if (s.elevation === null || s.azimuth === null) continue;
    const [x, y] = skyXY(s.elevation, s.azimuth);
    const colour = s.tracked ? signalColour(s.signal) : muted;
    const r = s.tracked ? 7 : 5;
    parts.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${colour}" ` +
      `fill-opacity="${s.tracked ? 0.9 : 0.35}" stroke="${colour}" stroke-width="1.2"/>`);
    parts.push(
      `<text x="${x.toFixed(1)}" y="${(y + 0.5).toFixed(1)}" font-size="7.5" ` +
      `text-anchor="middle" dominant-baseline="middle" fill="${s.tracked ? "#06121f" : muted}" ` +
      `font-family="ui-monospace, monospace">${s.prn}</text>`);
  }

  svg.innerHTML = parts.join("");

  const body = document.getElementById("sat-rows");
  body.textContent = "";
  const sats = [...(data.current || [])].sort(
    (a, b) => (b.tracked - a.tracked) || ((b.signal || 0) - (a.signal || 0)));
  if (!sats.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">no satellites reported</td></tr>';
    return;
  }
  for (const s of sats) {
    const tr = document.createElement("tr");
    tr.className = (s.tracked ? "tracked" : "") + (s.acquiring ? " acq" : "");
    // Signal strength is an arbitrary unit on this receiver, so the bar is scaled to
    // the highest value observed in practice (~170) rather than to a nominal maximum.
    const pct = Math.max(3, Math.min(100, ((s.signal || 0) / 170) * 100));
    const sig = (s.signal !== null && s.signal !== undefined)
      ? `<span class="bar"><span style="width:${pct}%"></span></span><span class="sig">${s.signal}</span>`
      : `<span class="sig muted">${s.acquiring ? "acq" : "—"}</span>`;
    tr.addEventListener("mouseenter", () => focusPrn(s.prn));
    tr.addEventListener("mouseleave", () => focusPrn(null));
    tr.innerHTML =
      `<td class="prn">${s.prn}</td>` +
      `<td class="num">${s.elevation === null ? "—" : s.elevation + "°"}</td>` +
      `<td class="num">${s.azimuth === null ? "—" : s.azimuth + "°"}</td>` +
      `<td class="sigcell">${sig}</td>`;
    body.append(tr);
  }
}

async function loadSky() {
  try {
    const q = state.trails ? `?trail=${state.span}` : "";
    renderSky(await getJSON(`/api/satellites${q}`));
  } catch { /* nothing reported yet */ }
}





/* ------------------------------------------------------------------- efc aging */

/* Least-squares slope of EFC against time, projected to the end of the tuning range.
 *
 * Only shown on long spans and only when the fit is actually good: over an hour the
 * slope is thermal wander, not aging, and quoting a date from it would be fiction.
 */
function efcAging(ts, vals) {
  const pts = [];
  for (let i = 0; i < ts.length; i++) {
    if (vals[i] !== null && vals[i] !== undefined) pts.push([ts[i], vals[i]]);
  }
  if (pts.length < 30) return null;
  const days = pts.map((p) => (p[0] - pts[0][0]) / 86400);
  const ys = pts.map((p) => p[1]);
  const n = pts.length;
  const mx = days.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (days[i] - mx) * (ys[i] - my);
    sxx += (days[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  const slope = sxy / sxx;                  // percent of range per day
  const r2 = (sxy * sxy) / (sxx * syy);
  if (r2 < 0.5 || Math.abs(slope) < 1e-6) return null;
  // Which end of the range it is heading for.
  const last = ys[n - 1];
  const target = slope > 0 ? 100 : 0;
  const daysLeft = (target - last) / slope;
  if (!Number.isFinite(daysLeft) || daysLeft <= 0) return null;
  return { slope, r2, daysLeft };
}

/* --------------------------------------------------------------- allan deviation */

/* Formats an averaging interval the way a time nut reads one. */
function fmtTau(t) {
  if (t < 90) return `${Math.round(t)}s`;
  if (t < 5400) return `${Math.round(t / 60)}m`;
  if (t < 172800) return `${+(t / 3600).toFixed(1)}h`;
  return `${+(t / 86400).toFixed(1)}d`;
}

/* One significant figure in scientific notation: ADEV is read by order of magnitude
 * and a y axis of full decimals is unreadable at this size. */
function fmtSigma(v) {
  if (!v) return "0";
  const e = Math.floor(Math.log10(v));
  return `${+(v / 10 ** e).toFixed(1)}e${e}`;
}

async function loadAdev() {
  const host = document.getElementById("adev-host");
  const meta = document.getElementById("adev-meta");
  const foot = document.getElementById("adev-floor");
  if (!host) return;

  let d;
  try {
    d = await getJSON(`/api/adev?span=${state.span}`);
  } catch {
    host.innerHTML = '<div class="empty">no data yet</div>';
    return;
  }

  // The tau floor is a property of the architecture, not of this dataset, so it is
  // stated whether or not the chart managed to draw (Q4).
  foot.textContent =
    `tau floor ${fmtTau(d.tau_floor)} — polling yields one phase sample per tick, so ` +
    `shorter averaging intervals are unreachable. Short-tau characterisation needs a ` +
    `time interval counter.`;

  if (!d.tau || !d.tau.length) {
    host.innerHTML = `<div class="empty">${d.note || "not computable yet"}</div>`;
    meta.textContent = "";
    state.adevPlot = null;
    return;
  }

  meta.textContent =
    `${fmtTau(d.run_seconds)} unbroken · ${d.points} samples · tau0 ${fmtTau(d.tau0)}`;
  meta.title =
    "Computed from the longest gap-free run in the window, on raw samples only — " +
    "averaged rollups cannot reconstruct phase.";

  const muted = css("--muted") || "#8b98a9";
  const grid = css("--line") || "#273041";
  const accent = css("--accent") || "#4aa3ff";
  const data = [d.tau, d.sigma];

  if (!state.adevPlot || !host.querySelector(".uplot")) {
    host.textContent = "";
    state.adevPlot = new uPlot({
      width: host.clientWidth || 600,
      height: 240,
      padding: [12, 12, 0, 0],
      // Both axes logarithmic: ADEV is a power law and only reads as straight
      // lines - whose slope names the noise type - on log-log.
      scales: { x: { time: false, distr: 3 }, y: { distr: 3 } },
      cursor: { y: false, drag: { x: false, y: false } },
      legend: { show: false },
      axes: [
        {
          stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid },
          size: 28, font: "10px ui-monospace, monospace",
          values: (u, ts) => ts.map(fmtTau),
          // uPlot's default log filter judges tick spacing at the 1-10 decade, which
          // is far too conservative once the axis sits at 100-1000: it blanked every
          // label but the two endpoints. Decide from the width actually available.
          filter: (u, splits) => {
            const px = u.bbox.width / devicePixelRatio / Math.max(splits.length, 1);
            if (px >= 44) return splits;
            return splits.map((v) => {
              const m = v / 10 ** Math.floor(Math.log10(v));
              return [1, 2, 5].some((k) => Math.abs(m - k) < 0.01) ? v : null;
            });
          },
        },
        {
          stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid },
          size: 52, font: "10px ui-monospace, monospace",
          values: (u, ts) => ts.map(fmtSigma),
        },
      ],
      series: [
        { value: (u, v) => fmtTau(v) },
        {
          stroke: accent,
          width: 2,
          points: { show: true, size: 5 },
          value: (u, v) => (v === null ? "—" : fmtSigma(v)),
        },
      ],
      plugins: [adevTooltip(() => d)],
    }, data, host);
  } else {
    state.adevPlot.setSize({ width: host.clientWidth || 600, height: 240 });
    state.adevPlot.setData(data);
  }
}

/* Confidence falls off sharply at long tau, so the pair count travels with the
 * reading rather than being left for the viewer to infer from the x position. */
function adevTooltip(get) {
  let tip;
  return {
    hooks: {
      init: (u) => {
        tip = document.createElement("div");
        tip.className = "u-tip";
        tip.hidden = true;
        u.over.appendChild(tip);
      },
      setCursor: (u) => {
        const i = u.cursor.idx;
        const d = get();
        if (i === null || i === undefined || !d.sigma[i]) {
          tip.hidden = true;
          return;
        }
        tip.innerHTML =
          `<b>${fmtSigma(d.sigma[i])}</b><br>` +
          `<span class="u-tip-when">tau ${fmtTau(d.tau[i])}</span><br>` +
          `<span class="u-tip-range">${d.pairs[i]} pairs</span>`;
        tip.hidden = false;
        const left = u.valToPos(d.tau[i], "x");
        tip.style.left = `${Math.min(Math.max(left + 8, 4), u.bbox.width / devicePixelRatio - 90)}px`;
        tip.style.top = "6px";
      },
    },
  };
}

/* ------------------------------------------------------------- lock state strip */

/* The timeline FR-15 asks for, and the legend for the bands FR-16 draws behind every
 * sparkline. Positioned absolutely across the window rather than flexed, so a run that
 * starts after the window opens sits where it actually happened. */
async function loadStates() {
  const strip = document.getElementById("lock-strip");
  const legend = document.getElementById("lock-legend");
  const scale = document.getElementById("lock-scale");
  if (!strip) return;

  let d;
  try {
    d = await getJSON(`/api/states?metric=mode&span=${state.span}`);
  } catch {
    state.states = [];
    return;
  }
  // A span is stored as the first and last SAMPLE of a run, so a state seen once has
  // zero width and would be skipped entirely - and five of nine runs in a typical hour
  // are single-sample. A run actually lasts until the next one begins, so close each
  // against its successor. Both the strip and the bands behind the sparklines read
  // this list, so normalising here fixes them together.
  const raw = d.spans || [];
  const tnow = Math.floor(Date.now() / 1000);
  state.states = raw.map((sp, i) => ({
    text: sp.text,
    start: sp.start,
    end: i + 1 < raw.length ? raw[i + 1].start : Math.max(sp.end, tnow),
  }));

  strip.textContent = "";
  legend.textContent = "";
  scale.textContent = "";
  if (!state.states.length) {
    strip.innerHTML = '<div class="empty">no state recorded in this window</div>';
    return;
  }

  const t1 = tnow;
  const t0 = t1 - SPAN_SECONDS[state.span];
  const width = Math.max(t1 - t0, 1);
  const seen = new Map();

  for (const sp of state.states) {
    const { label, colour } = modeStyle(sp.text);
    const l = Math.max((sp.start - t0) / width, 0);
    const r = Math.min((sp.end - t0) / width, 1);
    if (r <= l) continue;
    const seg = document.createElement("div");
    seg.className = "lock-seg";
    seg.style.left = `${l * 100}%`;
    seg.style.width = `${Math.max((r - l) * 100, 0.3)}%`;
    seg.style.background = colour || "var(--ok)";
    // Sub-minute runs are common, so show seconds rather than rounding them to "0 min".
    const secs = Math.round(sp.end - sp.start);
    const dur = secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs}s`;
    seg.title = `${sp.text} — ${dur}, from ${new Date(sp.start * 1000).toLocaleString()}`;
    strip.append(seg);
    seen.set(label, colour || "var(--ok)");
  }

  for (const [label, colour] of seen) {
    const b = document.createElement("span");
    b.className = "lock-key";
    b.innerHTML = `<span class="swatch" style="background:${colour}"></span>${label}`;
    legend.append(b);
  }

  const fmtT = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  scale.innerHTML = `<span>${fmtT(t0)}</span><span>${fmtT(t1)}</span>`;
}


/* ------------------------------------------------------- satellite signal chart */

async function loadSatSignal() {
  const host = document.getElementById("satsig-host");
  const legend = document.getElementById("satsig-legend");
  if (!host) return;

  let d;
  try {
    d = await getJSON(`/api/sat-series?span=${state.span}`);
  } catch {
    host.innerHTML = '<div class="empty">no satellite data yet</div>';
    return;
  }
  if (!d.ts || !d.ts.length || !d.series.length) {
    host.innerHTML = '<div class="empty">no satellites tracked in this window</div>';
    state.satPlot = null;
    legend.textContent = "";
    return;
  }

  const data = [d.ts, ...d.series.map((s) => s.values)];
  const muted = css("--muted") || "#8b98a9";
  const grid = css("--line") || "#273041";

  // Rebuild when the set of satellites changes - uPlot's series list is fixed at
  // construction, and satellites rise and set constantly.
  const key = d.series.map((s) => s.prn).join(",");
  if (!state.satPlot || state.satPlot.key !== key || !host.querySelector(".uplot")) {
    host.textContent = "";
    const opts = {
      width: host.clientWidth || 600,
      height: 220,
      padding: [10, 10, 0, 0],
      // Focus dims the other lines, which is what makes one satellite followable
      // among a dozen. prox keeps pointer-proximity focus working too.
      cursor: {
        focus: { prox: 24, alpha: 0.22 },
        y: false,
        drag: { x: false, y: false },
        sync: syncCursor(),
      },
      legend: { show: false },
      scales: { x: { time: true } },
      axes: [
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid },
          size: 28, font: "10px ui-monospace, monospace" },
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid },
          size: 40, font: "10px ui-monospace, monospace" },
      ],
      series: [
        {},
        ...d.series.map((srs, i) => ({
          label: `PRN ${srs.prn}`,
          stroke: prnColour(i),
          width: 1.6,
          // A satellite that is not visible has no value, and the line must stop
          // rather than leap across the interval it was absent.
          spanGaps: false,
          points: { show: false },
        })),
      ],
    };
    const plot = new uPlot(opts, data, host);
    plot.key = key;
    state.satPlot = plot;
  } else {
    state.satPlot.setSize({ width: host.clientWidth || 600, height: 220 });
    state.satPlot.setData(data);
  }

  // Legend doubles as a per-satellite toggle.
  state.satIndex.clear();
  legend.textContent = "";
  d.series.forEach((srs, i) => {
    state.satIndex.set(srs.prn, i + 1);   // series 0 is the x axis
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<span class="swatch" style="background:${prnColour(i)}"></span>${srs.prn}`;
    b.title = `PRN ${srs.prn} — ${srs.samples} sample${srs.samples === 1 ? "" : "s"}`;
    b.addEventListener("click", () => {
      const idx = i + 1;
      const shown = state.satPlot.series[idx].show;
      state.satPlot.setSeries(idx, { show: !shown });
      b.classList.toggle("off", shown);
    });
    b.addEventListener("mouseenter", () => focusPrn(srs.prn));
    b.addEventListener("mouseleave", () => focusPrn(null));
    legend.append(b);
  });
}

/* Highlights one satellite's line. Used from both the legend and the satellite table,
 * so the two views can be read together rather than one at a time. */
function focusPrn(prn) {
  if (!state.satPlot) return;
  const idx = prn === null ? null : state.satIndex.get(prn);
  if (prn !== null && idx === undefined) return;
  state.satPlot.setSeries(idx === undefined ? null : idx, { focus: true });
}

/* ------------------------------------------------------------------ events */

async function loadEvents() {
  let d;
  try { d = await getJSON("/api/events?limit=25"); } catch { return; }
  const ul = document.getElementById("events");
  ul.textContent = "";

  // Reconnects arrive in floods and were pushing everything else off the panel - a
  // dozen identical lines say no more than one line with a count, and the single
  // interesting entry among them is what the panel exists to show.
  const runs = [];
  for (const e of d.events) {
    const prev = runs[runs.length - 1];
    if (prev && prev.e.source === e.source && prev.e.message === e.message
        && prev.e.level === e.level) {
      prev.n += 1;
      prev.first = e.ts;
    } else {
      runs.push({ e, n: 1, first: e.ts });
    }
  }

  for (const r of runs) {
    const li = document.createElement("li");
    li.className = r.e.level;
    const when = new Date(r.e.ts * 1000).toISOString().slice(11, 19);
    li.innerHTML = `<span class="when"></span><span class="src"></span>` +
      `<span class="msg"></span><span class="rep"></span>`;
    li.querySelector(".when").textContent = when;
    li.querySelector(".src").textContent = r.e.source;
    li.querySelector(".msg").textContent = r.e.message;
    if (r.n > 1) {
      const rep = li.querySelector(".rep");
      rep.textContent = `×${r.n}`;
      rep.title = `${r.n} identical entries, oldest at ` +
        new Date(r.first * 1000).toLocaleTimeString();
    }
    ul.append(li);
  }
}

/* ------------------------------------------------------------------ wiring */

async function refreshFast() {
  try { renderStatus(await getJSON("/api/status")); } catch { /* keep last view */ }
  await loadSky();
}

async function refreshSlow() {
  // States first: the band plugin reads them while the charts draw.
  await loadStates();
  await loadAllCharts();
  await loadAdev();
  await loadSatSignal();
  await loadEvents();
}

document.querySelectorAll(".span").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".span").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.span = b.dataset.span;
    loadStates().then(loadAllCharts);
    loadAdev();
    loadSatSignal();
    if (state.trails) loadSky();
  });
});

document.getElementById("trail-toggle").addEventListener("change", (e) => {
  state.trails = e.target.checked;
  loadSky();
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const [metric, entry] of state.charts) {
      entry.plot.setSize({ width: entry.host.clientWidth || 300, height: 120 });
    }
    const ah = document.getElementById("adev-host");
    if (state.adevPlot && ah) state.adevPlot.setSize({ width: ah.clientWidth || 600, height: 240 });
    const sh = document.getElementById("satsig-host");
    if (state.satPlot && sh) state.satPlot.setSize({ width: sh.clientWidth || 600, height: 220 });
  }, 150);
});

refreshFast();
refreshSlow();
setInterval(refreshFast, 5000);
setInterval(refreshSlow, 30000);
