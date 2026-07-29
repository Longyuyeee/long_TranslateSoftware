import { lazy, Suspense, useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ErrorBoundary } from "./components/ErrorBoundary";

const Dashboard = lazy(() => import("./components/Dashboard"));
const FloatingWindow = lazy(() => import("./components/FloatingWindow"));
const OcrOverlay = lazy(() => import("./components/OcrOverlay"));

function WindowLoadingFallback() {
  return (
    <div
      className="flex h-screen items-center justify-center bg-white dark:bg-[#1c1c1e]"
      role="status"
      aria-live="polite"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-accent" />
    </div>
  );
}

function App() {
  const [windowLabel, setWindowLabel] = useState<string>("");

  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) {
      setWindowLabel(getCurrentWebviewWindow().label);
    } else {
      // Browser preview fallback for UI, theme and localization reviews.
      setWindowLabel("main");
    }
  }, []);

  const content = (() => {
    if (windowLabel === "floating") return <FloatingWindow />;
    if (windowLabel === "main") return <Dashboard />;
    if (windowLabel === "ocr-overlay") return <OcrOverlay />;
    return <WindowLoadingFallback />;
  })();

  return (
    <ErrorBoundary>
      <Suspense fallback={<WindowLoadingFallback />}>{content}</Suspense>
    </ErrorBoundary>
  );
}

export default App;
