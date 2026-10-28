import { LitElement, css, html, nothing, svg, type PropertyValues, type TemplateResult } from "lit";
import { formatter, niceTicks, type FormatSpec, type Formatter } from "./viz-format.ts";

type ChartType = "bar" | "line" | "area" | "pie" | "donut";

interface Series {
  name: string;
  values: Array<number | null>;
}

export interface ChartSpec extends FormatSpec {
  type: ChartType;
  title?: string;
  subtitle?: string;
  source?: string;
  x: string[];
  series: Series[];
  stacked?: boolean;
  horizontal?: boolean;
}

const TYPES: readonly ChartType[] = ["bar", "line", "area", "pie", "donut"];
const MAX_SERIES = 8;
const MAX_POINTS = 200;
const DEFAULT_WIDTH = 640;
const PIE_SIZE = 240;

const text = (value: unknown, limit = 120): string => String(value ?? "").slice(0, limit);

export function parseChart(source: string): ChartSpec {
  const raw = JSON.parse(source.trim()) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error("The chart spec must be a JSON object.");
  const type = raw.type as ChartType;
  if (!TYPES.includes(type)) throw new Error(`"type" must be one of ${TYPES.join(", ")}.`);
  if (!Array.isArray(raw.x) || raw.x.length === 0 || raw.x.length > MAX_POINTS)
    throw new Error(`"x" must list 1 to ${MAX_POINTS} labels.`);
  const x = raw.x.map((label) => text(label, 60));
  if (!Array.isArray(raw.series) || raw.series.length === 0 || raw.series.length > MAX_SERIES)
    throw new Error(`"series" must hold 1 to ${MAX_SERIES} series.`);
  const series = raw.series.map((entry: unknown, index): Series => {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (!Array.isArray(item.values) || item.values.length !== x.length)
      throw new Error(`Series ${index + 1} needs exactly one value per "x" label.`);
    const values = item.values.map((value) => {
      if (value === null) return null;
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`Series ${index + 1} has a value that is not a number.`);
      return value;
    });
    return { name: text(item.name ?? `Series ${index + 1}`, 60), values };
  });
  if ((type === "pie" || type === "donut") && series.length !== 1)
    throw new Error("A pie or donut chart takes exactly one series.");
  if ((type === "pie" || type === "donut") && series[0]!.values.some((value) => (value ?? 0) < 0))
    throw new Error("A pie or donut chart cannot show negative values.");
  if ((type === "pie" || type === "donut") && x.length > MAX_SERIES)
    throw new Error(`A pie or donut chart shows at most ${MAX_SERIES} slices; fold the smallest into "Other".`);
  return {
    type,
    x,
    series,
    ...(raw.title !== undefined ? { title: text(raw.title) } : {}),
    ...(raw.subtitle !== undefined ? { subtitle: text(raw.subtitle, 200) } : {}),
    ...(raw.source !== undefined ? { source: text(raw.source, 200) } : {}),
    ...(raw.stacked === true ? { stacked: true } : {}),
    ...(raw.horizontal === true ? { horizontal: true } : {}),
    ...(raw.format === "percent" || raw.format === "currency" || raw.format === "number" ? { format: raw.format } : {}),
    ...(typeof raw.currency === "string" ? { currency: raw.currency } : {}),
    ...(typeof raw.decimals === "number" ? { decimals: raw.decimals } : {}),
    ...(typeof raw.locale === "string" ? { locale: raw.locale } : {}),
  };
}

function barPath(x: number, y0: number, y1: number, width: number, round: boolean): string {
  const height = Math.abs(y1 - y0);
  const r = round ? Math.min(4, height, width / 2) : 0;
  if (y1 <= y0)
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + width - r}Q${x + width},${y1} ${x + width},${y1 + r}V${y0}Z`;
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + width - r}Q${x + width},${y1} ${x + width},${y1 - r}V${y0}Z`;
}

function hbarPath(y: number, x0: number, x1: number, height: number, round: boolean): string {
  const length = Math.abs(x1 - x0);
  const r = round ? Math.min(4, length, height / 2) : 0;
  if (x1 >= x0)
    return `M${x0},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + height - r}Q${x1},${y + height} ${x1 - r},${y + height}H${x0}Z`;
  return `M${x0},${y}H${x1 + r}Q${x1},${y} ${x1},${y + r}V${y + height - r}Q${x1},${y + height} ${x1 + r},${y + height}H${x0}Z`;
}

function arcPath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  const sweep = end - start;
  if (sweep >= Math.PI * 2 - 1e-6) end = start + Math.PI * 2 - 1e-4;
  const large = end - start > Math.PI ? 1 : 0;
  const point = (radius: number, angle: number) => `${cx + radius * Math.sin(angle)},${cy - radius * Math.cos(angle)}`;
  const outerArc = `M${point(outer, start)}A${outer},${outer} 0 ${large} 1 ${point(outer, end)}`;
  if (inner <= 0) return `${outerArc}L${cx},${cy}Z`;
  return `${outerArc}L${point(inner, end)}A${inner},${inner} 0 ${large} 0 ${point(inner, start)}Z`;
}

export class ChartBlock extends LitElement {
  static properties = {
    code: {},
    pending: { type: Boolean, reflect: true },
    hover: { state: true },
    width: { state: true },
  };

  declare code: string;
  declare pending: boolean;
  declare private hover: number;
  declare private width: number;
  private themeObserver?: MutationObserver;
  private resizeObserver?: ResizeObserver;

  static styles = css`
    :host {
      display: block;
      min-width: 0;
      margin: 1em 0;
      position: relative;
      --surface: var(--background, #fcfcfb);
      --ink: var(--foreground, #0b0b0b);
      --ink-muted: var(--muted-foreground, #52514e);
      --rule: var(--border, #e4e3df);
      --s1: #2a78d6;
      --s2: #eb6834;
      --s3: #1baf7a;
      --s4: #eda100;
      --s5: #e87ba4;
      --s6: #008300;
      --s7: #6250d6;
      --s8: #e34948;
    }
    :host([dark]) {
      --s1: #3987e5;
      --s2: #d95926;
      --s3: #199e70;
      --s4: #c98500;
      --s5: #d55181;
      --s6: #008300;
      --s7: #9085e9;
      --s8: #e66767;
    }
    figure {
      margin: 0;
      padding: 12px 4px 4px;
      font: 13px var(--app-font, system-ui);
      color: var(--ink);
    }
    .title {
      font-weight: 600;
      font-size: 14px;
    }
    .subtitle,
    .source,
    summary,
    .status {
      color: var(--ink-muted);
      font-size: 12px;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 14px;
      margin: 8px 0 4px;
      font-size: 12px;
      color: var(--ink-muted);
    }
    .legend span,
    .tip-row {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      flex: none;
    }
    .plot {
      position: relative;
    }
    svg {
      display: block;
      width: 100%;
      height: auto;
      overflow: visible;
    }
    .grid {
      stroke: var(--rule);
      stroke-width: 1;
    }
    .axis-label {
      fill: var(--ink-muted);
      font-size: 11px;
    }
    .mark {
      transition: opacity 120ms;
    }
    .dim .mark:not(.on) {
      opacity: 0.4;
    }
    .tip {
      position: absolute;
      top: 4px;
      pointer-events: none;
      background: var(--card, var(--surface));
      color: var(--ink);
      border: 1px solid var(--rule);
      border-radius: 8px;
      padding: 6px 9px;
      font-size: 12px;
      line-height: 1.5;
      white-space: nowrap;
      box-shadow: 0 4px 14px rgb(0 0 0 / 0.12);
      z-index: 1;
    }
    .tip-head {
      font-weight: 600;
    }
    .tip-value {
      margin-left: auto;
      padding-left: 12px;
      font-variant-numeric: tabular-nums;
    }
    details {
      margin-top: 6px;
    }
    summary {
      cursor: pointer;
    }
    table {
      border-collapse: collapse;
      font-size: 12px;
      margin-top: 6px;
      font-variant-numeric: tabular-nums;
    }
    th,
    td {
      text-align: left;
      padding: 3px 10px 3px 0;
      border-bottom: 1px solid var(--rule);
    }
    td.num {
      text-align: right;
    }
    pre {
      max-height: 400px;
      overflow: auto;
      font: 12px/1.5 monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `;

  constructor() {
    super();
    this.code = "";
    this.pending = false;
    this.hover = -1;
    this.width = DEFAULT_WIDTH;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.toggleAttribute("dark", document.documentElement.classList.contains("dark"));
    this.themeObserver = new window.MutationObserver(() =>
      this.toggleAttribute("dark", document.documentElement.classList.contains("dark")),
    );
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(([entry]) => {
        const measured = Math.round(entry?.contentRect.width ?? 0);
        if (measured > 0) this.width = Math.max(280, Math.min(960, measured));
      });
      this.resizeObserver.observe(this);
    }
  }

  disconnectedCallback(): void {
    this.themeObserver?.disconnect();
    this.resizeObserver?.disconnect();
    super.disconnectedCallback();
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("code")) this.hover = -1;
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("code") || changed.has("pending"))
      this.dispatchEvent(new window.Event("qm-content-updated", { bubbles: true, composed: true }));
  }

  protected render(): TemplateResult {
    if (this.pending) return html`<p class="status" role="status">Chart will render when the reply finishes.</p>`;
    let spec: ChartSpec;
    try {
      spec = parseChart(this.code);
    } catch (error) {
      return html`<p class="status" role="status">
          Unable to render this chart: ${error instanceof Error ? error.message : "invalid spec"}
        </p>
        <details open>
          <summary>Source</summary>
          <pre><code>${this.code}</code></pre>
        </details>`;
    }
    const format = formatter(spec);
    const pie = spec.type === "pie" || spec.type === "donut";
    let legend: Array<{ label: string; color: string }> = [];
    if (pie) legend = spec.x.map((label, index) => ({ label, color: `var(--s${(index % MAX_SERIES) + 1})` }));
    else if (spec.series.length > 1)
      legend = spec.series.map((series, index) => ({ label: series.name, color: `var(--s${index + 1})` }));
    return html`<figure aria-label=${spec.title ?? "Chart"}>
      ${spec.title ? html`<div class="title">${spec.title}</div>` : nothing}
      ${spec.subtitle ? html`<div class="subtitle">${spec.subtitle}</div>` : nothing}
      ${
        legend.length
          ? html`<div class="legend">
              ${legend.map(
                (entry) => html`<span><i class="swatch" style="background:${entry.color}"></i>${entry.label}</span>`,
              )}
            </div>`
          : nothing
      }
      <div class="plot ${this.hover >= 0 ? "dim" : ""}" @pointerleave=${() => (this.hover = -1)}>
        ${this.plot(spec, format, pie)} ${this.tooltip(spec, format)}
      </div>
      ${spec.source ? html`<div class="source">${spec.source}</div>` : nothing}
      <details>
        <summary>Data</summary>
        ${this.table(spec, format)}
      </details>
    </figure>`;
  }

  private plot(spec: ChartSpec, format: Formatter, pie: boolean): TemplateResult {
    if (pie) return this.pie(spec, format);
    if (spec.type === "bar" && spec.horizontal) return this.hbars(spec, format);
    return this.cartesian(spec, format);
  }

  private stackedTotals(spec: ChartSpec): number[] {
    return spec.x.map((_, i) => spec.series.reduce((sum, series) => sum + (series.values[i] ?? 0), 0));
  }

  private domain(spec: ChartSpec): number[] {
    const stack = spec.stacked && spec.type !== "line";
    const values = stack
      ? spec.x.flatMap((_, i) => {
          let positive = 0;
          let negative = 0;
          for (const series of spec.series) {
            const value = series.values[i] ?? 0;
            if (value >= 0) positive += value;
            else negative += value;
          }
          return [positive, negative];
        })
      : spec.series.flatMap((series) => series.values.filter((value): value is number => value !== null));
    const includeZero = spec.type !== "line";
    return niceTicks(
      Math.min(...values, ...(includeZero ? [0] : [])),
      Math.max(...values, ...(includeZero ? [0] : [])),
    );
  }

  private cartesian(spec: ChartSpec, format: Formatter): TemplateResult {
    const ticks = this.domain(spec);
    const lo = ticks[0]!;
    const hi = ticks.at(-1)!;
    const width = this.width;
    const height = Math.round(Math.min(300, Math.max(200, width * 0.55)));
    const labelWidth = Math.max(...ticks.map((tick) => format.axis(tick).length)) * 6.5 + 10;
    const left = Math.min(110, labelWidth);
    const top = 10;
    const bottom = height - 26;
    const right = width - 8;
    const n = spec.x.length;
    const band = (right - left) / n;
    const y = (value: number) => bottom - ((value - lo) / (hi - lo || 1)) * (bottom - top);
    const cx = (i: number) => left + band * (i + 0.5);
    const every = Math.max(1, Math.ceil(n / Math.floor((right - left) / 64)));
    const marks: TemplateResult[] = [];
    if (spec.type === "bar") {
      const k = spec.stacked ? 1 : spec.series.length;
      const groupWidth = Math.min(band * 0.72, k * 40);
      const barWidth = Math.max(2, (groupWidth - (k - 1) * 2) / k);
      spec.x.forEach((_, i) => {
        let positive = 0;
        let negative = 0;
        const lastPositive = spec.series.findLastIndex((series) => (series.values[i] ?? 0) > 0);
        const lastNegative = spec.series.findLastIndex((series) => (series.values[i] ?? 0) < 0);
        spec.series.forEach((series, s) => {
          const value = series.values[i];
          if (value === null) return;
          let from = 0;
          let to = value;
          let x = cx(i) - groupWidth / 2 + s * (barWidth + 2);
          let round = true;
          if (spec.stacked) {
            x = cx(i) - barWidth / 2;
            from = value >= 0 ? positive : negative;
            to = from + value;
            if (value >= 0) positive = to;
            else negative = to;
            round = s === (value >= 0 ? lastPositive : lastNegative);
          }
          const gap = spec.stacked && from !== 0 ? Math.sign(value) : 0;
          const y0 = y(from) - gap;
          marks.push(
            svg`<path class="mark ${this.hover === i ? "on" : ""}" d=${barPath(x, y0, y(to), barWidth, round)} fill="var(--s${s + 1})"></path>`,
          );
        });
      });
    } else {
      const totals = Array.from({ length: n }, () => 0);
      spec.series.forEach((series, s) => {
        const baseline = y(Math.max(lo, 0));
        const points: Array<[number, number, number] | null> = series.values.map((value, i) => {
          if (value === null) return null;
          if (spec.type === "area" && spec.stacked) {
            const below = totals[i]!;
            totals[i]! += value;
            return [cx(i), y(totals[i]!), y(below)];
          }
          return [cx(i), y(value), baseline];
        });
        const segments: Array<Array<[number, number, number]>> = [[]];
        for (const point of points) {
          if (point) segments.at(-1)!.push(point);
          else if (segments.at(-1)!.length) segments.push([]);
        }
        for (const segment of segments.filter((part) => part.length)) {
          const line = segment.map(([px, py], j) => `${j ? "L" : "M"}${px},${py}`).join("");
          if (spec.type === "area")
            marks.push(
              svg`<path d=${`${line}${[...segment]
                .reverse()
                .map(([px, , base]) => `L${px},${base}`)
                .join("")}Z`} fill="var(--s${s + 1})" fill-opacity="0.16"></path>`,
            );
          marks.push(
            svg`<path d=${line} fill="none" stroke="var(--s${s + 1})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>`,
          );
        }
        if (n <= 24 || this.hover >= 0)
          points.forEach((point, i) => {
            if (!point || (n > 24 && i !== this.hover)) return;
            marks.push(
              svg`<circle cx=${point[0]} cy=${point[1]} r=${this.hover === i ? 5 : 4} fill="var(--s${s + 1})" stroke="var(--surface)" stroke-width="2"></circle>`,
            );
          });
      });
    }
    return html`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label=${this.summary(spec, format)}>
      ${ticks.map(
        (tick) => svg`<line class="grid" x1=${left} x2=${right} y1=${y(tick)} y2=${y(tick)}></line>
          <text class="axis-label" x=${left - 8} y=${y(tick) + 4} text-anchor="end">${format.axis(tick)}</text>`,
      )}
      ${
        spec.type !== "bar" && this.hover >= 0
          ? svg`<line x1=${cx(this.hover)} x2=${cx(this.hover)} y1=${top} y2=${bottom} stroke="var(--ink-muted)" stroke-dasharray="3 3"></line>`
          : nothing
      }
      ${marks}
      ${spec.x.map((label, i) =>
        i % every
          ? nothing
          : svg`<text class="axis-label" x=${cx(i)} y=${bottom + 17} text-anchor="middle">${label.length > 14 ? `${label.slice(0, 13)}…` : label}</text>`,
      )}
      ${spec.x.map(
        (_, i) =>
          svg`<rect x=${left + band * i} y=${top} width=${band} height=${bottom - top} fill="transparent" @pointerenter=${() => (this.hover = i)}></rect>`,
      )}
    </svg>`;
  }

  private hbars(spec: ChartSpec, format: Formatter): TemplateResult {
    const ticks = this.domain(spec);
    const lo = ticks[0]!;
    const hi = ticks.at(-1)!;
    const n = spec.x.length;
    const k = spec.stacked ? 1 : spec.series.length;
    const rowHeight = Math.max(24, k * 14 + 10);
    const height = n * rowHeight + 30;
    const width = this.width;
    const left = Math.min(width * 0.4, Math.max(...spec.x.map((label) => label.length)) * 6.5 + 12);
    const right = width - 36;
    const x = (value: number) => left + ((value - lo) / (hi - lo || 1)) * (right - left);
    const marks: TemplateResult[] = [];
    spec.x.forEach((_, i) => {
      const groupHeight = rowHeight - 10;
      const barHeight = Math.max(2, (groupHeight - (k - 1) * 2) / k);
      let positive = 0;
      let negative = 0;
      const lastPositive = spec.series.findLastIndex((series) => (series.values[i] ?? 0) > 0);
      const lastNegative = spec.series.findLastIndex((series) => (series.values[i] ?? 0) < 0);
      spec.series.forEach((series, s) => {
        const value = series.values[i];
        if (value === null) return;
        let from = 0;
        let to = value;
        let yy = i * rowHeight + 5 + s * (barHeight + 2);
        let round = true;
        if (spec.stacked) {
          yy = i * rowHeight + 5;
          from = value >= 0 ? positive : negative;
          to = from + value;
          if (value >= 0) positive = to;
          else negative = to;
          round = s === (value >= 0 ? lastPositive : lastNegative);
        }
        marks.push(
          svg`<path class="mark ${this.hover === i ? "on" : ""}" d=${hbarPath(yy, x(from) + (spec.stacked && from !== 0 ? Math.sign(value) : 0), x(to), barHeight, round)} fill="var(--s${s + 1})"></path>`,
        );
      });
    });
    return html`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label=${this.summary(spec, format)}>
      ${ticks.map(
        (tick) => svg`<line class="grid" x1=${x(tick)} x2=${x(tick)} y1="0" y2=${n * rowHeight}></line>
          <text class="axis-label" x=${x(tick)} y=${n * rowHeight + 18} text-anchor="middle">${format.axis(tick)}</text>`,
      )}
      ${marks}
      ${spec.x.map(
        (label, i) =>
          svg`<text class="axis-label" x=${left - 8} y=${i * rowHeight + rowHeight / 2 + 4} text-anchor="end">${label.length > Math.floor(left / 6.5) ? `${label.slice(0, Math.floor(left / 6.5) - 1)}…` : label}</text>
            <rect x="0" y=${i * rowHeight} width=${width} height=${rowHeight} fill="transparent" @pointerenter=${() => (this.hover = i)}></rect>`,
      )}
    </svg>`;
  }

  private pie(spec: ChartSpec, format: Formatter): TemplateResult {
    const values = spec.series[0]!.values.map((value) => value ?? 0);
    if (!values.some((value) => value > 0))
      return html`<p class="status" role="status">Nothing to draw: every value is zero.</p>`;
    const total = values.reduce((sum, value) => sum + value, 0);
    const c = PIE_SIZE / 2;
    const outer = c - 4;
    const inner = spec.type === "donut" ? outer * 0.6 : 0;
    let angle = 0;
    return html`<svg
      viewBox="0 0 ${PIE_SIZE} ${PIE_SIZE}"
      style="max-width:${PIE_SIZE}px;margin:auto"
      role="img"
      aria-label=${this.summary(spec, format)}
    >
      ${values.map((value, i) => {
        const start = angle;
        angle += (value / total) * Math.PI * 2;
        if (value <= 0) return nothing;
        return svg`<path class="mark ${this.hover === i ? "on" : ""}" d=${arcPath(c, c, this.hover === i ? outer + 3 : outer, inner, start, angle)}
          fill="var(--s${(i % MAX_SERIES) + 1})" stroke="var(--surface)" stroke-width="2" @pointerenter=${() => (this.hover = i)}></path>`;
      })}
      ${
        spec.type === "donut"
          ? svg`<text x=${c} y=${c + 5} text-anchor="middle" style="font-size:15px;font-weight:600;fill:var(--ink)">${total < 100000 ? format.full(total) : format.axis(total)}</text>`
          : nothing
      }
    </svg>`;
  }

  private tooltip(spec: ChartSpec, format: Formatter): TemplateResult | typeof nothing {
    const i = this.hover;
    if (i < 0 || i >= spec.x.length) return nothing;
    const pie = spec.type === "pie" || spec.type === "donut";
    if (pie) {
      const values = spec.series[0]!.values.map((value) => value ?? 0);
      const total = values.reduce((sum, value) => sum + value, 0) || 1;
      return html`<div class="tip" style="left:50%;transform:translateX(-50%)">
        <div class="tip-row">
          <i class="swatch" style="background:var(--s${(i % MAX_SERIES) + 1})"></i>
          <span class="tip-head">${spec.x[i]}</span>
          <span class="tip-value"
            >${format.full(values[i]!)} ·
            ${formatter({ ...spec, format: "percent", decimals: undefined }).full(values[i]! / total)}</span
          >
        </div>
      </div>`;
    }
    const horizontal = spec.type === "bar" && spec.horizontal;
    const position = horizontal ? 50 : ((i + 0.5) / spec.x.length) * 100;
    let offset = position > 50 ? "translateX(calc(-100% - 16px))" : "translateX(16px)";
    if (horizontal) offset = "translateX(-50%)";
    const top = horizontal ? `top:${Math.min(70, ((i + 1) / spec.x.length) * 100)}%;` : "";
    return html`<div class="tip" style="left:${position}%;${top}transform:${offset}">
      <div class="tip-head">${spec.x[i]}</div>
      ${spec.series.map(
        (series, s) =>
          html`<div class="tip-row" style="display:flex">
            <i class="swatch" style="background:var(--s${s + 1})"></i>${series.name}
            <span class="tip-value">${series.values[i] === null ? "—" : format.full(series.values[i]!)}</span>
          </div>`,
      )}
      ${
        spec.stacked && spec.series.length > 1
          ? html`<div class="tip-row" style="display:flex">
              Total<span class="tip-value">${format.full(this.stackedTotals(spec)[i]!)}</span>
            </div>`
          : nothing
      }
    </div>`;
  }

  private table(spec: ChartSpec, format: Formatter): TemplateResult {
    return html`<table>
      <thead>
        <tr>
          <th></th>
          ${spec.series.map((series) => html`<th>${series.name}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${spec.x.map(
          (label, i) =>
            html`<tr>
              <th scope="row">${label}</th>
              ${spec.series.map(
                (series) =>
                  html`<td class="num">${series.values[i] === null ? "—" : format.full(series.values[i]!)}</td>`,
              )}
            </tr>`,
        )}
      </tbody>
    </table>`;
  }

  private summary(spec: ChartSpec, format: Formatter): string {
    const series = spec.series
      .map(
        (entry) =>
          `${entry.name}: ${entry.values
            .map((value, i) => `${spec.x[i]} ${value === null ? "—" : format.full(value)}`)
            .join(", ")}`,
      )
      .join("; ");
    return `${spec.title ?? "Chart"}. ${series}`.slice(0, 2000);
  }
}

if (!customElements.get("qm-chart")) customElements.define("qm-chart", ChartBlock);
