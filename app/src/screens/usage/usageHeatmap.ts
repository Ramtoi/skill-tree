import type { UsageDailyPoint } from "@/features/usage/usageTypes";

export type HeatmapMode = "daily" | "weekly" | "cumulative";
export interface HeatmapGrid<T = HeatmapCell> {
  rows: number;
  columns: number;
  rowLabels: string[];
  columnLabels: string[];
  cells: T[];
}

export type HeatmapCell = {
  date: string;
  row: number;
  column: number;
  tokens: number;
  level: number;
  active: boolean;
  runningTotal: number;
  weekTokens: number;
};

export function moveIndex(index: number, key: string, shape: Pick<HeatmapGrid, "rows" | "columns"> = { rows: 7, columns: 52 }): number {
  const { rows, columns } = shape;
  if (rows <= 0 || columns <= 0) return 0;
  const safeIndex = Math.max(0, Math.min(rows * columns - 1, index));
  const column = Math.floor(safeIndex / rows);
  const row = safeIndex % rows;
  if (key === "ArrowRight") return Math.min((columns - 1) * rows + row, safeIndex + rows);
  if (key === "ArrowLeft") return Math.max(row, safeIndex - rows);
  if (key === "ArrowDown") return column * rows + Math.min(rows - 1, row + 1);
  if (key === "ArrowUp") return column * rows + Math.max(0, row - 1);
  if (key === "Home") return row;
  if (key === "End") return (columns - 1) * rows + row;
  return safeIndex;
}

export function moveIndexRowMajor(index: number, key: string, shape: Pick<HeatmapGrid, "rows" | "columns">): number {
  const { rows, columns } = shape;
  if (rows <= 0 || columns <= 0) return 0;
  const safeIndex = Math.max(0, Math.min(rows * columns - 1, index));
  const row = Math.floor(safeIndex / columns);
  const column = safeIndex % columns;
  if (key === "ArrowRight") return row * columns + Math.min(columns - 1, column + 1);
  if (key === "ArrowLeft") return row * columns + Math.max(0, column - 1);
  if (key === "ArrowDown") return Math.min((rows - 1) * columns + column, safeIndex + columns);
  if (key === "ArrowUp") return Math.max(column, safeIndex - columns);
  if (key === "Home") return row * columns;
  if (key === "End") return row * columns + columns - 1;
  return safeIndex;
}

export function monthLabelIndices(cells: HeatmapCell[]): number[] {
  return cells.filter((cell) => cell.row === 0 && (
    cell.column === 0 || cell.date.slice(0, 7) !== cells[(cell.column - 1) * 7].date.slice(0, 7)
  )).map((cell) => cell.column);
}

export function percentileLevels(values: number[], steps: number): number[] {
  if (values.length === 0) return [];
  const result = values.map(() => 0);
  const active = values.map((value, index) => ({ value, index })).filter((entry) => entry.value > 0);
  if (active.length === 0) return result;
  active.sort((a, b) => a.value - b.value);
  let start = 0;
  while (start < active.length) {
    let end = start;
    while (end + 1 < active.length && active[end + 1].value === active[start].value) end += 1;
    const level = Math.ceil(((end + 1) / active.length) * steps);
    for (let index = start; index <= end; index += 1) result[active[index].index] = level;
    start = end + 1;
  }
  return result;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function mondayOf(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return new Date("1970-01-01T00:00:00Z");
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return date;
}

export function heatmapCells(daily: UsageDailyPoint[], windowEnd: string, mode: HeatmapMode): HeatmapCell[] {
  const anchor = mondayOf(windowEnd);
  anchor.setUTCDate(anchor.getUTCDate() - 51 * 7);
  const values = new Map(daily.map((point) => [point.date.slice(0, 10), point.tokens.total]));
  const dates = Array.from({ length: 364 }, (_, index) => {
    const date = new Date(anchor);
    date.setUTCDate(anchor.getUTCDate() + index);
    return isoDate(date);
  });
  const tokens = dates.map((date) => values.get(date) ?? 0);
  const running: number[] = [];
  let total = 0;
  for (const value of tokens) {
    total += value;
    running.push(total);
  }
  const rankValues = mode === "cumulative" ? tokens.map((value, index) => (value > 0 ? running[index] : 0)) : tokens;
  const levels = percentileLevels(rankValues, 5);
  const weekTotals = Array.from({ length: 52 }, (_, week) => tokens.slice(week * 7, week * 7 + 7).reduce((a, b) => a + b, 0));
  const maxWeek = Math.max(0, ...weekTotals);
  return dates.map((date, index) => {
    const week = Math.floor(index / 7);
    const day = index % 7;
    const weekLevel = maxWeek > 0 ? Math.ceil((weekTotals[week] / maxWeek) * 7) : 0;
    return {
      date,
      row: day,
      column: week,
      tokens: tokens[index],
      // Weekly is a bar, not a calendar: the column's squares fill from the
      // bottom in proportion to the busiest week, whichever days were active.
      // Daily and Cumulative keep inactive days empty (design W1).
      level: mode === "weekly" ? (day >= 7 - weekLevel ? 5 : 0) : levels[index],
      active: tokens[index] > 0,
      runningTotal: running[index],
      weekTokens: weekTotals[week],
    };
  });
}
