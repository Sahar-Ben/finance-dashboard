// Small SVG charts: line (with gaps and incomplete months), bars (with an average line) and stacked bars.
// Every chart is a <div class="chart"> holding a readout line and an SVG; tapping or hovering a month
// shows that month's values in the readout. Amount text goes through the formatters passed in.
(function () {
  "use strict";

  const W = 340, H = 170, PAD_L = 46, PAD_R = 8, PAD_T = 10, PAD_B = 22;
  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Colours for account types, validated as a set against the panel colour (#12101C).
  const TYPE_COLORS = {
    current: "#3987e5", savings: "#d95926", investment: "#199e70", crypto: "#c98500",
    long_term: "#d55181", home: "#008300", loan: "#e66767",
  };
  const LINE_COLOR = "#A47BFF";

  function niceTicks(min, max, count) {
    if (min === max) { max = min + 1; }
    const span = max - min;
    const step0 = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || 10 * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { lo, hi, ticks };
  }

  function frame(n) {
    const plotW = W - PAD_L - PAD_R;
    const slot = plotW / Math.max(1, n);
    return { plotW, slot, x: (i) => PAD_L + slot * (i + 0.5) };
  }

  function axis(scale, ticks, fmtTick) {
    return ticks.map((t) => {
      const y = scale(t);
      return `<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y}" y2="${y}" class="grid${t === 0 ? " zero" : ""}"/>
        <text x="${PAD_L - 6}" y="${y + 3}" class="tick" text-anchor="end">${esc(fmtTick(t))}</text>`;
    }).join("");
  }

  function xLabels(labels, f) {
    const n = labels.length;
    const every = n <= 7 ? 1 : n <= 13 ? 2 : Math.ceil(n / 6);
    return labels.map((l, i) => ((n - 1 - i) % every === 0
      ? `<text x="${f.x(i)}" y="${H - 6}" class="tick" text-anchor="middle">${esc(l)}</text>` : "")).join("");
  }

  // Transparent full-height columns that drive the readout.
  function hits(n, f, tips) {
    return tips.map((t, i) => `<rect class="hit" data-i="${i}" data-tip="${esc(t)}" x="${f.x(i) - f.slot / 2}" y="0" width="${f.slot}" height="${H - PAD_B}"/>`).join("")
      + `<line class="cross" x1="0" x2="0" y1="${PAD_T}" y2="${H - PAD_B}" visibility="hidden"/>`;
  }

  function wrap(svg, tips, defaultIndex, ariaLabel) {
    const d = defaultIndex >= 0 ? tips[defaultIndex] : "";
    return `<div class="chart" data-default="${defaultIndex}">
      <div class="chart-readout mono">${esc(d)}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel || "Chart")}">${svg}</svg>
    </div>`;
  }

  const lastIndex = (values) => { for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return i; return -1; };

  // values: number|null per label (null = no data, drawn as a gap). incomplete: bool per label.
  function line(o) {
    const n = o.labels.length;
    const vals = o.values.filter((v) => v != null);
    if (!vals.length) return `<div class="chart-empty muted">No data for this period.</div>`;
    const t = niceTicks(Math.min(0, ...vals), Math.max(...vals), 4);
    const f = frame(n);
    const y = (v) => PAD_T + (H - PAD_T - PAD_B) * (1 - (v - t.lo) / (t.hi - t.lo));
    const color = o.color || LINE_COLOR;
    let segs = "";
    for (let i = 1; i < n; i++) {
      const a = o.values[i - 1], b = o.values[i];
      if (a == null || b == null) continue;
      const dashed = (o.incomplete && (o.incomplete[i - 1] || o.incomplete[i]));
      segs += `<line x1="${f.x(i - 1)}" y1="${y(a)}" x2="${f.x(i)}" y2="${y(b)}" stroke="${color}" class="ln${dashed ? " dashed" : ""}"/>`;
    }
    const dots = o.values.map((v, i) => (v == null ? "" : o.incomplete && o.incomplete[i]
      ? `<circle cx="${f.x(i)}" cy="${y(v)}" r="4" class="dot hollow" stroke="${color}"/>`
      : `<circle cx="${f.x(i)}" cy="${y(v)}" r="4" class="dot" fill="${color}"/>`)).join("");
    const svg = axis(y, t.ticks, o.fmtTick) + xLabels(o.labels, f) + segs + dots + hits(n, f, o.tips);
    return wrap(svg, o.tips, lastIndex(o.values), o.ariaLabel);
  }

  function barPath(x, y0, y1, w) {
    // Rounded 4px at the data end, square at the baseline.
    const r = Math.min(4, w / 2, Math.abs(y1 - y0));
    if (y1 < y0) {
      return `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0} Z`;
    }
    return `M${x},${y0} V${y1 - r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 - r} V${y0} Z`;
  }

  // values: number|null per label. avg: number|null drawn as a reference line.
  function bars(o) {
    const n = o.labels.length;
    const vals = o.values.filter((v) => v != null);
    if (!vals.length) return `<div class="chart-empty muted">No data for this period.</div>`;
    const t = niceTicks(0, Math.max(...vals, o.avg || 0), 4);
    const f = frame(n);
    const y = (v) => PAD_T + (H - PAD_T - PAD_B) * (1 - (v - t.lo) / (t.hi - t.lo));
    const bw = Math.min(24, f.slot * 0.62);
    const marks = o.values.map((v, i) => (v == null || v <= 0 ? "" :
      `<path d="${barPath(f.x(i) - bw / 2, y(0), y(v), bw)}" fill="${o.color || LINE_COLOR}" class="bar-mark${o.highlight === i ? " hl" : ""}"/>`)).join("");
    const avg = o.avg != null && o.avg > 0
      ? `<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(o.avg)}" y2="${y(o.avg)}" class="avg"/>
         <text x="${W - PAD_R}" y="${y(o.avg) - 4}" class="tick avg-label" text-anchor="end">avg ${esc(o.fmtTick(o.avg))}</text>` : "";
    const svg = axis(y, t.ticks, o.fmtTick) + xLabels(o.labels, f) + marks + avg + hits(n, f, o.tips);
    const def = o.highlight != null && o.values[o.highlight] != null ? o.highlight : lastIndex(o.values);
    return wrap(svg, o.tips, def, o.ariaLabel);
  }

  // series: [{ key, color, values }] stacked upward; negative: { color, values } drawn below zero.
  function stacked(o) {
    const n = o.labels.length;
    const up = o.labels.map((_, i) => o.series.reduce((s, se) => s + (se.values[i] || 0), 0));
    const down = o.labels.map((_, i) => (o.negative && o.negative.values[i]) || 0);
    const has = o.labels.map((_, i) => o.series.some((se) => se.values[i] != null));
    if (!has.some(Boolean)) return `<div class="chart-empty muted">No data for this period.</div>`;
    const t = niceTicks(-Math.max(0, ...down), Math.max(0, ...up), 4);
    const f = frame(n);
    const y = (v) => PAD_T + (H - PAD_T - PAD_B) * (1 - (v - t.lo) / (t.hi - t.lo));
    const bw = Math.min(24, f.slot * 0.62);
    const GAP = 2;
    let marks = "";
    for (let i = 0; i < n; i++) {
      if (!has[i]) continue;
      const x = f.x(i) - bw / 2;
      let acc = 0;
      const segs = o.series.filter((se) => (se.values[i] || 0) > 0);
      segs.forEach((se, k) => {
        const v = se.values[i];
        const y0 = y(acc), y1 = y(acc + v);
        const top = k === segs.length - 1;
        const h = Math.max(0, y0 - y1 - (k > 0 ? GAP : 0));
        const yy0 = k > 0 ? y0 - GAP : y0;
        marks += top ? `<path d="${barPath(x, yy0, yy0 - h, bw)}" fill="${se.color}"/>`
          : `<rect x="${x}" y="${yy0 - h}" width="${bw}" height="${h}" fill="${se.color}"/>`;
        acc += v;
      });
      if (down[i] > 0) marks += `<path d="${barPath(x, y(0), y(-down[i]), bw)}" fill="${o.negative.color}"/>`;
      if (o.incomplete && o.incomplete[i]) marks += `<text x="${f.x(i)}" y="${y(up[i]) - 4}" class="tick" text-anchor="middle">!</text>`;
    }
    const svg = axis(y, t.ticks, o.fmtTick) + xLabels(o.labels, f) + marks + hits(n, f, o.tips);
    let def = -1;
    for (let i = n - 1; i >= 0; i--) if (has[i]) { def = i; break; }
    return wrap(svg, o.tips, def, o.ariaLabel);
  }

  // Wires tap/hover on every chart inside `root`.
  function bind(root) {
    root.querySelectorAll(".chart").forEach((chart) => {
      const readout = chart.querySelector(".chart-readout");
      const cross = chart.querySelector(".cross");
      const show = (rect) => {
        readout.textContent = rect.dataset.tip;
        const x = Number(rect.getAttribute("x")) + Number(rect.getAttribute("width")) / 2;
        cross.setAttribute("x1", x); cross.setAttribute("x2", x);
        cross.setAttribute("visibility", "visible");
      };
      chart.querySelectorAll(".hit").forEach((r) => {
        r.addEventListener("pointerenter", () => show(r));
        r.addEventListener("pointerdown", () => show(r));
      });
      chart.addEventListener("pointerleave", (e) => {
        if (e.pointerType !== "mouse") return;
        const d = Number(chart.dataset.default);
        const r = chart.querySelector(`.hit[data-i="${d}"]`);
        if (r) readout.textContent = r.dataset.tip;
        cross.setAttribute("visibility", "hidden");
      });
    });
  }

  window.Charts = { line, bars, stacked, bind, TYPE_COLORS, LINE_COLOR };
})();
