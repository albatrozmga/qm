import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "http://localhost" });
for (const key of [
  "localStorage",
  "window",
  "document",
  "customElements",
  "HTMLElement",
  "Element",
  "Node",
  "Document",
  "CSSStyleSheet",
  "ShadowRoot",
] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
const { StableMarkdown } = await import("../src/stable-markdown.ts");
const { installMarkdownSanitizer } = await import("../src/markdown-sanitize.ts");
const { cellNumber, columnDecimal, delimited } = await import("../src/table-block.ts");
const { formatter, niceTicks } = await import("../src/viz-format.ts");
installMarkdownSanitizer();

async function mount(content: string, streaming = false): Promise<InstanceType<typeof StableMarkdown>> {
  const block = new StableMarkdown();
  block.isStreaming = streaming;
  document.body.append(block);
  block.content = content;
  await block.updateComplete;
  for (const child of block.querySelectorAll<HTMLElement & { updateComplete?: Promise<unknown> }>(
    "qm-chart, qm-kpi, qm-table",
  ))
    await child.updateComplete;
  return block;
}

const shadow = (element: Element | null): ShadowRoot => {
  assert.ok(element?.shadowRoot, "the component rendered");
  return element.shadowRoot;
};

const fence = (language: string, body: unknown) =>
  `Antes do bloco.\n\n\`\`\`${language}\n${JSON.stringify(body, null, 2)}\n\`\`\`\n\nDepois.`;

const premium = {
  type: "bar",
  title: "Prêmio emitido por mês",
  x: ["jul", "ago", "set"],
  series: [
    { name: "TN", values: [120000, 150000.5, null] },
    { name: "RCTR-C", values: [80000, 95000, 110000] },
  ],
  format: "currency",
  currency: "BRL",
  locale: "pt-BR",
};

test("a chart fence renders an accessible SVG chart with legend and a data table", async () => {
  const block = await mount(fence("chart", premium));
  const chart = block.querySelector("qm-chart");
  assert.equal(block.querySelectorAll("code-block").length, 0);
  const root = shadow(chart);
  assert.equal(root.querySelector(".title")?.textContent, "Prêmio emitido por mês");
  assert.equal(root.querySelectorAll(".mark").length, 5, "one bar per non-null value");
  assert.deepEqual(
    [...root.querySelectorAll(".legend span")].map((entry) => entry.textContent?.trim()),
    ["TN", "RCTR-C"],
  );
  const cells = [...root.querySelectorAll("table td")].map((cell) => cell.textContent?.replace(/\s/g, " "));
  assert.deepEqual(cells, ["R$ 120.000,00", "R$ 80.000,00", "R$ 150.000,50", "R$ 95.000,00", "—", "R$ 110.000,00"]);
  assert.match(root.querySelector("svg")!.getAttribute("aria-label")!, /TN: jul R\$/);
  block.remove();
});

test("hovering a category shows every series value in a tooltip", async () => {
  const block = await mount(fence("chart", { ...premium, type: "line" }));
  const chart = block.querySelector("qm-chart") as HTMLElement & { updateComplete: Promise<unknown> };
  const targets = shadow(chart).querySelectorAll("svg rect");
  targets[1]!.dispatchEvent(new window.Event("pointerenter"));
  await chart.updateComplete;
  const tip = shadow(chart).querySelector(".tip")!;
  assert.match(tip.textContent!, /ago/);
  assert.match(tip.textContent!.replace(/\s+/g, " "), /TN R\$ 150\.000,50/);
  block.remove();
});

test("pie and donut charts take one series and label slices with their share", async () => {
  const block = await mount(
    fence("chart", {
      type: "donut",
      x: ["TN", "RCTR-C", "RCV"],
      series: [{ name: "Apólices", values: [50, 30, 20] }],
      locale: "pt-BR",
    }),
  );
  const chart = block.querySelector("qm-chart") as HTMLElement & { updateComplete: Promise<unknown> };
  const slices = shadow(chart).querySelectorAll("path.mark");
  assert.equal(slices.length, 3);
  slices[0]!.dispatchEvent(new window.Event("pointerenter"));
  await chart.updateComplete;
  assert.match(shadow(chart).querySelector(".tip")!.textContent!.replace(/\s+/g, " "), /TN 50 · 50%/);
  block.remove();
});

test("an invalid chart spec explains the problem and keeps its source visible", async () => {
  const block = await mount(fence("chart", { type: "bar", x: ["a", "b"], series: [{ name: "s", values: [1] }] }));
  const root = shadow(block.querySelector("qm-chart"));
  assert.match(root.querySelector(".status")!.textContent!, /exactly one value per "x" label/);
  assert.match(root.querySelector("pre")!.textContent!, /"values"/);
  block.remove();
});

test("a chart streams as a placeholder and renders once the reply finishes", async () => {
  const block = await mount(fence("chart", premium), true);
  const chart = block.querySelector("qm-chart") as HTMLElement & { updateComplete: Promise<unknown> };
  assert.ok(chart.hasAttribute("pending"));
  assert.match(shadow(chart).textContent!, /when the reply finishes/);
  block.isStreaming = false;
  await block.updateComplete;
  await chart.updateComplete;
  assert.equal(block.querySelector("qm-chart"), chart);
  assert.ok(shadow(chart).querySelector("svg"));
  block.remove();
});

test("indicator cards format values and color deltas by whether up is good", async () => {
  const block = await mount(
    fence("kpi", {
      locale: "pt-BR",
      currency: "BRL",
      items: [
        { label: "Prêmio emitido", value: 1234567.89, format: "currency", delta: 0.12, deltaLabel: "vs. set" },
        { label: "Sinistralidade", value: 0.42, format: "percent", delta: 0.05, goodWhen: "down" },
        { label: "Apólices vigentes", value: 318 },
      ],
    }),
  );
  const root = shadow(block.querySelector("qm-kpi"));
  const values = [...root.querySelectorAll(".value")].map((value) => value.textContent?.replace(/\s/g, " "));
  assert.deepEqual(values, ["R$ 1.234.567,89", "42%", "318"]);
  const deltas = [...root.querySelectorAll(".delta")];
  assert.ok(deltas[0]!.classList.contains("good"));
  assert.match(deltas[0]!.textContent!.replace(/\s+/g, " "), /\+12%, favorable/);
  assert.ok(deltas[1]!.classList.contains("bad"), "a rising loss ratio is unfavorable");
  block.remove();
});

test("finished markdown tables gain sorting that understands Brazilian numbers", async () => {
  const markdown =
    "| Corretor | Prêmio |\n|---|---|\n| Alfa | R$ 1.200,00 |\n| Beta | R$ 950,50 |\n| Gama | R$ 12.000,00 |";
  const streaming = await mount(markdown, true);
  assert.equal(streaming.querySelector("qm-table"), null, "tables stay plain while streaming");
  streaming.remove();

  const block = await mount(markdown);
  const wrapper = block.querySelector("qm-table") as HTMLElement & { sortBy(column: number): void };
  assert.ok(wrapper?.querySelector("table"));
  const order = () =>
    [...wrapper.querySelectorAll<HTMLTableRowElement>("tbody tr")].map((row) => row.cells[0]!.textContent);
  wrapper.querySelectorAll("th")[1]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(order(), ["Beta", "Alfa", "Gama"]);
  assert.equal(wrapper.querySelectorAll("th")[1]!.getAttribute("aria-sort"), "ascending");
  wrapper.sortBy(1);
  assert.deepEqual(order(), ["Gama", "Alfa", "Beta"]);
  wrapper.sortBy(1);
  assert.deepEqual(order(), ["Alfa", "Beta", "Gama"], "a third click restores the original order");
  block.remove();
});

test("a column decides its decimal separator from its unambiguous cells", () => {
  assert.equal(columnDecimal(["R$ 1.234.567,89", "R$ 12,00"]), ",");
  assert.equal(columnDecimal(["$1,500", "$20.50"]), ".");
  assert.equal(columnDecimal(["0.125", "0.5"]), ".");
  assert.equal(cellNumber("R$ 1.234.567,89", ","), 1234567.89);
  assert.equal(cellNumber("$1,500", "."), 1500);
  assert.equal(cellNumber("42,5%", ","), 42.5);
  assert.equal(cellNumber("−3,2", ","), -3.2);
  assert.equal(cellNumber("(1.000)", ","), -1000);
  assert.equal(cellNumber("v1.2.3", "."), null);
  assert.equal(cellNumber("Alfa", ","), null);
});

test("an English money column with a placeholder still sorts numerically", async () => {
  const block = await mount(
    "| Broker | Premium |\n|---|---|\n| A | $1,500.00 |\n| B | — |\n| C | $20.50 |\n| D | $300.00 |",
  );
  const wrapper = block.querySelector("qm-table") as HTMLElement & { sortBy(column: number): void };
  wrapper.sortBy(1);
  assert.deepEqual(
    [...wrapper.querySelectorAll<HTMLTableRowElement>("tbody tr")].map((row) => row.cells[0]!.textContent),
    ["B", "C", "D", "A"],
  );
  block.remove();
});

test("a sorted table keeps its order and keyboard access through a re-render", async () => {
  const block = await mount("| Nome | Valor |\n|---|---|\n| Alfa | 3 |\n| Beta | 1 |\n| Gama | 2 |");
  const wrapper = block.querySelector("qm-table") as HTMLElement & { sortBy(column: number): void };
  wrapper.sortBy(1);
  block.isThinking = true;
  await block.updateComplete;
  const current = block.querySelector("qm-table")!;
  assert.deepEqual(
    [...current.querySelectorAll<HTMLTableRowElement>("tbody tr")].map((row) => row.cells[0]!.textContent),
    ["Beta", "Gama", "Alfa"],
  );
  assert.equal(current.querySelectorAll("th")[1]!.getAttribute("aria-sort"), "ascending");
  assert.equal(current.querySelectorAll("th")[0]!.getAttribute("tabindex"), "0");
  block.remove();
});

test("axis ticks stay bounded for near-equal, huge and opposite extreme values", () => {
  for (const [min, max] of [
    [0.3, 0.30000000000000004],
    [100, 100.00000000000001],
    [1e17, 1e17 + 16],
    [0, 1.7e308],
    [-1.7e308, 0],
    [-1e308, 1e308],
    [5, 5],
    [0, 0],
  ] as const) {
    const ticks = niceTicks(min, max);
    assert.ok(ticks.length >= 2 && ticks.length <= 51, `${min}..${max} gave ${ticks.length} ticks`);
    assert.ok(ticks.every(Number.isFinite), `${min}..${max} gave a non-finite tick`);
    assert.ok(ticks[0]! <= min && ticks.at(-1)! >= max, `${min}..${max} is covered`);
  }
  assert.deepEqual(niceTicks(0, 100), [0, 20, 40, 60, 80, 100]);
});

test("a near-flat line chart renders instead of hanging", async () => {
  const block = await mount(
    fence("chart", { type: "line", x: ["a", "b"], series: [{ name: "s", values: [0.3, 0.30000000000000004] }] }),
  );
  assert.ok(shadow(block.querySelector("qm-chart")).querySelector("svg path"));
  block.remove();
});

test("a lowercase currency code is honored and an unknown one is not shown as reais", () => {
  assert.match(formatter({ format: "currency", currency: "usd", locale: "en-US" }).full(2), /^\$2\.00$/);
  assert.equal(formatter({ format: "currency", currency: "reais", locale: "pt-BR" }).full(2), "2");
});

test("pie charts refuse more than eight slices and explain an all-zero total", async () => {
  const many = await mount(
    fence("chart", { type: "pie", x: [..."abcdefghi"], series: [{ name: "s", values: [1, 1, 1, 1, 1, 1, 1, 1, 1] }] }),
  );
  assert.match(shadow(many.querySelector("qm-chart")).querySelector(".status")!.textContent!, /at most 8 slices/);
  many.remove();
  const zero = await mount(fence("chart", { type: "pie", x: ["a", "b"], series: [{ name: "s", values: [0, 0] }] }));
  assert.match(shadow(zero.querySelector("qm-chart")).querySelector(".status")!.textContent!, /every value is zero/);
  zero.remove();
});

test("exported cells that look like formulas are made inert, numbers are kept", () => {
  assert.equal(
    delimited([['=HYPERLINK("http://x")', "-3,2", "+55 11", "@cmd"]], ";"),
    `"'=HYPERLINK(""http://x"")";-3,2;'+55 11;'@cmd`,
  );
});

test("exported text quotes separators, quotes and line breaks", () => {
  assert.equal(
    delimited(
      [
        ["Nome", "Obs"],
        ["Alfa; Ltda", 'disse "sim"'],
      ],
      ";",
    ),
    'Nome;Obs\r\n"Alfa; Ltda";"disse ""sim"""',
  );
});
