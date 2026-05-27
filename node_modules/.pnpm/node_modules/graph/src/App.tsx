import { useEffect } from "react";
import { GraphView } from "./pages/GraphView";
import { useThemeStore } from "@g3t/react/theme";

export default function App() {
  const { setTheme } = useThemeStore();

  // Sync g3-toolkit theme with Who2Root4 theme stored in localStorage
  useEffect(() => {
    const stored = (() => {
      try {
        const prefs = JSON.parse(
          localStorage.getItem("w2r4_tweaks") ||
            localStorage.getItem("w2r4_team_prefs_v1") ||
            "{}",
        );
        return prefs.theme ?? "light";
      } catch {
        return "light";
      }
    })();
    const isDark = stored === "dark";
    document.documentElement.setAttribute(
      "data-theme",
      isDark ? "dark" : "light",
    );
    setTheme(isDark ? "dark" : "light");
  }, [setTheme]);

  return <GraphView />;
}
