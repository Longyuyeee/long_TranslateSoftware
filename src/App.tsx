import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import FloatingWindow from "./components/FloatingWindow";
import Dashboard from "./components/Dashboard";
import OcrOverlay from "./components/OcrOverlay";

function App() {
  const [windowLabel, setWindowLabel] = useState<string>("");

  useEffect(() => {
    setWindowLabel(getCurrentWebviewWindow().label);
  }, []);

  if (windowLabel === "floating") {
    return <FloatingWindow />;
  }

  if (windowLabel === "main") {
    return <Dashboard />;
  }

  if (windowLabel === "ocr-overlay") {
    return <OcrOverlay />;
  }

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
    </div>
  );
}

export default App;
