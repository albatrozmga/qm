export type ValueFormat = "number" | "percent" | "currency";

export interface FormatSpec {
  format?: ValueFormat;
  currency?: string;
  decimals?: number;
  locale?: string;
}

export interface Formatter {
  full(value: number): string;
  axis(value: number): string;
}

function locale(spec: FormatSpec): string {
  return spec.locale || navigator.language || "en-US";
}

function safeFormat(tag: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(tag, options);
  } catch {
    return new Intl.NumberFormat("en-US", options);
  }
}

export function formatter(spec: FormatSpec): Formatter {
  const tag = locale(spec);
  const digits = spec.decimals === undefined ? undefined : Math.max(0, Math.min(6, Math.floor(spec.decimals)));
  const fixed = digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  if (spec.format === "percent") {
    const full = safeFormat(tag, { style: "percent", maximumFractionDigits: 1, ...fixed });
    const axis = safeFormat(tag, { style: "percent", maximumFractionDigits: 1 });
    return { full: (v) => full.format(v), axis: (v) => axis.format(v) };
  }
  if (spec.format === "currency") {
    const currency = /^[A-Z]{3}$/.test(spec.currency ?? "") ? spec.currency! : "BRL";
    const full = safeFormat(tag, { style: "currency", currency, ...fixed });
    const axis = safeFormat(tag, { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 });
    return { full: (v) => full.format(v), axis: (v) => axis.format(v) };
  }
  const full = safeFormat(tag, { maximumFractionDigits: 2, ...fixed });
  const axis = safeFormat(tag, { notation: "compact", maximumFractionDigits: 1 });
  return { full: (v) => full.format(v), axis: (v) => axis.format(v) };
}

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) max = min === 0 ? 1 : min + Math.abs(min);
  const rough = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = ([1, 2, 5].find((candidate, index) => normalized < [1.5, 3, 7][index]!) ?? 10) * magnitude;
  const ticks: number[] = [];
  for (let tick = Math.floor(min / step) * step; tick <= Math.ceil(max / step) * step + step / 2; tick += step)
    ticks.push(Number(tick.toPrecision(12)));
  return ticks;
}
