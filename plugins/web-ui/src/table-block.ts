import { LitElement, css, html, type TemplateResult } from "lit";

const SORTS = ["ascending", "descending", "none"] as const;
type Sort = (typeof SORTS)[number];

let documentStylesAdded = false;

function addDocumentStyles(): void {
  if (documentStylesAdded || !document.adoptedStyleSheets) return;
  documentStylesAdded = true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    qm-table th { cursor: pointer; user-select: none; }
    qm-table th:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
    qm-table th[aria-sort="ascending"]::after { content: " ▲"; font-size: 0.75em; opacity: 0.7; }
    qm-table th[aria-sort="descending"]::after { content: " ▼"; font-size: 0.75em; opacity: 0.7; }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

type Decimal = "," | ".";

const PLACEHOLDER = /^(?:[-–—]+|\?|n\.?\/?a\.?|n\/d|s\/d)$/i;

export function emptyCell(raw: string): boolean {
  const value = raw.trim();
  return !value || PLACEHOLDER.test(value);
}

function numericCore(raw: string): string {
  return raw
    .replace(/\s/g, "")
    .replace(/^[^\d+\-−(]*/, "")
    .replace(/[^\d.,)]*$/, "");
}

export function cellNumber(raw: string, decimal: Decimal): number | null {
  let value = numericCore(raw);
  if (!value) return null;
  const negative = /^[-−]/.test(value) || /^\(.*\)$/.test(value);
  value = value
    .replace(/^[-−+(]/, "")
    .replace(/\)$/, "")
    .replaceAll(decimal === "," ? "." : ",", "");
  if (decimal === ",") value = value.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return negative ? -number : number;
}

export function columnDecimal(values: string[]): Decimal {
  const cores = values.map(numericCore).filter(Boolean);
  for (const value of cores) {
    const lead = /^[-−+(]?0([.,])\d/.exec(value);
    if (lead) return lead[1] as Decimal;
    const dot = value.lastIndexOf(".");
    const comma = value.lastIndexOf(",");
    if (dot >= 0 && comma >= 0) return dot > comma ? "." : ",";
    if (/,\d{1,2}$|,\d{4,}$/.test(value) || /\.\d{3}\./.test(value)) return ",";
    if (/\.\d{1,2}$|\.\d{4,}$/.test(value) || /,\d{3},/.test(value)) return ".";
  }
  const grouped = cores
    .filter((value) => /[.,]/.test(value))
    .map((value) => /^[-−+(]?\d{1,3}([.,])\d{3}\)?$/.exec(value)?.[1]);
  if (grouped.length && grouped.every((separator) => separator === grouped[0]) && grouped[0])
    return grouped[0] === "." ? "," : ".";
  return (1.5).toLocaleString().includes(",") ? "," : ".";
}

export function tableSignature(table: HTMLTableElement): string {
  let hash = 0x811c9dc5;
  for (const character of table.outerHTML) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return `${table.outerHTML.length}-${(hash >>> 0).toString(36)}`;
}

function cells(row: HTMLTableRowElement): string[] {
  return [...row.cells].map((cell) => (cell.textContent ?? "").trim());
}

export function tableRows(table: HTMLTableElement): string[][] {
  return [...table.rows].map(cells);
}

function inert(value: string): string {
  if (!/^[=+\-@\t\r]/.test(value) || /^[-+]\d[\d.,]*%?$/.test(value)) return value;
  return `'${value}`;
}

export function delimited(rows: string[][], separator: string): string {
  const quote = (cell: string) => {
    const value = inert(cell);
    return value.includes(separator) || /["\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  };
  return rows.map((row) => row.map(quote).join(separator)).join("\r\n");
}

export class TableBlock extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      min-width: 0;
    }
    .tools {
      position: absolute;
      top: -10px;
      right: 0;
      display: flex;
      gap: 4px;
      opacity: 0;
      transition: opacity 120ms;
      z-index: 1;
    }
    :host(:hover) .tools,
    :host(:focus-within) .tools {
      opacity: 1;
    }
    button {
      font: 11px var(--app-font, system-ui);
      color: var(--muted-foreground, #52514e);
      background: var(--card, #fff);
      border: 1px solid var(--border, #e4e3df);
      border-radius: 6px;
      padding: 2px 8px;
      cursor: pointer;
    }
    button:hover {
      color: var(--foreground, #0b0b0b);
    }
    .scroll {
      overflow-x: auto;
    }
  `;

  private sortColumn = -1;
  private sort: Sort = "none";
  private observer?: MutationObserver;

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("click", this.onClick);
    this.addEventListener("keydown", this.onKeydown);
    addDocumentStyles();
    this.observer = new window.MutationObserver(() => {
      this.sortColumn = -1;
      this.sort = "none";
      this.prepare();
    });
    this.observer.observe(this, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["tabindex", "aria-sort"],
    });
    this.prepare();
  }

  disconnectedCallback(): void {
    this.removeEventListener("click", this.onClick);
    this.removeEventListener("keydown", this.onKeydown);
    this.observer?.disconnect();
    super.disconnectedCallback();
  }

  private prepare(): void {
    for (const header of this.headers()) {
      header.tabIndex = 0;
      header.setAttribute("aria-sort", "none");
    }
    this.observer?.takeRecords();
  }

  protected render(): TemplateResult {
    return html`<div class="tools">
        <button type="button" @click=${() => void this.copy()} title="Copy as tab-separated text for spreadsheets">
          Copy
        </button>
        <button type="button" @click=${() => this.download()} title="Download as CSV">CSV</button>
      </div>
      <div class="scroll"><slot></slot></div>`;
  }

  private table(): HTMLTableElement | null {
    return this.querySelector("table");
  }

  private headers(): HTMLTableCellElement[] {
    const head = this.table()?.tHead?.rows[0];
    return head ? [...head.cells] : [];
  }

  private onClick = (event: Event): void => {
    const header = (event.target as Element | null)?.closest?.("th");
    if (!header || !this.headers().includes(header as HTMLTableCellElement)) return;
    this.sortBy(this.headers().indexOf(header as HTMLTableCellElement));
  };

  private onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const header = (event.target as Element | null)?.closest?.("th");
    if (!header || !this.headers().includes(header as HTMLTableCellElement)) return;
    event.preventDefault();
    this.sortBy(this.headers().indexOf(header as HTMLTableCellElement));
  };

  sortBy(column: number): void {
    const body = this.table()?.tBodies[0];
    if (!body) return;
    const rows = [...body.rows];
    rows.forEach((row, index) => (row.dataset.order ??= String(index)));
    this.sort = column === this.sortColumn ? SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length]! : "ascending";
    this.sortColumn = column;
    this.headers().forEach((header, index) => header.setAttribute("aria-sort", index === column ? this.sort : "none"));
    const key = (row: HTMLTableRowElement) => (row.cells[column]?.textContent ?? "").trim();
    const filled = rows.map(key).filter((value) => !emptyCell(value));
    const decimal = columnDecimal(filled);
    const numeric = filled.length > 0 && filled.every((value) => cellNumber(value, decimal) !== null);
    const number = (row: HTMLTableRowElement) =>
      emptyCell(key(row)) ? -Infinity : (cellNumber(key(row), decimal) ?? -Infinity);
    const direction = this.sort === "descending" ? -1 : 1;
    rows.sort((a, b) => {
      if (this.sort === "none") return Number(a.dataset.order) - Number(b.dataset.order);
      if (numeric) return direction * (number(a) - number(b) || 0);
      return direction * key(a).localeCompare(key(b), undefined, { numeric: true, sensitivity: "base" });
    });
    body.append(...rows);
    this.observer?.takeRecords();
  }

  private async copy(): Promise<void> {
    const table = this.table();
    if (!table) return;
    await navigator.clipboard?.writeText(delimited(tableRows(table), "\t")).catch(() => undefined);
  }

  private download(): void {
    const table = this.table();
    if (!table) return;
    const decimalComma = (1.5).toLocaleString().includes(",");
    const csv = `\uFEFF${delimited(tableRows(table), decimalComma ? ";" : ",")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "table.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

if (!customElements.get("qm-table")) customElements.define("qm-table", TableBlock);
