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

export function cellNumber(raw: string): number | null {
  let value = raw
    .replace(/\s/g, "")
    .replace(/^[^\d+\-−(]*/, "")
    .replace(/[^\d.,)]*$/, "");
  if (!value) return null;
  const negative = /^[-−]/.test(value) || /^\(.*\)$/.test(value);
  value = value.replace(/^[-−+(]/, "").replace(/\)$/, "");
  const lastDot = value.lastIndexOf(".");
  const lastComma = value.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    value = value.replaceAll(decimal === "." ? "," : ".", "").replace(decimal, ".");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const separator = lastComma >= 0 ? "," : ".";
    const parts = value.split(separator);
    const thousands = parts.length > 2 || (parts.length === 2 && parts[1]!.length === 3 && separator === ".");
    value = thousands ? parts.join("") : parts.join(".");
  }
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return negative ? -number : number;
}

function cells(row: HTMLTableRowElement): string[] {
  return [...row.cells].map((cell) => (cell.textContent ?? "").trim());
}

export function tableRows(table: HTMLTableElement): string[][] {
  return [...table.rows].map(cells);
}

export function delimited(rows: string[][], separator: string): string {
  const quote = (value: string) =>
    value.includes(separator) || /["\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
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

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("click", this.onClick);
    this.addEventListener("keydown", this.onKeydown);
    addDocumentStyles();
    for (const header of this.headers()) {
      header.tabIndex = 0;
      header.setAttribute("aria-sort", "none");
    }
  }

  disconnectedCallback(): void {
    this.removeEventListener("click", this.onClick);
    this.removeEventListener("keydown", this.onKeydown);
    super.disconnectedCallback();
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
    const numeric = rows.every((row) => !key(row) || cellNumber(key(row)) !== null);
    const direction = this.sort === "descending" ? -1 : 1;
    rows.sort((a, b) => {
      if (this.sort === "none") return Number(a.dataset.order) - Number(b.dataset.order);
      if (numeric) return direction * ((cellNumber(key(a)) ?? -Infinity) - (cellNumber(key(b)) ?? -Infinity));
      return direction * key(a).localeCompare(key(b), undefined, { numeric: true, sensitivity: "base" });
    });
    body.append(...rows);
  }

  private async copy(): Promise<void> {
    const table = this.table();
    if (table) await navigator.clipboard?.writeText(delimited(tableRows(table), "\t"));
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
