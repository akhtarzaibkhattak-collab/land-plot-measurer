import TextRecognition from "@react-native-ml-kit/text-recognition";

export interface MeasurementBlock {
  value: number;
  label: string;
  cx: number;
  cy: number;
}

export interface ScannedSides {
  top:    number | null;
  right:  number | null;
  bottom: number | null;
  left:   number | null;
  extra:  number[];
}

export async function recognizeMeasurements(_uri: string): Promise<number[]> {
  const result = await recognizeMeasurementsAdvanced(_uri);
  const sides = assignSides(result);
  const all = [sides.top, sides.right, sides.bottom, sides.left, ...sides.extra]
    .filter((v): v is number => v !== null);
  return [...new Set(all)];
}

export async function recognizeMeasurementsAdvanced(uri: string): Promise<MeasurementBlock[]> {
  try {
    const result = await TextRecognition.recognize(uri);
    const blocks: MeasurementBlock[] = [];
    const measureRe = /(\d+(?:\.\d+)?)\s*(?:feet|foot|ft|'|m\b|meters?)?/gi;

    for (const block of result.blocks ?? []) {
      for (const line of block.lines ?? []) {
        const text = line.text ?? "";
        const frame = (line as { frame?: { top: number; left: number; width: number; height: number } }).frame;
        if (!frame) continue;
        const cx = frame.left + frame.width  / 2;
        const cy = frame.top  + frame.height / 2;

        measureRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = measureRe.exec(text)) !== null) {
          const v = parseFloat(m[1]);
          if (v >= 1 && v <= 99999) {
            blocks.push({ value: v, label: `${v} FT`, cx, cy });
          }
        }
      }
    }

    return blocks;
  } catch {
    return [];
  }
}

export function assignSides(blocks: MeasurementBlock[]): ScannedSides {
  if (blocks.length === 0) {
    return { top: null, right: null, bottom: null, left: null, extra: [] };
  }

  const minX = Math.min(...blocks.map(b => b.cx));
  const maxX = Math.max(...blocks.map(b => b.cx));
  const minY = Math.min(...blocks.map(b => b.cy));
  const maxY = Math.max(...blocks.map(b => b.cy));
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const normalized = blocks.map(b => ({
    ...b,
    nx: (b.cx - minX) / rangeX,
    ny: (b.cy - minY) / rangeY,
  }));

  const TOP_THRESH    = 0.28;
  const BOTTOM_THRESH = 0.72;
  const LEFT_THRESH   = 0.28;
  const RIGHT_THRESH  = 0.72;

  const sides: ScannedSides = { top: null, right: null, bottom: null, left: null, extra: [] };

  const assigned = new Set<number>();

  const pickBest = (candidates: typeof normalized, prefer: "largest" | "any" = "any") => {
    if (!candidates.length) return null;
    const sorted = prefer === "largest"
      ? [...candidates].sort((a, b) => b.value - a.value)
      : candidates;
    for (const c of sorted) {
      if (!assigned.has(c.value)) {
        assigned.add(c.value);
        return c.value;
      }
    }
    return null;
  };

  const topCands    = normalized.filter(b => b.ny <= TOP_THRESH);
  const bottomCands = normalized.filter(b => b.ny >= BOTTOM_THRESH);
  const leftCands   = normalized.filter(b => b.nx <= LEFT_THRESH && b.ny > TOP_THRESH && b.ny < BOTTOM_THRESH);
  const rightCands  = normalized.filter(b => b.nx >= RIGHT_THRESH && b.ny > TOP_THRESH && b.ny < BOTTOM_THRESH);

  sides.top    = pickBest(topCands.sort((a, b) => a.ny - b.ny));
  sides.bottom = pickBest(bottomCands.sort((a, b) => b.ny - a.ny));
  sides.left   = pickBest(leftCands.sort((a, b) => a.nx - b.nx));
  sides.right  = pickBest(rightCands.sort((a, b) => b.nx - a.nx));

  for (const b of normalized) {
    if (!assigned.has(b.value)) {
      sides.extra.push(b.value);
    }
  }

  return sides;
}
