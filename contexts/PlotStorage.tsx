import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

const STORAGE_KEY = "land_plots_v1";

export interface SavedPlot {
  id: string;
  name: string;
  points: { x: number; y: number }[];
  scaleWidth: string;
  divisions: string;
  splitDir: "length" | "breadth";
  sqFt: number | null;
  marlas: number | null;
  createdAt: number;
}

interface PlotStorageCtx {
  savedPlots: SavedPlot[];
  savePlot: (plot: Omit<SavedPlot, "id" | "createdAt">) => Promise<void>;
  deletePlot: (id: string) => Promise<void>;
  plotToLoad: SavedPlot | null;
  loadPlot: (plot: SavedPlot) => void;
  clearPlotToLoad: () => void;
}

const Ctx = createContext<PlotStorageCtx | null>(null);

export function PlotStorageProvider({ children }: { children: React.ReactNode }) {
  const [savedPlots, setSavedPlots] = useState<SavedPlot[]>([]);
  const [plotToLoad, setPlotToLoad] = useState<SavedPlot | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((json) => {
      if (json) {
        try { setSavedPlots(JSON.parse(json)); } catch {}
      }
    });
  }, []);

  const persist = useCallback(async (plots: SavedPlot[]) => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(plots));
    setSavedPlots(plots);
  }, []);

  const savePlot = useCallback(
    async (plot: Omit<SavedPlot, "id" | "createdAt">) => {
      const newPlot: SavedPlot = {
        ...plot,
        id: Date.now().toString(),
        createdAt: Date.now(),
      };
      await persist([newPlot, ...savedPlots]);
    },
    [savedPlots, persist]
  );

  const deletePlot = useCallback(
    async (id: string) => {
      await persist(savedPlots.filter((p) => p.id !== id));
    },
    [savedPlots, persist]
  );

  const loadPlot = useCallback((plot: SavedPlot) => {
    setPlotToLoad(plot);
  }, []);

  const clearPlotToLoad = useCallback(() => setPlotToLoad(null), []);

  return (
    <Ctx.Provider value={{ savedPlots, savePlot, deletePlot, plotToLoad, loadPlot, clearPlotToLoad }}>
      {children}
    </Ctx.Provider>
  );
}

export function usePlotStorage(): PlotStorageCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePlotStorage must be used within PlotStorageProvider");
  return ctx;
}
