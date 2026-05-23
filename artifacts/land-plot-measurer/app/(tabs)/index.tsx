import { Feather } from "@expo/vector-icons";
import { recognizeMeasurementsAdvanced, assignSides } from "@/utils/textRecognition";
import type { ScannedSides } from "@/utils/textRecognition";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  GestureResponderEvent,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  PanResponderGestureState,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  G,
  Image as SvgImage,
  Line,
  Polygon as SvgPolygon,
  Polyline,
  Rect,
  Text as SvgText,
} from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { usePlotStorage } from "@/contexts/PlotStorage";

const { height: SCREEN_H } = Dimensions.get("window");

const CLOSE_THRESHOLD  = 28;
const DRAG_THRESHOLD   = 24;
const LABEL_TAP_RADIUS = 36; // px radius around midpoint for override tap
const MARLA_SQ_FT      = 272.25;

// ─── Types ────────────────────────────────────────────────────────────────────
interface Point { x: number; y: number }
type SplitAxis = "x" | "y";

interface ChordInfo {
  start: number;
  end: number;
  mid: number;
  fixedV: number;
  lengthFt: number;
}

interface StripInfo {
  polygon: Point[];
  sqFt: number;
  marlas: number;
  centroid: Point;
}

interface LabeledSeg {
  a: Point;
  b: Point;
  pixLen: number;
  iA?: number;
  iB?: number;
}

// ─── Pure geometry ────────────────────────────────────────────────────────────

function dist(a: Point, b: Point) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function shoelaceArea(pts: Point[]) {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(area) / 2;
}

function polygonCentroid(pts: Point[]): Point {
  if (!pts.length) return { x: 0, y: 0 };
  let cx = 0, cy = 0;
  pts.forEach(p => { cx += p.x; cy += p.y; });
  return { x: cx / pts.length, y: cy / pts.length };
}

/** Sutherland-Hodgman single half-plane clip. axis='x' → vertical line; axis='y' → horizontal. */
function clipByHalf(pts: Point[], v: number, keepLess: boolean, axis: SplitAxis): Point[] {
  if (!pts.length) return [];
  const main   = (p: Point) => axis === "x" ? p.x : p.y;
  const perp   = (p: Point) => axis === "x" ? p.y : p.x;
  const make   = (m: number, p: number): Point => axis === "x" ? { x: m, y: p } : { x: p, y: m };
  const inside = (p: Point) => keepLess ? main(p) <= v + 0.001 : main(p) >= v - 0.001;
  const result: Point[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const curr = pts[i], next = pts[(i + 1) % n];
    const ci = inside(curr), ni = inside(next);
    if (ci) result.push(curr);
    if (ci !== ni) {
      const dm = main(next) - main(curr);
      if (Math.abs(dm) > 0.0001) {
        const t = (v - main(curr)) / dm;
        result.push(make(v, perp(curr) + t * (perp(next) - perp(curr))));
      }
    }
  }
  return result;
}

function clipToBand(pts: Point[], v1: number, v2: number, axis: SplitAxis): Point[] {
  return clipByHalf(clipByHalf(pts, v2, true, axis), v1, false, axis);
}

/** Cumulative area of polygon clipped to the "less" side of v. */
function areaLeftOf(pts: Point[], v: number, axis: SplitAxis): number {
  if (pts.length < 3) return 0;
  const clipped = clipByHalf(pts, v, true, axis);
  return clipped.length < 3 ? 0 : shoelaceArea(clipped);
}

/**
 * Equal-area binary search.
 * Returns cut values such that each strip has exactly totalArea/numDiv area.
 */
function findEqualAreaCuts(pts: Point[], numDiv: number, axis: SplitAxis): number[] {
  if (numDiv <= 1 || pts.length < 3) return [];
  const totalArea = shoelaceArea(pts);
  if (totalArea < 0.001) return [];
  const coords = pts.map(p => axis === "x" ? p.x : p.y);
  const minV = Math.min(...coords);
  const maxV = Math.max(...coords);
  const cuts: number[] = [];
  for (let i = 1; i < numDiv; i++) {
    const targetArea = (totalArea * i) / numDiv;
    let lo = minV, hi = maxV;
    for (let iter = 0; iter < 64; iter++) {
      const mid = (lo + hi) / 2;
      if (areaLeftOf(pts, mid, axis) < targetArea) lo = mid; else hi = mid;
    }
    cuts.push((lo + hi) / 2);
  }
  return cuts;
}

function getChord(pts: Point[], v: number, axis: SplitAxis): ChordInfo | null {
  const perps: number[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const am = axis === "x" ? a.x : a.y;
    const bm = axis === "x" ? b.x : b.y;
    const ap = axis === "x" ? a.y : a.x;
    const bp = axis === "x" ? b.y : b.x;
    if (v < Math.min(am, bm) - 0.001 || v > Math.max(am, bm) + 0.001) continue;
    if (Math.abs(bm - am) < 0.0001) continue;
    const t = (v - am) / (bm - am);
    if (t >= -0.001 && t <= 1.001) perps.push(ap + t * (bp - ap));
  }
  if (perps.length < 2) return null;
  perps.sort((a, b) => a - b);
  const start = perps[0], end = perps[perps.length - 1];
  return { start, end, mid: (start + end) / 2, fixedV: v, lengthFt: 0 };
}

function getSides(pts: Point[], closed: boolean): [Point, Point][] {
  const s: [Point, Point][] = [];
  for (let i = 0; i < pts.length - 1; i++) s.push([pts[i], pts[i + 1]]);
  if (closed && pts.length >= 3) s.push([pts[pts.length - 1], pts[0]]);
  return s;
}

function lineAngle(a: Point, b: Point): number {
  let ang = Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI);
  if (ang > 90)  ang -= 180;
  if (ang < -90) ang += 180;
  return ang;
}

/** True if both a and b sit on the same division line. */
function isOnDivisionLine(a: Point, b: Point, divLines: number[], axis: SplitAxis): boolean {
  const getC = (p: Point) => axis === "x" ? p.x : p.y;
  return divLines.some(v => Math.abs(getC(a) - v) < 0.8 && Math.abs(getC(b) - v) < 0.8);
}

/** True if [a,b] is an original outer-polygon edge (both points exact vertices, consecutive). */
function isFullOuterEdge(a: Point, b: Point, outerPts: Point[]): boolean {
  const eps = 0.8;
  const ai = outerPts.findIndex(p => dist(p, a) < eps);
  const bi = outerPts.findIndex(p => dist(p, b) < eps);
  if (ai < 0 || bi < 0) return false;
  const n = outerPts.length;
  return Math.abs(ai - bi) === 1 || (ai === 0 && bi === n - 1) || (bi === 0 && ai === n - 1);
}

// ─── PDF helpers ──────────────────────────────────────────────────────────────

function buildPDFSvg(
  points: Point[],
  divLines: number[],
  axis: SplitAxis,
  strips: StripInfo[],
  stripSubEdges: Array<{ a: Point; b: Point }>,
  px2ft: number | null,
  canvasSize: { w: number; h: number },
  orientation: "portrait" | "landscape",
  lineColor: string,
  labelColor: string
): string {
  // Target plot area width (leaving room for outside labels)
  const PAD    = 48;   // padding so outside labels are never clipped
  const plotW  = orientation === "landscape" ? 710 : 490;
  const sc     = canvasSize.w > 0 ? plotW / canvasSize.w : 1;
  const plotH  = canvasSize.h > 0 ? canvasSize.h * sc : plotW * 0.56;
  const W      = plotW + PAD * 2;
  const H      = Math.round(plotH + PAD * 2);

  // Coordinate helpers — include PAD offset so plot floats centred in SVG
  const sx  = (v: number) => (v * sc + PAD).toFixed(1);
  const sy  = (v: number) => (v * sc + PAD).toFixed(1);
  const svgPts = points.map(p => `${sx(p.x)},${sy(p.y)}`).join(" ");

  // Centroid in scaled+padded coords (for outside-label direction)
  const raw = polygonCentroid(points);
  const csx = raw.x * sc + PAD;
  const csy = raw.y * sc + PAD;

  let c = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  c += `<rect width="${W}" height="${H}" fill="#f8fafc"/>`;
  // Subtle grid
  c += `<defs>`;
  c += `  <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">`;
  c += `    <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e2e8f0" stroke-width="0.4"/>`;
  c += `  </pattern>`;
  c += `  <clipPath id="pdfpc"><polygon points="${svgPts}"/></clipPath>`;
  c += `</defs>`;
  c += `<rect width="${W}" height="${H}" fill="url(#grid)"/>`;
  c += `<polygon points="${svgPts}" fill="${lineColor}15" stroke="${lineColor}" stroke-width="2.2" stroke-linejoin="round"/>`;

  // Division lines (clipped inside polygon)
  divLines.forEach(v => {
    if (axis === "x") {
      c += `<line x1="${sx(v)}" y1="${PAD}" x2="${sx(v)}" y2="${(plotH + PAD).toFixed(1)}" stroke="#0d9488" stroke-width="1.5" stroke-dasharray="6,3" clip-path="url(#pdfpc)"/>`;
    } else {
      c += `<line x1="${PAD}" y1="${sy(v)}" x2="${(plotW + PAD).toFixed(1)}" y2="${sy(v)}" stroke="#0d9488" stroke-width="1.5" stroke-dasharray="6,3" clip-path="url(#pdfpc)"/>`;
    }
  });

  if (px2ft) {
    // ── Outer boundary labels — pushed OUTSIDE using centroid direction ──
    getSides(points, true).forEach(([a, b]) => {
      const smx  = (a.x + b.x) / 2 * sc + PAD;
      const smy  = (a.y + b.y) / 2 * sc + PAD;
      const ftLen = dist(a, b) / px2ft;
      const ang   = lineAngle(a, b);
      const rad   = Math.atan2(b.y - a.y, b.x - a.x);
      const nnx   = -Math.sin(rad), nny = Math.cos(rad);
      const dot   = (csx - smx) * nnx + (csy - smy) * nny;
      const sign  = dot > 0 ? -1 : 1;
      const LOFF  = 22;
      const offX  = sign * nnx * LOFF, offY = sign * nny * LOFF;
      const lbl   = `${ftLen.toFixed(1)} FT`;
      const lw    = lbl.length * 5.8 + 12;
      c += `<g transform="translate(${(smx + offX).toFixed(1)},${(smy + offY).toFixed(1)}) rotate(${ang})">`;
      c += `<rect x="${(-lw/2).toFixed(1)}" y="-8.5" width="${lw.toFixed(1)}" height="17" rx="3.5" fill="white" stroke="${lineColor}" stroke-width="0.8"/>`;
      c += `<text x="0" y="4.5" font-size="9" font-weight="bold" fill="#92400e" text-anchor="middle" font-family="Arial,sans-serif">${lbl}</text>`;
      c += `</g>`;
    });

    // ── Chord labels on division lines ──
    divLines.forEach(v => {
      const chord = getChord(points, v, axis);
      if (!chord) return;
      const chordFt = (chord.end - chord.start) / px2ft;
      const lbl = `${chordFt.toFixed(1)} FT`;
      const lw  = lbl.length * 5.6 + 10;
      if (axis === "x") {
        c += `<g transform="translate(${sx(v)},${(chord.mid * sc + PAD).toFixed(1)}) rotate(-90)">`;
      } else {
        c += `<g transform="translate(${(chord.mid * sc + PAD).toFixed(1)},${(Number(sy(v)) - 14).toFixed(1)})">`;
      }
      c += `<rect x="${(-lw/2).toFixed(1)}" y="-8" width="${lw.toFixed(1)}" height="16" rx="3" fill="rgba(13,148,136,0.1)" stroke="#0d9488" stroke-width="0.7"/>`;
      c += `<text x="0" y="4" font-size="8.5" font-weight="bold" fill="#0d9488" text-anchor="middle" font-family="Arial,sans-serif">${lbl}</text>`;
      c += `</g>`;
    });

    // ── Strip sub-segment labels — also pushed outside ──
    stripSubEdges.forEach(({ a, b }) => {
      const pixLen = dist(a, b);
      if (pixLen < 8) return;
      const smx  = (a.x + b.x) / 2 * sc + PAD;
      const smy  = (a.y + b.y) / 2 * sc + PAD;
      const ang  = lineAngle(a, b);
      const rad  = Math.atan2(b.y - a.y, b.x - a.x);
      const nnx  = -Math.sin(rad), nny = Math.cos(rad);
      const dot  = (csx - smx) * nnx + (csy - smy) * nny;
      const sign = dot > 0 ? -1 : 1;
      const offX = sign * nnx * 18, offY = sign * nny * 18;
      const ftLen = pixLen / px2ft;
      const lbl   = `${ftLen.toFixed(1)} FT`;
      const lw    = lbl.length * 5.0 + 8;
      c += `<g transform="translate(${(smx + offX).toFixed(1)},${(smy + offY).toFixed(1)}) rotate(${ang})">`;
      c += `<rect x="${(-lw/2).toFixed(1)}" y="-6.5" width="${lw.toFixed(1)}" height="13" rx="2.5" fill="rgba(252,211,77,0.18)" stroke="#D97706" stroke-width="0.5"/>`;
      c += `<text x="0" y="3.5" font-size="7.5" font-weight="bold" fill="#92400e" text-anchor="middle" font-family="Arial,sans-serif">${lbl}</text>`;
      c += `</g>`;
    });
  }

  // Strip area labels
  strips.forEach(s => {
    if (s.polygon.length < 3) return;
    const cx = (s.centroid.x * sc + PAD).toFixed(1);
    const cy = s.centroid.y * sc + PAD;
    c += `<text x="${cx}" y="${(cy - 7).toFixed(1)}" font-size="9.5" font-weight="bold" fill="#1e3a5f" text-anchor="middle" font-family="Arial,sans-serif">${s.sqFt.toFixed(2)} ft²</text>`;
    c += `<text x="${cx}" y="${(cy + 8).toFixed(1)}" font-size="9" fill="#D97706" text-anchor="middle" font-family="Arial,sans-serif">${s.marlas.toFixed(4)} M</text>`;
  });

  // Corner dots
  points.forEach((p, i) => {
    c += `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="${i === 0 ? 5 : 3.5}" fill="${i === 0 ? lineColor : labelColor}" stroke="white" stroke-width="1.5"/>`;
  });

  c += `</svg>`;
  return c;
}

function buildPDFHtml(
  svgContent: string,
  strips: StripInfo[],
  totalSqFt: number,
  totalMarlas: number,
  scaleWidth: string,
  hasDivisions: boolean,
  splitDir: "length" | "breadth",
  orientation: "portrait" | "landscape"
): string {
  const date     = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const dirLabel = splitDir === "length" ? "Split by Length (vertical cuts)" : "Split by Breadth (horizontal cuts)";
  const dirIcon  = splitDir === "length" ? "|||" : "≡";
  const perSqFt  = hasDivisions && strips.length ? strips[0].sqFt : totalSqFt;
  const perM     = hasDivisions && strips.length ? strips[0].marlas : totalMarlas;
  const rows     = strips.map((s, i) =>
    `<tr><td>Part ${i + 1}</td><td>${s.sqFt.toFixed(4)}</td><td>${s.marlas.toFixed(4)}</td></tr>`
  ).join("");
  const orientLabel = orientation === "landscape" ? "Landscape" : "Portrait";

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  @page { size: A4 ${orientation}; margin: 14mm 18mm; }
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,Helvetica,sans-serif;background:#fff;color:#1a1a1a;font-size:13px}
  .page-wrap{width:100%;display:flex;flex-direction:column;align-items:center}
  .header-row{width:100%;display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid #D97706}
  .header-left h1{font-size:20px;color:#D97706;margin-bottom:2px}
  .header-left .sub{font-size:11px;color:#6b7280}
  .orient-badge{font-size:10px;font-weight:700;color:#92400E;background:#FEF3C7;border:1px solid #FDE68A;border-radius:12px;padding:3px 10px;white-space:nowrap;margin-top:4px}
  .meta{font-size:11.5px;color:#555;margin-bottom:14px;line-height:1.85;width:100%}
  .dir-chip{display:inline-block;background:#FEF3C7;color:#92400E;border:1px solid #FDE68A;border-radius:20px;padding:2px 10px;font-size:10px;font-weight:700;margin-left:4px}
  .eq-chip{display:inline-block;background:#dcfce7;color:#166534;border:1px solid #bbf7d0;border-radius:20px;padding:2px 10px;font-size:10px;font-weight:700;margin-left:4px}
  .plot-box{width:100%;display:flex;justify-content:center;align-items:center;border:1.5px solid #e5e7eb;border-radius:10px;padding:0;background:#f9fafb;margin-bottom:18px;overflow:hidden}
  .plot-box svg{display:block;max-width:100%;height:auto}
  .sec{font-size:13px;font-weight:bold;color:#374151;margin-bottom:7px;width:100%;padding-bottom:4px;border-bottom:1px solid #f3f4f6}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  thead th{background:#D97706;color:#fff;padding:8px 12px;text-align:center}
  tbody td{padding:7px 12px;text-align:center;border-bottom:1px solid #f3f4f6}
  tbody tr:nth-child(even) td{background:#fffbf0}
  tfoot td{background:#FEF3C7;font-weight:bold;padding:8px 12px;text-align:center;border-top:2px solid #D97706}
  .note{margin-top:10px;font-size:10.5px;color:#6b7280;font-style:italic}
  .footer{margin-top:20px;font-size:10.5px;color:#9ca3af;text-align:center;padding-top:10px;border-top:1px solid #f3f4f6;width:100%}
</style></head><body>
<div class="page-wrap">
  <div class="header-row">
    <div class="header-left">
      <h1>Land Plot Measurement Report</h1>
      <div class="sub">Generated: ${date} &nbsp;·&nbsp; 1 Marla = ${MARLA_SQ_FT} Sq Ft</div>
    </div>
    <div class="orient-badge">⬜ ${orientLabel}</div>
  </div>

  <p class="meta">
    Canvas width: <strong>${scaleWidth} ft</strong>
    ${hasDivisions
      ? `&nbsp;·&nbsp; Division: <span class="dir-chip">${dirIcon} ${dirLabel}</span>
         <span class="eq-chip">✓ Equal Area</span>`
      : ""}
  </p>

  <div class="plot-box">${svgContent}</div>

  ${hasDivisions
    ? `<p class="sec">Equal-Area Division Summary</p>
  <table>
    <thead><tr><th>Part #</th><th>Area (Sq Ft)</th><th>Marlas</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td>TOTAL</td><td>${totalSqFt.toFixed(4)}</td><td>${totalMarlas.toFixed(4)}</td></tr></tfoot>
  </table>
  <p class="note">Each part: ${perSqFt.toFixed(4)} Sq Ft = ${perM.toFixed(4)} Marlas (binary-search equal-area algorithm)</p>`
    : `<p class="sec">Total Area</p>
  <table>
    <thead><tr><th>Measurement</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>Area (Sq Ft)</td><td>${totalSqFt.toFixed(4)}</td></tr>
      <tr><td>Marlas</td><td>${totalMarlas.toFixed(4)}</td></tr>
    </tbody>
  </table>`}
  <div class="footer">Land Plot Measurer &nbsp;·&nbsp; Professional Land Measurement Tool</div>
</div>
</body></html>`;
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function PlotScreen() {
  const insets = useSafeAreaInsets();
  const { savePlot, plotToLoad, clearPlotToLoad } = usePlotStorage();

  const [points,    setPoints]    = useState<Point[]>([]);
  const [isClosed,  setIsClosed]  = useState(false);
  const [bgImage,   setBgImage]   = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 300, h: 300 });
  const [scaleWidth, setScaleWidth] = useState("");
  const [divisions,  setDivisions]  = useState("2");
  const [showDiv,    setShowDiv]    = useState(false);
  const [splitDir,   setSplitDir]   = useState<"length" | "breadth">("length");
  const [exporting,  setExporting]  = useState(false);

  // Save modal
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName,      setSaveName]      = useState("");
  const [saving,        setSaving]        = useState(false);

  // Manual override modal
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  const [overrideValue,     setOverrideValue]     = useState("");
  const pendingOverrideSeg  = useRef<LabeledSeg | null>(null);

  // Zoom state (scale + pan offset applied to SVG <G> transform)
  const [zoom, setZoom]  = useState({ scale: 1, tx: 0, ty: 0 });
  const zoomRef          = useRef({ scale: 1, tx: 0, ty: 0 });

  // Color customization
  const [lineColor,       setLineColor]       = useState("#F59E0B");
  const [labelColor,      setLabelColor]      = useState("#FCD34D");
  const [showColorModal,  setShowColorModal]  = useState(false);

  // Export options
  const [showExportModal,    setShowExportModal]    = useState(false);
  const [exportOrientation,  setExportOrientation]  = useState<"portrait" | "landscape">("portrait");

  // Smart Scan
  const [ocrLoading,    setOcrLoading]    = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const [scanSides, setScanSides] = useState<{ top: string; right: string; bottom: string; left: string }>({ top: "", right: "", bottom: "", left: "" });
  const [scanExtra, setScanExtra] = useState<number[]>([]);

  // Mutable refs for PanResponder closures
  const pointsRef        = useRef<Point[]>([]);
  const isClosedRef      = useRef(false);
  const canvasSizeRef    = useRef({ w: 300, h: 300 });
  const draggingIndex    = useRef(-1);
  const dragStartPoint   = useRef<Point>({ x: 0, y: 0 });
  const labeledSegsRef   = useRef<LabeledSeg[]>([]);
  const px2ftRef         = useRef<number | null>(null);
  const openOverrideRef  = useRef<((seg: LabeledSeg) => void)>(() => {});

  // Pinch tracking
  const isPinchingRef    = useRef(false);
  const pinchStartRef    = useRef({ dist: 0, scale: 1, tx: 0, ty: 0, cx: 0, cy: 0 });

  // ── Load saved plot ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!plotToLoad) return;
    const pts = plotToLoad.points as Point[];
    pointsRef.current   = pts;
    isClosedRef.current = true;
    setPoints([...pts]);
    setIsClosed(true);
    setScaleWidth(plotToLoad.scaleWidth);
    setDivisions(plotToLoad.divisions);
    setSplitDir(plotToLoad.splitDir);
    setShowDiv(false);
    clearPlotToLoad();
    if (Platform.OS !== "web")
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [plotToLoad, clearPlotToLoad]);

  // ── PanResponder ──────────────────────────────────────────────────────────
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  (evt) =>
        evt.nativeEvent.touches.length >= 2 || draggingIndex.current >= 0,

      onPanResponderGrant: (evt: GestureResponderEvent) => {
        const touches = evt.nativeEvent.touches;

        // ── 2-finger pinch/pan start ──────────────────────────────────────
        if (touches.length >= 2) {
          isPinchingRef.current = true;
          draggingIndex.current = -1;
          const dx = touches[1].locationX - touches[0].locationX;
          const dy = touches[1].locationY - touches[0].locationY;
          const d  = Math.sqrt(dx * dx + dy * dy);
          const { scale, tx, ty } = zoomRef.current;
          pinchStartRef.current = {
            dist:  d,
            scale,
            tx,
            ty,
            cx: (touches[0].locationX + touches[1].locationX) / 2,
            cy: (touches[0].locationY + touches[1].locationY) / 2,
          };
          return;
        }

        isPinchingRef.current = false;

        // ── Single-finger: inverse-transform to canvas logical coords ─────
        const { scale, tx, ty } = zoomRef.current;
        const x = (evt.nativeEvent.locationX - tx) / scale;
        const y = (evt.nativeEvent.locationY - ty) / scale;
        const pts    = pointsRef.current;
        const closed = isClosedRef.current;

        if (closed) {
          let minD = Infinity, closest = -1;
          pts.forEach((p, i) => {
            const d = dist({ x, y }, p);
            if (d < DRAG_THRESHOLD && d < minD) { minD = d; closest = i; }
          });
          if (closest >= 0) {
            draggingIndex.current  = closest;
            dragStartPoint.current = { ...pts[closest] };
            return;
          }
          const segs = labeledSegsRef.current;
          for (const seg of segs) {
            const mid = { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
            if (dist({ x, y }, mid) < LABEL_TAP_RADIUS) {
              openOverrideRef.current(seg);
              return;
            }
          }
          return;
        }

        if (pts.length >= 3 && dist({ x, y }, pts[0]) < CLOSE_THRESHOLD) {
          isClosedRef.current = true;
          setIsClosed(true);
          if (Platform.OS !== "web")
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          return;
        }

        let minD = Infinity, cnf = -1;
        for (let i = 1; i < pts.length; i++) {
          const d = dist({ x, y }, pts[i]);
          if (d < DRAG_THRESHOLD && d < minD) { minD = d; cnf = i; }
        }
        if (cnf >= 0) {
          draggingIndex.current  = cnf;
          dragStartPoint.current = { ...pts[cnf] };
          return;
        }

        const np = [...pts, { x, y }];
        pointsRef.current = np;
        setPoints(np);
        if (Platform.OS !== "web")
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      },

      onPanResponderMove: (evt: GestureResponderEvent, gs: PanResponderGestureState) => {
        const touches = evt.nativeEvent.touches;

        // ── Pinch: update scale toward pinch center ───────────────────────
        if (touches.length >= 2 || isPinchingRef.current) {
          if (touches.length < 2) return;
          const dx = touches[1].locationX - touches[0].locationX;
          const dy = touches[1].locationY - touches[0].locationY;
          const newDist   = Math.sqrt(dx * dx + dy * dy);
          const ps        = pinchStartRef.current;
          const newScale  = Math.max(0.5, Math.min(6, ps.scale * newDist / ps.dist));
          const scaleDelta = newScale / ps.scale;
          const newTx = ps.cx - scaleDelta * (ps.cx - ps.tx);
          const newTy = ps.cy - scaleDelta * (ps.cy - ps.ty);
          zoomRef.current = { scale: newScale, tx: newTx, ty: newTy };
          setZoom({ scale: newScale, tx: newTx, ty: newTy });
          return;
        }

        // ── Single-finger corner drag ─────────────────────────────────────
        const idx = draggingIndex.current;
        if (idx < 0) return;
        const { w, h } = canvasSizeRef.current;
        const { scale } = zoomRef.current;
        const sp = dragStartPoint.current;
        // gs.dx/dy are in screen pixels; divide by scale for logical pixels
        const nx = Math.max(0, Math.min(w, sp.x + gs.dx / scale));
        const ny = Math.max(0, Math.min(h, sp.y + gs.dy / scale));
        const np = [...pointsRef.current];
        np[idx] = { x: nx, y: ny };
        pointsRef.current = np;
        setPoints([...np]);
      },

      onPanResponderRelease:   () => { draggingIndex.current = -1; isPinchingRef.current = false; },
      onPanResponderTerminate: () => { draggingIndex.current = -1; isPinchingRef.current = false; },
    })
  ).current;

  // ── Actions ───────────────────────────────────────────────────────────────
  const handleUndo = () => {
    if (isClosed) {
      isClosedRef.current = false;
      setIsClosed(false);
      setShowDiv(false);
    } else {
      const np = pointsRef.current.slice(0, -1);
      pointsRef.current = np;
      setPoints(np);
    }
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const handleClear = () => {
    pointsRef.current   = [];
    isClosedRef.current = false;
    draggingIndex.current = -1;
    zoomRef.current = { scale: 1, tx: 0, ty: 0 };
    setZoom({ scale: 1, tx: 0, ty: 0 });
    setPoints([]);
    setIsClosed(false);
    setShowDiv(false);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const resetZoom = () => {
    zoomRef.current = { scale: 1, tx: 0, ty: 0 };
    setZoom({ scale: 1, tx: 0, ty: 0 });
  };

  const pickImage = async () => {
    if (Platform.OS !== "web") {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission needed", "Allow photo library access to upload a map image.");
        return;
      }
    }
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
    });
    if (r.canceled) return;

    const uri = r.assets[0].uri;
    setBgImage(uri);

    // ── Smart scan: detect measurements + assign to sides ──────────────────
    setOcrLoading(true);
    try {
      const blocks = await recognizeMeasurementsAdvanced(uri);
      if (blocks.length > 0) {
        const sides: ScannedSides = assignSides(blocks);
        setScanSides({
          top:    sides.top    != null ? String(sides.top)    : "",
          right:  sides.right  != null ? String(sides.right)  : "",
          bottom: sides.bottom != null ? String(sides.bottom) : "",
          left:   sides.left   != null ? String(sides.left)   : "",
        });
        setScanExtra(sides.extra);
        setShowScanModal(true);
      }
    } finally {
      setOcrLoading(false);
    }
  };

  // ── Auto-draw rectangle from 4 side measurements ───────────────────────
  const autoDrawFromScan = () => {
    const top    = parseFloat(scanSides.top)    || 0;
    const right  = parseFloat(scanSides.right)  || 0;
    const bottom = parseFloat(scanSides.bottom) || 0;
    const left   = parseFloat(scanSides.left)   || 0;

    const widthFt  = ((top  || bottom) ? (top  + bottom) / Math.max((top  > 0 ? 1 : 0) + (bottom > 0 ? 1 : 0), 1) : 0);
    const heightFt = ((left || right)  ? (left + right)  / Math.max((left > 0 ? 1 : 0) + (right  > 0 ? 1 : 0), 1) : 0);

    if (widthFt <= 0 || heightFt <= 0) {
      Alert.alert("Missing measurements", "Please enter at least the Top/Bottom and Left/Right values.");
      return;
    }

    const cw = canvasSizeRef.current.w || 300;
    const ch = canvasSizeRef.current.h || 400;
    const scaleX = (cw * 0.78) / widthFt;
    const scaleY = (ch * 0.78) / heightFt;
    const sc     = Math.min(scaleX, scaleY);

    const plotW = widthFt  * sc;
    const plotH = heightFt * sc;
    const x0    = (cw - plotW) / 2;
    const y0    = (ch - plotH) / 2;

    const newPts: Point[] = [
      { x: x0,          y: y0 },
      { x: x0 + plotW,  y: y0 },
      { x: x0 + plotW,  y: y0 + plotH },
      { x: x0,          y: y0 + plotH },
    ];

    pointsRef.current   = newPts;
    isClosedRef.current = true;
    setPoints([...newPts]);
    setIsClosed(true);
    setShowDiv(false);
    setScaleWidth((cw / sc).toFixed(3));
    setShowScanModal(false);
    zoomRef.current = { scale: 1, tx: 0, ty: 0 };
    setZoom({ scale: 1, tx: 0, ty: 0 });
    if (Platform.OS !== "web")
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const openSaveModal = () => {
    const n = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    setSaveName(`Plot – ${n}`);
    setShowSaveModal(true);
  };

  const handleSave = async () => {
    if (!isClosed || points.length < 3) return;
    setSaving(true);
    try {
      await savePlot({ name: saveName.trim() || "Untitled Plot", points, scaleWidth, divisions, splitDir, sqFt: sqFt ?? null, marlas: marlas ?? null });
      setShowSaveModal(false);
      if (Platform.OS !== "web")
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Saved!", `"${saveName.trim() || "Untitled Plot"}" stored in Saved Plots.`);
    } finally { setSaving(false); }
  };

  const handleOverrideApply = () => {
    const ft = parseFloat(overrideValue);
    if (isNaN(ft) || ft <= 0 || !pendingOverrideSeg.current || canvasSize.w <= 0) {
      setShowOverrideModal(false);
      return;
    }

    const seg  = pendingOverrideSeg.current;
    const cur  = px2ftRef.current;

    // ── Case 1: No scale set yet → use this measurement to establish the scale ──
    if (!cur) {
      const newPx2ft = seg.pixLen / ft;
      const newRealW = canvasSize.w / newPx2ft;
      setScaleWidth(newRealW.toFixed(3));
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setShowOverrideModal(false);
      return;
    }

    // ── Case 2: Scale already set → physically resize this segment only ─────────
    // Keep midpoint fixed; scale both endpoints along the segment direction.
    const { iA, iB } = seg;
    if (iA === undefined || iB === undefined) {
      // Division line or sub-edge: fall back to scale-change
      const newPx2ft = seg.pixLen / ft;
      const newRealW = canvasSize.w / newPx2ft;
      setScaleWidth(newRealW.toFixed(3));
      setShowOverrideModal(false);
      return;
    }

    const desiredPx = ft * cur;
    const { a, b } = seg;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const raw = dist(a, b);
    if (raw < 1) { setShowOverrideModal(false); return; }

    const ux = (b.x - a.x) / raw;
    const uy = (b.y - a.y) / raw;
    const half = desiredPx / 2;

    const newA: Point = { x: mx - ux * half, y: my - uy * half };
    const newB: Point = { x: mx + ux * half, y: my + uy * half };

    const updated = [...pointsRef.current];
    updated[iA] = newA;
    updated[iB] = newB;

    pointsRef.current = updated;
    setPoints(updated);
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setShowOverrideModal(false);
  };

  // ── Derived values ────────────────────────────────────────────────────────
  const pixelArea = isClosed && points.length >= 3 ? shoelaceArea(points) : 0;
  const realW     = parseFloat(scaleWidth);
  const px2ft     = canvasSize.w > 0 && realW > 0 ? canvasSize.w / realW : null;
  const sqFt      = px2ft ? pixelArea / (px2ft * px2ft) : null;
  const marlas    = sqFt  ? sqFt / MARLA_SQ_FT : null;

  const axis   : SplitAxis = splitDir === "length" ? "x" : "y";
  const numDiv  = Math.max(2, parseInt(divisions) || 2);

  // ── Equal-area division lines (binary search) ─────────────────────────────
  const divLines = useMemo(() => {
    if (!showDiv || !isClosed || numDiv < 2 || points.length < 3) return [];
    return findEqualAreaCuts(points, numDiv, axis);
  }, [showDiv, isClosed, numDiv, points, axis]);

  // ── Strip polygons ────────────────────────────────────────────────────────
  const strips = useMemo<StripInfo[]>(() => {
    if (!showDiv || !isClosed || numDiv < 2 || points.length < 3 || !px2ft || divLines.length === 0) return [];
    const coords = points.map(p => axis === "x" ? p.x : p.y);
    const minV   = Math.min(...coords);
    const maxV   = Math.max(...coords);
    const bounds = [minV, ...divLines, maxV];
    return Array.from({ length: numDiv }, (_, i) => {
      const poly = clipToBand(points, bounds[i], bounds[i + 1], axis);
      if (poly.length < 3) return { polygon: poly, sqFt: 0, marlas: 0, centroid: { x: 0, y: 0 } };
      const sf = shoelaceArea(poly) / (px2ft * px2ft);
      return { polygon: poly, sqFt: sf, marlas: sf / MARLA_SQ_FT, centroid: polygonCentroid(poly) };
    });
  }, [showDiv, isClosed, numDiv, points, axis, px2ft, divLines]);

  // ── Chord labels ──────────────────────────────────────────────────────────
  const chords = useMemo<(ChordInfo | null)[]>(() =>
    divLines.map(v => {
      if (!isClosed || points.length < 3 || !px2ft) return null;
      const c = getChord(points, v, axis);
      if (!c) return null;
      return { ...c, lengthFt: (c.end - c.start) / px2ft };
    }),
  [divLines, isClosed, points, axis, px2ft]);

  // ── Strip sub-segment edges (partial outer edges per strip) ────────────────
  const stripSubEdges = useMemo<Array<{ a: Point; b: Point }>>(() => {
    if (!showDiv || strips.length < 2) return [];
    const edges: Array<{ a: Point; b: Point }> = [];
    strips.forEach(strip => {
      const poly = strip.polygon;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if (dist(a, b) < 6) continue;
        if (isOnDivisionLine(a, b, divLines, axis)) continue;
        if (isFullOuterEdge(a, b, points)) continue;
        edges.push({ a, b });
      }
    });
    return edges;
  }, [showDiv, strips, divLines, axis, points]);

  // ── Collect labeled segments for override tap detection ───────────────────
  const allLabeledSegs = useMemo<LabeledSeg[]>(() => {
    if (!isClosed) return [];
    const segs: LabeledSeg[] = [];
    // Outer boundary — include point indices so override can physically resize them
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[(i + 1) % n];
      segs.push({ a, b, pixLen: dist(a, b), iA: i, iB: (i + 1) % n });
    }
    // Division line chords
    divLines.forEach((v, i) => {
      const chord = chords[i];
      if (!chord) return;
      const a: Point = axis === "x" ? { x: v, y: chord.start } : { x: chord.start, y: v };
      const b: Point = axis === "x" ? { x: v, y: chord.end }   : { x: chord.end,   y: v };
      segs.push({ a, b, pixLen: dist(a, b) });
    });
    // Strip sub-edges
    stripSubEdges.forEach(({ a, b }) => segs.push({ a, b, pixLen: dist(a, b) }));
    return segs;
  }, [isClosed, points, divLines, axis, chords, stripSubEdges]);

  // Keep refs in sync for PanResponder
  px2ftRef.current      = px2ft;
  labeledSegsRef.current = allLabeledSegs;
  openOverrideRef.current = (seg: LabeledSeg) => {
    pendingOverrideSeg.current = seg;
    const currentFt = px2ftRef.current ? (seg.pixLen / px2ftRef.current).toFixed(3) : "";
    setOverrideValue(currentFt);
    setShowOverrideModal(true);
  };

  // ── PDF export ────────────────────────────────────────────────────────────
  const handleExportPDF = async (orientation: "portrait" | "landscape") => {
    if (!isClosed || points.length < 3) { Alert.alert("No plot", "Draw and close a plot first."); return; }
    if (!sqFt) { Alert.alert("Scale required", "Enter the canvas width in feet before exporting."); return; }
    setShowExportModal(false);
    setExporting(true);
    try {
      const hasDivisions = showDiv && strips.length >= 2;
      const exportStrips = hasDivisions
        ? strips
        : [{ polygon: points, sqFt: sqFt!, marlas: marlas!, centroid: polygonCentroid(points) }];
      const svgContent = buildPDFSvg(points, divLines, axis, exportStrips, stripSubEdges, px2ft, canvasSize, orientation, lineColor, labelColor);
      const html       = buildPDFHtml(svgContent, exportStrips, sqFt!, marlas!, scaleWidth, hasDivisions, splitDir, orientation);
      const pageW      = orientation === "landscape" ? 842 : 595;
      const pageH      = orientation === "landscape" ? 595 : 842;
      const { uri }    = await Print.printToFileAsync({ html, base64: false, width: pageW, height: pageH });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: "Share Land Plot Report", UTI: "com.adobe.pdf" });
      } else {
        Alert.alert("PDF saved", uri);
      }
    } catch (err: unknown) {
      Alert.alert("Export failed", err instanceof Error ? err.message : String(err));
    } finally { setExporting(false); }
  };

  // ── Canvas geometry ───────────────────────────────────────────────────────
  const svgPts      = points.map(p => `${p.x},${p.y}`).join(" ");
  const canvasH     = canvasSize.h;
  const sides       = getSides(points, isClosed);
  const canvasHeight = Math.round(SCREEN_H * 0.68);
  const plotCentroid = isClosed && points.length >= 3 ? polygonCentroid(points) : { x: 0, y: 0 };
  const topPad      = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad   = Platform.OS === "web" ? 34 : insets.bottom;

  // Equal area per strip for display
  const equalSqFt   = sqFt && strips.length >= 2 ? sqFt / numDiv : null;
  const equalMarlas = equalSqFt ? equalSqFt / MARLA_SQ_FT : null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.root, { paddingTop: topPad }]}>
      <StatusBar barStyle="light-content" />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Land Plot Measurer</Text>
          <Text style={styles.headerSub}>1 Marla = {MARLA_SQ_FT} sq ft</Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.iconBtn} onPress={pickImage} disabled={ocrLoading}>
            {ocrLoading
              ? <ActivityIndicator size="small" color="#F59E0B" />
              : <Feather name="image" size={18} color="#F59E0B" />}
          </TouchableOpacity>
          <TouchableOpacity style={[styles.iconBtn, { borderColor: lineColor + "66" }]} onPress={() => setShowColorModal(true)}>
            <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: lineColor, borderWidth: 2, borderColor: "#0B1120" }} />
          </TouchableOpacity>
          {zoom.scale !== 1 && (
            <TouchableOpacity style={[styles.iconBtn, styles.iconBtnZoom]} onPress={resetZoom}>
              <Feather name="minimize-2" size={18} color="#22D3A3" />
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.iconBtn, isClosed && styles.iconBtnSave]} onPress={openSaveModal} disabled={!isClosed}>
            <Feather name="bookmark" size={18} color={isClosed ? "#22D3A3" : "#1E2D45"} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={handleUndo} disabled={points.length === 0}>
            <Feather name="corner-up-left" size={18} color={points.length === 0 ? "#1E2D45" : "#F59E0B"} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={handleClear} disabled={points.length === 0}>
            <Feather name="trash-2" size={18} color={points.length === 0 ? "#1E2D45" : "#EF4444"} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Canvas */}
      <View
        style={[styles.canvasWrapper, { height: canvasHeight }]}
        onLayout={e => {
          const { width, height } = e.nativeEvent.layout;
          const sz = { w: width, h: height };
          canvasSizeRef.current = sz;
          setCanvasSize(sz);
        }}
        {...panResponder.panHandlers}
      >
        <Svg width={canvasSize.w} height={canvasH} style={StyleSheet.absoluteFill}>
          {/* All SVG content wrapped in zoom transform */}
          <G transform={`translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`}>
          {bgImage && canvasSize.w > 0 && (
            <SvgImage href={bgImage} x={0} y={0} width={canvasSize.w} height={canvasH} preserveAspectRatio="xMidYMid meet" />
          )}

          {isClosed && points.length >= 3 && (
            <>
              <Defs>
                <ClipPath id="pc"><SvgPolygon points={svgPts} /></ClipPath>
              </Defs>
              <SvgPolygon points={svgPts} fill={lineColor + "22"} stroke={lineColor} strokeWidth={2} strokeLinejoin="round" />
              {divLines.map((v, i) => (
                <G key={i} clipPath="url(#pc)">
                  {axis === "x"
                    ? <Line x1={v} y1={0} x2={v} y2={canvasH} stroke="#22D3A3" strokeWidth={1.5} strokeDasharray="5,3" />
                    : <Line x1={0} y1={v} x2={canvasSize.w} y2={v} stroke="#22D3A3" strokeWidth={1.5} strokeDasharray="5,3" />
                  }
                </G>
              ))}
            </>
          )}

          {!isClosed && points.length >= 2 && (
            <Polyline points={svgPts} fill="none" stroke={lineColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          )}
          {!isClosed && points.length >= 3 && (
            <Line
              x1={points[points.length - 1].x} y1={points[points.length - 1].y}
              x2={points[0].x} y2={points[0].y}
              stroke={lineColor} strokeWidth={1} strokeDasharray="4,4" opacity={0.3}
            />
          )}

          {/* ── Outer boundary segment labels (always outside polygon) ── */}
          {sides.map(([a, b], i) => {
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            const pixLen   = dist(a, b);
            const hasScale = px2ft !== null;
            const label    = hasScale ? `${(pixLen / px2ft!).toFixed(1)} FT` : `${Math.round(pixLen)} px`;
            const ang      = lineAngle(a, b);
            const rad      = Math.atan2(b.y - a.y, b.x - a.x);
            // Perpendicular normal
            const nx = -Math.sin(rad), ny = Math.cos(rad);
            // Dot with vector from midpoint toward centroid — negative dot means centroid is in opposite direction
            const toCx = plotCentroid.x - mx, toCy = plotCentroid.y - my;
            const dot   = toCx * nx + toCy * ny;
            // Push label AWAY from centroid (outside the polygon)
            const sign  = dot > 0 ? -1 : 1;
            const OUTER_OFFSET = 20;
            const offX  = sign * nx * OUTER_OFFSET, offY = sign * ny * OUTER_OFFSET;
            const lw    = label.length * 6.2 + 12;
            return (
              <G key={`os-${i}`} transform={`translate(${mx + offX},${my + offY}) rotate(${ang})`}>
                <Rect x={-lw / 2} y={-8} width={lw} height={16} rx={4} fill="rgba(10,25,41,0.88)" stroke={lineColor + "55"} strokeWidth={0.8} />
                <SvgText x={0} y={4} fontSize={9.5} fontWeight="700" fill={hasScale ? labelColor : "#64748B"} textAnchor="middle">
                  {label}
                </SvgText>
              </G>
            );
          })}

          {/* ── Strip sub-segment labels (partial outer edges, always outside) ── */}
          {stripSubEdges.map(({ a, b }, i) => {
            if (!px2ft) return null;
            const pixLen = dist(a, b);
            if (pixLen < 6) return null;
            const mx  = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            const ang = lineAngle(a, b);
            const rad = Math.atan2(b.y - a.y, b.x - a.x);
            const nx   = -Math.sin(rad), ny = Math.cos(rad);
            const toCx = plotCentroid.x - mx, toCy = plotCentroid.y - my;
            const dot  = toCx * nx + toCy * ny;
            const sign = dot > 0 ? -1 : 1;
            const offX = sign * nx * 22, offY = sign * ny * 22;
            const label = `${(pixLen / px2ft).toFixed(1)} FT`;
            const lw    = label.length * 5.8 + 10;
            return (
              <G key={`sse-${i}`} transform={`translate(${mx + offX},${my + offY}) rotate(${ang})`}>
                <Rect x={-lw / 2} y={-7} width={lw} height={14} rx={3} fill="rgba(10,25,41,0.88)" stroke="#93C5FD44" strokeWidth={0.7} />
                <SvgText x={0} y={3.5} fontSize={8.5} fontWeight="700" fill="#93C5FD" textAnchor="middle">
                  {label}
                </SvgText>
              </G>
            );
          })}

          {/* ── Chord labels on division lines ── */}
          {chords.map((chord, i) => {
            if (!chord) return null;
            const v     = chord.fixedV;
            const label = `${chord.lengthFt.toFixed(1)} FT`;
            const lw    = label.length * 6 + 12;
            const transform = axis === "x"
              ? `translate(${v},${chord.mid}) rotate(-90)`
              : `translate(${chord.mid},${v - 14})`;
            return (
              <G key={`ch-${i}`} transform={transform}>
                <Rect x={-lw / 2} y={-8} width={lw} height={16} rx={4} fill="rgba(10,25,41,0.85)" />
                <SvgText x={0} y={4} fontSize={9} fontWeight="700" fill="#22D3A3" textAnchor="middle">
                  {label}
                </SvgText>
              </G>
            );
          })}

          {/* ── Total area label (no divisions) ── */}
          {isClosed && sqFt !== null && (!showDiv || strips.length < 2) && points.length >= 3 && (() => {
            const cx = plotCentroid.x, cy = plotCentroid.y;
            const sqFtStr  = sqFt.toLocaleString("en-US", { maximumFractionDigits: 2 });
            const marlasStr = marlas!.toFixed(4);
            const boxW = Math.max(sqFtStr.length, marlasStr.length + 2) * 7.4 + 24;
            return (
              <G key="total-area">
                {/* Background pill */}
                <Rect x={cx - boxW / 2} y={cy - 26} width={boxW} height={50}
                  rx={10} fill="rgba(10,25,41,0.78)" />
                <Rect x={cx - boxW / 2} y={cy - 26} width={boxW} height={50}
                  rx={10} fill="none" stroke={lineColor + "44"} strokeWidth={1} />
                {/* Sq Ft value */}
                <SvgText x={cx} y={cy - 6} fontSize={13} fontWeight="700"
                  fill="#F0F4FF" textAnchor="middle"
                  stroke="rgba(10,25,41,0.5)" strokeWidth={2} paintOrder="stroke">
                  {sqFtStr}
                </SvgText>
                {/* SQ FT unit */}
                <SvgText x={cx} y={cy + 7} fontSize={8} fontWeight="600"
                  fill="#64748B" textAnchor="middle">
                  SQ FT
                </SvgText>
                {/* Marlas value */}
                <SvgText x={cx} y={cy + 19} fontSize={11} fontWeight="700"
                  fill={labelColor} textAnchor="middle"
                  stroke="rgba(10,25,41,0.5)" strokeWidth={2} paintOrder="stroke">
                  {marlasStr} M
                </SvgText>
              </G>
            );
          })()}

          {/* ── Strip area labels ── */}
          {strips.map((s, i) => {
            if (s.polygon.length < 3) return null;
            const vs = axis === "x" ? s.polygon.map(p => p.x) : s.polygon.map(p => p.y);
            if (Math.max(...vs) - Math.min(...vs) < 40) return null;
            const exactFt = equalSqFt ?? s.sqFt;
            const exactM  = equalMarlas ?? s.marlas;
            return (
              <G key={`sl-${i}`}>
                <SvgText x={s.centroid.x} y={s.centroid.y - 8} fontSize={10} fontWeight="700"
                  fill="#F59E0B" textAnchor="middle"
                  stroke="rgba(10,25,41,0.7)" strokeWidth={3} paintOrder="stroke">
                  {`${exactFt.toFixed(2)} ft²`}
                </SvgText>
                <SvgText x={s.centroid.x} y={s.centroid.y + 7} fontSize={9} fontWeight="600"
                  fill="#FCD34D" textAnchor="middle"
                  stroke="rgba(10,25,41,0.7)" strokeWidth={3} paintOrder="stroke">
                  {`${exactM.toFixed(4)} M`}
                </SvgText>
              </G>
            );
          })}

          {/* ── Corner points ── */}
          {points.map((p, i) => (
            <React.Fragment key={i}>
              {i === 0 && !isClosed && points.length >= 3 && (
                <Circle cx={p.x} cy={p.y} r={CLOSE_THRESHOLD} fill="none"
                  stroke={lineColor} strokeWidth={0.8} strokeDasharray="3,3" opacity={0.35} />
              )}
              <Circle cx={p.x} cy={p.y} r={i === 0 ? 9 : 6} fill={lineColor + "22"} />
              <Circle cx={p.x} cy={p.y} r={i === 0 ? 8 : 5}
                fill={i === 0 ? lineColor : labelColor} stroke="#0B1120" strokeWidth={1.5} />
            </React.Fragment>
          ))}
          </G>{/* end zoom G */}
        </Svg>

        {/* Hint overlays */}
        {points.length === 0 && (
          <View style={styles.emptyState} pointerEvents="none">
            <Feather name="edit-2" size={36} color="#1E2D45" />
            <Text style={styles.emptyTitle}>Tap to place corners</Text>
            <Text style={styles.emptyHint}>Tap near ① to close · drag corners to reshape · tap any label to override</Text>
          </View>
        )}
        {points.length > 0 && !isClosed && (
          <View style={styles.badge} pointerEvents="none">
            <Text style={styles.badgeText}>
              {points.length} {points.length === 1 ? "point" : "points"}
              {points.length >= 3 ? " · tap ① to close" : ""}
            </Text>
          </View>
        )}
        {isClosed && (
          <View style={[styles.badge, styles.badgeClosed]} pointerEvents="none">
            <Text style={[styles.badgeText, { color: "#22D3A3" }]}>✓ Tap any label to override · drag corners to reshape</Text>
          </View>
        )}
      </View>

      {/* Bottom Panel */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.panelContainer}>
        <ScrollView
          style={styles.panel}
          contentContainerStyle={[styles.panelContent, { paddingBottom: bottomPad + 12 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Scale */}
          <View style={styles.row}>
            <Feather name="maximize-2" size={14} color="#64748B" style={{ marginRight: 8 }} />
            <Text style={styles.label}>Canvas width =</Text>
            <TextInput style={styles.input} value={scaleWidth} onChangeText={setScaleWidth}
              keyboardType="decimal-pad" placeholder="0" placeholderTextColor="#1E2D45"
              returnKeyType="done" />
            <Text style={styles.unit}>ft</Text>
          </View>

          {/* Area results */}
          {sqFt !== null ? (
            <View style={styles.resultsRow}>
              <View style={styles.resultCard}>
                <Text style={styles.resultValue}>{sqFt.toLocaleString("en-US", { maximumFractionDigits: 2 })}</Text>
                <Text style={styles.resultLabel}>SQ FT</Text>
              </View>
              <View style={styles.resultDivider} />
              <View style={styles.resultCard}>
                <Text style={[styles.resultValue, { color: "#F59E0B" }]}>{marlas!.toFixed(4)}</Text>
                <Text style={styles.resultLabel}>MARLAS</Text>
              </View>
            </View>
          ) : (
            <View style={styles.noResults}>
              <Text style={styles.noResultsText}>
                {!isClosed ? "Draw a plot and close it to measure area" : "Enter canvas width above to calculate area"}
              </Text>
            </View>
          )}

          {/* Divide row */}
          <View style={styles.row}>
            <Feather name="grid" size={14} color="#64748B" style={{ marginRight: 8 }} />
            <Text style={styles.label}>Divide into</Text>
            <TextInput style={[styles.input, { width: 52 }]} value={divisions} onChangeText={setDivisions}
              keyboardType="number-pad" placeholder="2" placeholderTextColor="#1E2D45" returnKeyType="done" />
            <Text style={styles.unit}>equal parts</Text>
            <TouchableOpacity
              style={[styles.applyBtn, !isClosed && styles.applyBtnDisabled]}
              onPress={() => {
                if (!isClosed) return;
                setShowDiv(v => !v);
                if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              }}
              disabled={!isClosed}
            >
              <Text style={[styles.applyText, !isClosed && { color: "#2D3F58" }]}>
                {showDiv ? "Hide" : "Apply"}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Split Direction Toggle */}
          <View style={styles.segContainer}>
            <Text style={styles.segLabel}>Split direction</Text>
            <View style={styles.segControl}>
              <TouchableOpacity
                style={[styles.segBtn, splitDir === "length" && styles.segBtnActive]}
                onPress={() => { setSplitDir("length"); if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                activeOpacity={0.75}
              >
                <View style={styles.iconCluster}>
                  {[0, 1, 2].map(k => <View key={k} style={[styles.vBar, splitDir === "length" && styles.vBarActive]} />)}
                </View>
                <Text style={[styles.segBtnText, splitDir === "length" && styles.segBtnTextActive]}>By Length</Text>
              </TouchableOpacity>
              <View style={styles.segSep} />
              <TouchableOpacity
                style={[styles.segBtn, splitDir === "breadth" && styles.segBtnActive]}
                onPress={() => { setSplitDir("breadth"); if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                activeOpacity={0.75}
              >
                <View style={[styles.iconCluster, { flexDirection: "column", gap: 3 }]}>
                  {[0, 1, 2].map(k => <View key={k} style={[styles.hBar, splitDir === "breadth" && styles.hBarActive]} />)}
                </View>
                <Text style={[styles.segBtnText, splitDir === "breadth" && styles.segBtnTextActive]}>By Breadth</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Equal area confirmation chip */}
          {showDiv && strips.length >= 2 && equalSqFt !== null && (
            <View style={styles.equalChip}>
              <Feather name="check-circle" size={13} color="#22c55e" />
              <Text style={styles.equalChipText}>
                Each part: {equalSqFt.toFixed(2)} Sq Ft = {equalMarlas!.toFixed(4)} Marlas
              </Text>
            </View>
          )}

          {/* Strip table */}
          {showDiv && strips.length >= 2 && (
            <View style={styles.stripTable}>
              <View style={styles.stripHeader}>
                <Text style={[styles.stripCell, styles.stripHead, { flex: 0.55 }]}>Part</Text>
                <Text style={[styles.stripCell, styles.stripHead]}>Sq Ft</Text>
                <Text style={[styles.stripCell, styles.stripHead]}>Marlas</Text>
              </View>
              {strips.map((s, i) => (
                <View key={i} style={[styles.stripRow, i % 2 === 1 && { backgroundColor: "rgba(255,255,255,0.03)" }]}>
                  <Text style={[styles.stripCell, { flex: 0.55, color: "#22D3A3", fontWeight: "700" }]}>{i + 1}</Text>
                  <Text style={styles.stripCell}>{equalSqFt ? equalSqFt.toFixed(4) : "—"}</Text>
                  <Text style={[styles.stripCell, { color: "#F59E0B" }]}>{equalMarlas ? equalMarlas.toFixed(4) : "—"}</Text>
                </View>
              ))}
              {sqFt && (
                <View style={styles.stripTotalRow}>
                  <Text style={[styles.stripCell, { flex: 0.55, color: "#F0F4FF", fontWeight: "700" }]}>Total</Text>
                  <Text style={[styles.stripCell, { fontWeight: "700", color: "#F0F4FF" }]}>{sqFt.toFixed(4)}</Text>
                  <Text style={[styles.stripCell, { fontWeight: "700", color: "#F59E0B" }]}>{marlas!.toFixed(4)}</Text>
                </View>
              )}
            </View>
          )}

          {showDiv && !sqFt && isClosed && numDiv >= 2 && (
            <View style={styles.divNote}>
              <Feather name="info" size={12} color="#64748B" />
              <Text style={styles.divNoteText}>Enter canvas width to see per-part area</Text>
            </View>
          )}

          {/* Override hint */}
          {isClosed && (
            <View style={styles.overrideHint}>
              <Feather name="edit-3" size={11} color="#475569" />
              <Text style={styles.overrideHintText}>Tap any measurement label on the canvas to manually override it</Text>
            </View>
          )}

          {/* Export PDF */}
          <TouchableOpacity
            style={[styles.exportBtn, (!isClosed || !sqFt || exporting) && styles.exportBtnDisabled]}
            onPress={() => {
              if (!isClosed || !sqFt || exporting) return;
              setShowExportModal(true);
            }}
            disabled={!isClosed || !sqFt || exporting}
          >
            {exporting
              ? <ActivityIndicator size="small" color="#0B1120" />
              : <Feather name="share-2" size={15} color={isClosed && sqFt ? "#0B1120" : "#2D3F58"} />
            }
            <Text style={[styles.exportBtnText, (!isClosed || !sqFt) && { color: "#2D3F58" }]}>
              {exporting ? "Generating PDF…" : "Export PDF Report"}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Export Options Modal ───────────────────────────────────────────── */}
      <Modal visible={showExportModal} transparent animationType="fade" onRequestClose={() => setShowExportModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Feather name="file-text" size={20} color="#F59E0B" />
              <Text style={styles.modalTitle}>Export PDF Report</Text>
            </View>
            <Text style={styles.modalSub}>Choose page orientation before exporting. The plot will be centered and scaled to fit the page.</Text>

            {/* Orientation toggle */}
            <Text style={styles.colorSectionLabel}>PAGE ORIENTATION</Text>
            <View style={styles.orientRow}>
              <TouchableOpacity
                style={[styles.orientBtn, exportOrientation === "portrait" && styles.orientBtnActive]}
                onPress={() => setExportOrientation("portrait")}
                activeOpacity={0.75}
              >
                <View style={styles.orientIcon}>
                  <View style={[styles.orientPage, { width: 28, height: 38 }, exportOrientation === "portrait" && { borderColor: "#F59E0B" }]} />
                </View>
                <Text style={[styles.orientLabel, exportOrientation === "portrait" && { color: "#F59E0B" }]}>Portrait</Text>
                <Text style={styles.orientSub}>A4 · 595 × 842 pt</Text>
                {exportOrientation === "portrait" && <Feather name="check-circle" size={14} color="#F59E0B" style={{ marginTop: 4 }} />}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.orientBtn, exportOrientation === "landscape" && styles.orientBtnActive]}
                onPress={() => setExportOrientation("landscape")}
                activeOpacity={0.75}
              >
                <View style={styles.orientIcon}>
                  <View style={[styles.orientPage, { width: 38, height: 28 }, exportOrientation === "landscape" && { borderColor: "#F59E0B" }]} />
                </View>
                <Text style={[styles.orientLabel, exportOrientation === "landscape" && { color: "#F59E0B" }]}>Landscape</Text>
                <Text style={styles.orientSub}>A4 · 842 × 595 pt</Text>
                {exportOrientation === "landscape" && <Feather name="check-circle" size={14} color="#F59E0B" style={{ marginTop: 4 }} />}
              </TouchableOpacity>
            </View>

            {/* Summary */}
            <View style={styles.exportSummaryBox}>
              <View style={styles.exportSummaryRow}>
                <Feather name="layers" size={12} color="#64748B" />
                <Text style={styles.exportSummaryText}>
                  Plot · {sqFt?.toLocaleString("en-US", { maximumFractionDigits: 2 }) ?? "—"} ft²  ·  {marlas?.toFixed(4) ?? "—"} Marlas
                </Text>
              </View>
              {showDiv && strips.length >= 2 && (
                <View style={styles.exportSummaryRow}>
                  <Feather name="grid" size={12} color="#22D3A3" />
                  <Text style={[styles.exportSummaryText, { color: "#22D3A3" }]}>
                    {strips.length} equal parts included
                  </Text>
                </View>
              )}
              <View style={styles.exportSummaryRow}>
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: lineColor }} />
                <Text style={styles.exportSummaryText}>Line color · Label color applied</Text>
              </View>
            </View>

            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setShowExportModal(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmAmber} onPress={() => handleExportPDF(exportOrientation)}>
                <Feather name="share-2" size={15} color="#0B1120" />
                <Text style={styles.modalConfirmText}>Export PDF</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Save Modal ─────────────────────────────────────────────────────── */}
      <Modal visible={showSaveModal} transparent animationType="fade" onRequestClose={() => setShowSaveModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Feather name="bookmark" size={20} color="#22D3A3" />
              <Text style={styles.modalTitle}>Save Plot</Text>
            </View>
            <Text style={styles.modalSub}>Give this plot a name. It will be stored locally on your device.</Text>
            <TextInput
              style={styles.modalInput}
              value={saveName}
              onChangeText={setSaveName}
              placeholder="Enter plot name…"
              placeholderTextColor="#475569"
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleSave}
            />
            {sqFt != null && (
              <View style={styles.modalStats}>
                <Text style={styles.modalStatText}>
                  <Text style={{ color: "#F0F4FF", fontWeight: "700" }}>{sqFt.toLocaleString("en-US", { maximumFractionDigits: 2 })} ft²</Text>
                  {"  ·  "}
                  <Text style={{ color: "#F59E0B", fontWeight: "700" }}>{marlas!.toFixed(4)} Marlas</Text>
                  {"  ·  "}
                  <Text style={{ color: splitDir === "length" ? "#FCD34D" : "#22D3A3" }}>
                    {splitDir === "length" ? "||| By Length" : "≡ By Breadth"}
                  </Text>
                </Text>
              </View>
            )}
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setShowSaveModal(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalConfirm, saving && { opacity: 0.6 }]} onPress={handleSave} disabled={saving}>
                {saving ? <ActivityIndicator size="small" color="#0B1120" /> : <Feather name="check" size={15} color="#0B1120" />}
                <Text style={styles.modalConfirmText}>{saving ? "Saving…" : "Save"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Smart Scan Review Modal ─────────────────────────────────────────── */}
      <Modal visible={showScanModal} transparent animationType="slide" onRequestClose={() => setShowScanModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { maxHeight: "92%" }]}>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Header */}
              <View style={styles.modalHeader}>
                <Feather name="camera" size={20} color="#22D3A3" />
                <Text style={styles.modalTitle}>Smart Scan Results</Text>
              </View>
              <Text style={styles.modalSub}>
                Measurements detected from your photo and assigned to plot sides. Edit any value before drawing.
              </Text>

              {/* ── Plot-shaped layout ── */}
              <View style={styles.scanLayout}>

                {/* TOP */}
                <View style={styles.scanTopRow}>
                  <View style={styles.scanSideBox}>
                    <Text style={styles.scanSideLabel}>▲ TOP</Text>
                    <View style={styles.scanInputRow}>
                      <TextInput
                        style={styles.scanInput}
                        value={scanSides.top}
                        onChangeText={v => setScanSides(s => ({ ...s, top: v }))}
                        keyboardType="decimal-pad"
                        placeholder="— FT"
                        placeholderTextColor="#2D3F58"
                        returnKeyType="done"
                      />
                      <Text style={styles.scanUnit}>FT</Text>
                    </View>
                  </View>
                </View>

                {/* LEFT + RIGHT */}
                <View style={styles.scanMidRow}>
                  <View style={[styles.scanSideBox, { flex: 1 }]}>
                    <Text style={styles.scanSideLabel}>◀ LEFT</Text>
                    <View style={styles.scanInputRow}>
                      <TextInput
                        style={styles.scanInput}
                        value={scanSides.left}
                        onChangeText={v => setScanSides(s => ({ ...s, left: v }))}
                        keyboardType="decimal-pad"
                        placeholder="— FT"
                        placeholderTextColor="#2D3F58"
                        returnKeyType="done"
                      />
                      <Text style={styles.scanUnit}>FT</Text>
                    </View>
                  </View>

                  {/* Centre plot illustration */}
                  <View style={styles.scanPlotIcon}>
                    <View style={[styles.scanPlotRect, { borderColor: lineColor }]}>
                      <Text style={[styles.scanPlotIconText, { color: lineColor }]}>Plot</Text>
                    </View>
                  </View>

                  <View style={[styles.scanSideBox, { flex: 1 }]}>
                    <Text style={[styles.scanSideLabel, { textAlign: "right" }]}>RIGHT ▶</Text>
                    <View style={styles.scanInputRow}>
                      <TextInput
                        style={styles.scanInput}
                        value={scanSides.right}
                        onChangeText={v => setScanSides(s => ({ ...s, right: v }))}
                        keyboardType="decimal-pad"
                        placeholder="— FT"
                        placeholderTextColor="#2D3F58"
                        returnKeyType="done"
                      />
                      <Text style={styles.scanUnit}>FT</Text>
                    </View>
                  </View>
                </View>

                {/* BOTTOM */}
                <View style={styles.scanTopRow}>
                  <View style={styles.scanSideBox}>
                    <Text style={styles.scanSideLabel}>▼ BOTTOM</Text>
                    <View style={styles.scanInputRow}>
                      <TextInput
                        style={styles.scanInput}
                        value={scanSides.bottom}
                        onChangeText={v => setScanSides(s => ({ ...s, bottom: v }))}
                        keyboardType="decimal-pad"
                        placeholder="— FT"
                        placeholderTextColor="#2D3F58"
                        returnKeyType="done"
                      />
                      <Text style={styles.scanUnit}>FT</Text>
                    </View>
                  </View>
                </View>
              </View>

              {/* Unassigned extras */}
              {scanExtra.length > 0 && (
                <View style={styles.scanExtraBox}>
                  <Feather name="alert-circle" size={13} color="#F59E0B" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.scanExtraTitle}>Unassigned measurements</Text>
                    <Text style={styles.scanExtraSub}>
                      Tap to fill an empty field: {scanExtra.map(v => `${v} FT`).join("  ·  ")}
                    </Text>
                    <View style={styles.scanExtraChips}>
                      {scanExtra.map((v, i) => (
                        <TouchableOpacity key={i} style={styles.scanExtraChip}
                          onPress={() => {
                            setScanSides(s => {
                              if (!s.top)    return { ...s, top:    String(v) };
                              if (!s.right)  return { ...s, right:  String(v) };
                              if (!s.bottom) return { ...s, bottom: String(v) };
                              if (!s.left)   return { ...s, left:   String(v) };
                              return s;
                            });
                          }}>
                          <Text style={styles.scanExtraChipText}>{v} FT  +</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                </View>
              )}

              {/* Info note */}
              <View style={styles.scanNote}>
                <Feather name="info" size={12} color="#475569" />
                <Text style={styles.scanNoteText}>
                  A rectangle will be drawn with proportions matching these measurements. You can reshape corners manually after.
                </Text>
              </View>

              {/* Buttons */}
              <View style={styles.modalBtns}>
                <TouchableOpacity style={styles.modalCancel} onPress={() => setShowScanModal(false)}>
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalConfirm} onPress={autoDrawFromScan}>
                  <Feather name="edit-2" size={15} color="#0B1120" />
                  <Text style={styles.modalConfirmText}>Draw &amp; Calculate</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── Color Picker Modal ─────────────────────────────────────────────── */}
      <Modal visible={showColorModal} transparent animationType="fade" onRequestClose={() => setShowColorModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: lineColor }} />
              <Text style={styles.modalTitle}>Customize Colors</Text>
            </View>

            <Text style={styles.colorSectionLabel}>BOUNDARY LINE COLOR</Text>
            <View style={styles.colorRow}>
              {["#F59E0B","#EF4444","#22D3A3","#3B82F6","#A855F7","#EC4899","#FFFFFF","#10B981"].map(c => (
                <TouchableOpacity key={c} onPress={() => setLineColor(c)}
                  style={[styles.colorChip, { backgroundColor: c }, lineColor === c && styles.colorChipActive]}>
                  {lineColor === c && <Feather name="check" size={12} color="#000" />}
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.colorSectionLabel, { marginTop: 6 }]}>LABEL TEXT COLOR</Text>
            <View style={styles.colorRow}>
              {["#FCD34D","#FFFFFF","#22D3A3","#93C5FD","#F87171","#86EFAC","#FCA5A5","#C4B5FD"].map(c => (
                <TouchableOpacity key={c} onPress={() => setLabelColor(c)}
                  style={[styles.colorChip, { backgroundColor: c }, labelColor === c && styles.colorChipActive]}>
                  {labelColor === c && <Feather name="check" size={12} color="#000" />}
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.colorPreviewRow}>
              <View style={[styles.colorPreviewLine, { backgroundColor: lineColor }]} />
              <Text style={[styles.colorPreviewLabel, { color: labelColor }]}>208.1 FT</Text>
              <View style={[styles.colorPreviewLine, { backgroundColor: lineColor }]} />
            </View>

            <TouchableOpacity style={styles.modalConfirm} onPress={() => setShowColorModal(false)}>
              <Feather name="check" size={15} color="#0B1120" />
              <Text style={styles.modalConfirmText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Manual Override Modal ──────────────────────────────────────────── */}
      <Modal visible={showOverrideModal} transparent animationType="fade" onRequestClose={() => setShowOverrideModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Feather name="edit-3" size={20} color="#F59E0B" />
              <Text style={styles.modalTitle}>Override Measurement</Text>
            </View>
            <Text style={styles.modalSub}>
              {px2ft
                ? "Enter the correct length. Only this side will be resized — all other sides stay exactly as they are."
                : "Enter the real-world length of this side. This sets the scale for the whole plot."}
            </Text>
            {pendingOverrideSeg.current && px2ft && (
              <View style={styles.modalStats}>
                <Text style={styles.modalStatText}>
                  <Text style={{ color: "#64748B" }}>Current: </Text>
                  <Text style={{ color: "#F0F4FF", fontWeight: "700" }}>
                    {(pendingOverrideSeg.current.pixLen / px2ft).toFixed(3)} FT
                  </Text>
                  {"  ·  Pixel length: "}
                  <Text style={{ color: "#64748B" }}>{Math.round(pendingOverrideSeg.current.pixLen)} px</Text>
                </Text>
              </View>
            )}
            <View style={styles.overrideInputRow}>
              <TextInput
                style={[styles.modalInput, { flex: 1 }]}
                value={overrideValue}
                onChangeText={setOverrideValue}
                keyboardType="decimal-pad"
                placeholder="e.g. 82.5"
                placeholderTextColor="#475569"
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleOverrideApply}
              />
              <Text style={styles.overrideUnit}>FT</Text>
            </View>
            <Text style={styles.overrideNote}>
              {px2ft
                ? "Tip: set the canvas width first, then tap each side label to correct it independently."
                : "Tip: enter any side you know, then the scale is set for all sides."}
            </Text>
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setShowOverrideModal(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmAmber} onPress={handleOverrideApply}>
                <Feather name="check" size={15} color="#0B1120" />
                <Text style={styles.modalConfirmText}>Apply</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root:         { flex: 1, backgroundColor: "#0B1120" },
  header:       { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 10, paddingTop: 6 },
  headerTitle:  { fontSize: 18, fontWeight: "700", color: "#F0F4FF", letterSpacing: 0.2 },
  headerSub:    { fontSize: 11, color: "#64748B", marginTop: 1 },
  headerActions:{ flexDirection: "row", gap: 5 },
  iconBtn:      { width: 36, height: 36, borderRadius: 10, backgroundColor: "#151F32", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#1E2D45" },
  iconBtnSave:  { borderColor: "rgba(34,211,163,0.35)", backgroundColor: "rgba(34,211,163,0.08)" },
  iconBtnZoom:  { borderColor: "rgba(34,211,163,0.5)", backgroundColor: "rgba(34,211,163,0.12)" },

  canvasWrapper:{ marginHorizontal: 12, marginBottom: 6, borderRadius: 14, overflow: "hidden", backgroundColor: "#0A1929", borderWidth: 1, borderColor: "#1E2D45" },
  emptyState:   { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 32 },
  emptyTitle:   { fontSize: 16, fontWeight: "600", color: "#1E2D45" },
  emptyHint:    { fontSize: 11, color: "#162035", textAlign: "center" },
  badge:        { position: "absolute", top: 10, right: 10, backgroundColor: "rgba(245,158,11,0.12)", borderWidth: 1, borderColor: "rgba(245,158,11,0.25)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  badgeClosed:  { backgroundColor: "rgba(34,211,163,0.12)", borderColor: "rgba(34,211,163,0.3)" },
  badgeText:    { fontSize: 10, color: "#F59E0B", fontWeight: "600" },

  panelContainer:{ flex: 1, backgroundColor: "#0F1829", borderTopWidth: 1, borderTopColor: "#1E2D45" },
  panel:         { flex: 1 },
  panelContent:  { paddingHorizontal: 16, paddingTop: 12, gap: 9 },

  row:   { flexDirection: "row", alignItems: "center" },
  label: { flex: 1, fontSize: 13, color: "#90A4AE" },
  input: { width: 70, height: 36, borderRadius: 8, backgroundColor: "#151F32", borderWidth: 1, borderColor: "#1E2D45", color: "#F0F4FF", textAlign: "center", fontSize: 15, fontWeight: "600", paddingHorizontal: 6 },
  unit:  { fontSize: 12, color: "#64748B", marginLeft: 6 },

  resultsRow:   { flexDirection: "row", backgroundColor: "#151F32", borderRadius: 12, borderWidth: 1, borderColor: "#1E2D45", overflow: "hidden" },
  resultCard:   { flex: 1, alignItems: "center", paddingVertical: 10 },
  resultValue:  { fontSize: 22, fontWeight: "700", color: "#F0F4FF", letterSpacing: -0.5 },
  resultLabel:  { fontSize: 10, color: "#64748B", marginTop: 2, letterSpacing: 0.8 },
  resultDivider:{ width: 1, backgroundColor: "#1E2D45", marginVertical: 10 },
  noResults:    { paddingVertical: 4, alignItems: "center" },
  noResultsText:{ fontSize: 12, color: "#2D3F58", fontStyle: "italic", textAlign: "center" },

  applyBtn:        { marginLeft: 10, backgroundColor: "#F59E0B", paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8 },
  applyBtnDisabled:{ backgroundColor: "#151F32", borderWidth: 1, borderColor: "#1E2D45" },
  applyText:       { fontSize: 13, fontWeight: "700", color: "#0B1120" },

  segContainer: { gap: 5 },
  segLabel:     { fontSize: 11, color: "#64748B", letterSpacing: 0.4, textTransform: "uppercase" },
  segControl:   { flexDirection: "row", backgroundColor: "#151F32", borderRadius: 10, borderWidth: 1, borderColor: "#1E2D45", overflow: "hidden" },
  segBtn:       { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", paddingVertical: 10, gap: 8 },
  segBtnActive: { backgroundColor: "rgba(245,158,11,0.15)" },
  segBtnText:   { fontSize: 13, color: "#64748B", fontWeight: "600" },
  segBtnTextActive: { color: "#F59E0B" },
  segSep:       { width: 1, backgroundColor: "#1E2D45" },
  iconCluster:  { flexDirection: "row", alignItems: "center", gap: 2 },
  vBar:         { width: 2, height: 13, backgroundColor: "#2D3F58", borderRadius: 1 },
  vBarActive:   { backgroundColor: "#F59E0B" },
  hBar:         { width: 13, height: 2, backgroundColor: "#2D3F58", borderRadius: 1 },
  hBarActive:   { backgroundColor: "#F59E0B" },

  equalChip:    { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "rgba(34,197,94,0.08)", borderWidth: 1, borderColor: "rgba(34,197,94,0.2)", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  equalChipText:{ fontSize: 12, color: "#4ade80", fontWeight: "600", flex: 1 },

  stripTable:   { backgroundColor: "#151F32", borderRadius: 10, borderWidth: 1, borderColor: "#1E2D45", overflow: "hidden" },
  stripHeader:  { flexDirection: "row", backgroundColor: "#1E2D45", paddingVertical: 7, paddingHorizontal: 12 },
  stripRow:     { flexDirection: "row", paddingVertical: 7, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: "#1a2842" },
  stripTotalRow:{ flexDirection: "row", paddingVertical: 8, paddingHorizontal: 12, backgroundColor: "rgba(245,158,11,0.08)", borderTopWidth: 1, borderTopColor: "#F59E0B" },
  stripCell:    { flex: 1, fontSize: 11.5, color: "#CBD5E1", textAlign: "center" },
  stripHead:    { fontSize: 10, color: "#64748B", fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },

  divNote:       { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, justifyContent: "center" },
  divNoteText:   { fontSize: 12, color: "#64748B", fontStyle: "italic" },

  overrideHint:  { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 5, justifyContent: "center" },
  overrideHintText: { fontSize: 11, color: "#475569", fontStyle: "italic", textAlign: "center", flex: 1 },

  exportBtn:        { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#F59E0B", paddingVertical: 13, borderRadius: 12, marginTop: 2 },
  exportBtnDisabled:{ backgroundColor: "#151F32", borderWidth: 1, borderColor: "#1E2D45" },
  exportBtnText:    { fontSize: 14, fontWeight: "700", color: "#0B1120" },

  modalOverlay:  { flex: 1, backgroundColor: "rgba(0,0,0,0.65)", alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  modalBox:      { width: "100%", backgroundColor: "#151F32", borderRadius: 16, borderWidth: 1, borderColor: "#1E2D45", padding: 22, gap: 13 },
  modalHeader:   { flexDirection: "row", alignItems: "center", gap: 10 },
  modalTitle:    { fontSize: 17, fontWeight: "700", color: "#F0F4FF" },
  modalSub:      { fontSize: 13, color: "#64748B", lineHeight: 19 },
  modalInput:    { backgroundColor: "#0B1120", borderWidth: 1, borderColor: "#1E2D45", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: "#F0F4FF", fontWeight: "500" },
  modalStats:    { backgroundColor: "rgba(245,158,11,0.06)", borderWidth: 1, borderColor: "rgba(245,158,11,0.15)", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  modalStatText: { fontSize: 12, color: "#64748B", lineHeight: 18 },
  modalBtns:     { flexDirection: "row", gap: 10, marginTop: 2 },
  modalCancel:   { flex: 1, paddingVertical: 11, borderRadius: 10, backgroundColor: "#1E2D45", alignItems: "center" },
  modalCancelText:  { fontSize: 14, fontWeight: "600", color: "#90A4AE" },
  modalConfirm:     { flex: 2, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingVertical: 11, borderRadius: 10, backgroundColor: "#22D3A3" },
  modalConfirmAmber:{ flex: 2, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingVertical: 11, borderRadius: 10, backgroundColor: "#F59E0B" },
  modalConfirmText: { fontSize: 14, fontWeight: "700", color: "#0B1120" },

  overrideInputRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  overrideUnit:     { fontSize: 16, fontWeight: "700", color: "#F59E0B" },
  overrideNote:     { fontSize: 11, color: "#475569", fontStyle: "italic" },

  ocrList:     { gap: 8 },
  ocrItem:     { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(245,158,11,0.07)", borderWidth: 1, borderColor: "rgba(245,158,11,0.2)", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11 },
  ocrItemText: { flex: 1, fontSize: 15, fontWeight: "700", color: "#FCD34D" },

  // ── Smart Scan Modal
  scanLayout:     { gap: 4, marginVertical: 10 },
  scanTopRow:     { alignItems: "center" },
  scanMidRow:     { flexDirection: "row", alignItems: "center", gap: 6 },
  scanSideBox:    { backgroundColor: "rgba(34,211,163,0.06)", borderWidth: 1, borderColor: "rgba(34,211,163,0.18)", borderRadius: 10, padding: 10, gap: 4 },
  scanSideLabel:  { fontSize: 10, fontWeight: "800", color: "#22D3A3", letterSpacing: 0.7, textTransform: "uppercase" },
  scanInputRow:   { flexDirection: "row", alignItems: "center", gap: 4 },
  scanInput:      { flex: 1, fontSize: 17, fontWeight: "700", color: "#E2F0FF", backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: "rgba(34,211,163,0.25)", minWidth: 70 },
  scanUnit:       { fontSize: 12, fontWeight: "700", color: "#475569" },
  scanPlotIcon:   { width: 74, height: 64, alignItems: "center", justifyContent: "center" },
  scanPlotRect:   { width: 60, height: 50, borderWidth: 2, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  scanPlotIconText: { fontSize: 10, fontWeight: "700", opacity: 0.7 },
  scanExtraBox:   { flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: "rgba(245,158,11,0.06)", borderWidth: 1, borderColor: "rgba(245,158,11,0.2)", borderRadius: 10, padding: 10, marginTop: 6 },
  scanExtraTitle: { fontSize: 11, fontWeight: "700", color: "#F59E0B", marginBottom: 2 },
  scanExtraSub:   { fontSize: 11, color: "#94A3B8" },
  scanExtraChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  scanExtraChip:  { backgroundColor: "rgba(245,158,11,0.14)", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: "rgba(245,158,11,0.3)" },
  scanExtraChipText: { fontSize: 12, fontWeight: "700", color: "#FCD34D" },
  scanNote:       { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 8, marginBottom: 2 },
  scanNoteText:   { flex: 1, fontSize: 11, color: "#475569", lineHeight: 16 },

  colorSectionLabel: { fontSize: 10, fontWeight: "700", color: "#475569", letterSpacing: 0.8, textTransform: "uppercase" },
  colorRow:          { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  colorChip:         { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "transparent" },
  colorChipActive:   { borderColor: "#F0F4FF", transform: [{ scale: 1.15 }] },
  colorPreviewRow:   { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#0A1929", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12 },
  colorPreviewLine:  { flex: 1, height: 2, borderRadius: 1 },
  colorPreviewLabel: { fontSize: 13, fontWeight: "700" },

  // Export orientation modal
  orientRow:       { flexDirection: "row", gap: 12 },
  orientBtn:       { flex: 1, alignItems: "center", gap: 6, backgroundColor: "#0B1120", borderWidth: 1.5, borderColor: "#1E2D45", borderRadius: 12, paddingVertical: 14, paddingHorizontal: 10 },
  orientBtnActive: { borderColor: "#F59E0B", backgroundColor: "rgba(245,158,11,0.07)" },
  orientIcon:      { alignItems: "center", justifyContent: "center", height: 46 },
  orientPage:      { borderWidth: 2, borderColor: "#2D3F58", borderRadius: 3, backgroundColor: "#151F32" },
  orientLabel:     { fontSize: 14, fontWeight: "700", color: "#90A4AE" },
  orientSub:       { fontSize: 10, color: "#475569" },
  exportSummaryBox:  { backgroundColor: "#0B1120", borderRadius: 10, borderWidth: 1, borderColor: "#1E2D45", paddingHorizontal: 14, paddingVertical: 10, gap: 7 },
  exportSummaryRow:  { flexDirection: "row", alignItems: "center", gap: 8 },
  exportSummaryText: { fontSize: 12, color: "#64748B", flex: 1 },
});
