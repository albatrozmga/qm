import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { formatter, type FormatSpec } from "./viz-format.ts";

interface KpiItem extends FormatSpec {
  label: string;
  value: number | string;
  delta?: number;
  deltaFormat?: "percent" | "number" | "currency";
  deltaLabel?: string;
  goodWhen?: "up" | "down";
  hint?: string;
}

const MAX_ITEMS = 12;
const DIRECTIONS = ["down", "flat", "up"] as const;
const ARROWS = { up: "▲", down: "▼", flat: "■" } as const;
const MEANINGS = { good: "favorable", bad: "unfavorable", "": "unchanged" } as const;

const text = (value: unknown, limit: number): string => String(value ?? "").slice(0, limit);

export function parseKpis(source: string): KpiItem[] {
  const raw = JSON.parse(source.trim()) as unknown;
  const shared = raw && !Array.isArray(raw) && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(raw) ? raw : shared.items;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ITEMS)
    throw new Error(`List 1 to ${MAX_ITEMS} indicators, as an array or under "items".`);
  return list.map((entry: unknown, index) => {
    const item = { ...shared, ...((entry ?? {}) as Record<string, unknown>) };
    if (typeof item.label !== "string" || !item.label.trim())
      throw new Error(`Indicator ${index + 1} needs a "label".`);
    const value = item.value;
    if (!(typeof value === "string" || (typeof value === "number" && Number.isFinite(value))))
      throw new Error(`Indicator ${index + 1} needs a numeric or text "value".`);
    const delta = item.delta;
    if (delta !== undefined && (typeof delta !== "number" || !Number.isFinite(delta)))
      throw new Error(`Indicator ${index + 1} has a "delta" that is not a number.`);
    return {
      label: text(item.label, 60),
      value: typeof value === "string" ? text(value, 40) : value,
      ...(delta !== undefined ? { delta } : {}),
      ...(item.format === "percent" || item.format === "currency" || item.format === "number"
        ? { format: item.format }
        : {}),
      ...(item.deltaFormat === "percent" || item.deltaFormat === "currency" || item.deltaFormat === "number"
        ? { deltaFormat: item.deltaFormat }
        : {}),
      ...(typeof item.currency === "string" ? { currency: item.currency } : {}),
      ...(typeof item.decimals === "number" ? { decimals: item.decimals } : {}),
      ...(typeof item.locale === "string" ? { locale: item.locale } : {}),
      ...(typeof item.deltaLabel === "string" ? { deltaLabel: text(item.deltaLabel, 60) } : {}),
      ...(item.goodWhen === "down" || item.goodWhen === "up" ? { goodWhen: item.goodWhen } : {}),
      ...(typeof item.hint === "string" ? { hint: text(item.hint, 120) } : {}),
    };
  });
}

function deltaText(item: KpiItem, delta: number): string {
  const format = formatter({
    ...item,
    format: item.deltaFormat ?? "percent",
    decimals: undefined,
  });
  const magnitude = format.full(Math.abs(delta));
  if (delta > 0) return `+${magnitude}`;
  if (delta < 0) return `−${magnitude}`;
  return magnitude;
}

export class KpiBlock extends LitElement {
  static properties = {
    code: {},
    pending: { type: Boolean, reflect: true },
  };

  declare code: string;
  declare pending: boolean;

  static styles = css`
    :host {
      display: block;
      min-width: 0;
      margin: 1em 0;
      --ink: var(--foreground, #0b0b0b);
      --ink-muted: var(--muted-foreground, #52514e);
      --rule: var(--border, #e4e3df);
      --good: #0ca30c;
      --critical: #d03b3b;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
      gap: 10px;
    }
    .card {
      border: 1px solid var(--rule);
      border-radius: 10px;
      padding: 12px 14px;
      font: 13px var(--app-font, system-ui);
      color: var(--ink);
      min-width: 0;
    }
    .label,
    .hint,
    .status,
    summary {
      color: var(--ink-muted);
      font-size: 12px;
    }
    .value {
      font-size: 20px;
      font-weight: 600;
      line-height: 1.25;
      margin: 4px 0 2px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow-x: auto;
    }
    .delta {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .delta.good {
      color: var(--good);
    }
    .delta.bad {
      color: var(--critical);
    }
    .delta .note {
      font-weight: 400;
      color: var(--ink-muted);
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
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("code") || changed.has("pending"))
      this.dispatchEvent(new window.Event("qm-content-updated", { bubbles: true, composed: true }));
  }

  protected render(): TemplateResult {
    if (this.pending) return html`<p class="status" role="status">Indicators will render when the reply finishes.</p>`;
    let items: KpiItem[];
    try {
      items = parseKpis(this.code);
    } catch (error) {
      return html`<p class="status" role="status">
          Unable to render these indicators: ${error instanceof Error ? error.message : "invalid spec"}
        </p>
        <details open>
          <summary>Source</summary>
          <pre><code>${this.code}</code></pre>
        </details>`;
    }
    return html`<div class="grid">${items.map((item) => this.card(item))}</div>`;
  }

  private card(item: KpiItem): TemplateResult {
    const value = typeof item.value === "number" ? formatter(item).full(item.value) : item.value;
    let delta: TemplateResult | typeof nothing = nothing;
    if (item.delta !== undefined) {
      const direction = DIRECTIONS[Math.sign(item.delta) + 1]!;
      let tone: "" | "good" | "bad" = "";
      if (direction !== "flat") tone = direction === (item.goodWhen ?? "up") ? "good" : "bad";
      const arrow = ARROWS[direction];
      const meaning = MEANINGS[tone];
      delta = html`<span class="delta ${tone}" aria-label="${deltaText(item, item.delta)}, ${meaning}">
        <span aria-hidden="true">${arrow}</span>${deltaText(item, item.delta)}
        ${item.deltaLabel ? html`<span class="note">${item.deltaLabel}</span>` : nothing}
      </span>`;
    }
    return html`<div class="card">
      <div class="label">${item.label}</div>
      <div class="value">${value}</div>
      ${delta} ${item.hint ? html`<div class="hint">${item.hint}</div>` : nothing}
    </div>`;
  }
}

if (!customElements.get("qm-kpi")) customElements.define("qm-kpi", KpiBlock);
