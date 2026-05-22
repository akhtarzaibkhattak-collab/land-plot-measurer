import TextRecognition from "@react-native-ml-kit/text-recognition";

export async function recognizeMeasurements(uri: string): Promise<number[]> {
  try {
    const result = await TextRecognition.recognize(uri);
    const fullText = result.text ?? "";
    const regex = /(\d+(?:\.\d+)?)\s*(?:feet|foot|ft|')/gi;
    const found: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(fullText)) !== null) {
      const v = parseFloat(m[1]);
      if (v > 0 && !found.includes(v)) found.push(v);
    }
    return found;
  } catch {
    return [];
  }
}
