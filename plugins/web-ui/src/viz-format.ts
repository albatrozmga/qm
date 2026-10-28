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
    const currency = spec.currency?.toUpperCase() ?? "";
    if (!/^[A-Z]{3}$/.test(currency)) return formatter({ ...spec, format: "number" });
    const full = safeFormat(tag, { style: "currency", currency, ...fixed });
    const axis = safeFormat(tag, { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 });
    return { full: (v) => full.format(v), axis: (v) => axis.format(v) };
  }
  const full = safeFormat(tag, { maximumFractionDigits: 2, ...fixed });
  const axis = safeFormat(tag, { notation: "compact", maximumFractionDigits: 1 });
  return { full: (v) => full.format(v), axis: (v) => axis.format(v) };
}

const MAX_TICKS = 50;

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  const scale = Math.max(Math.abs(min), Math.abs(max));
  if (max - min <= scale * 1e-9) {
    const pad = scale ? scale * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  const rough = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = ([1, 2, 5].find((candidate, index) => normalized < [1.5, 3, 7][index]!) ?? 10) * magnitude;
  const first = Math.floor(min / step);
  const intervals = Math.ceil(max / step) - first;
  if (!(step > 0) || !Number.isFinite(step) || !Number.isFinite(intervals) || intervals < 1 || intervals > MAX_TICKS)
    return [min, max];
  const ticks = Array.from({ length: intervals + 1 }, (_, k) => Number(((first + k) * step).toPrecision(12)));
  return ticks.every(Number.isFinite) ? ticks : [min, max];
}
