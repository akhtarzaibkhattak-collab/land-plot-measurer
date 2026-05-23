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
  return [];
}

export async function recognizeMeasurementsAdvanced(_uri: string): Promise<MeasurementBlock[]> {
  return [];
}

export function assignSides(_blocks: MeasurementBlock[]): ScannedSides {
  return { top: null, right: null, bottom: null, left: null, extra: [] };
}
