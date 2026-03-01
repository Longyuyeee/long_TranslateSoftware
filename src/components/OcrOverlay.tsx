import { useState, useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";

export default function OcrOverlay() {
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [rect, setRect] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 无论是否正在处理，ESC 必须能关闭窗口
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const close = async () => {
    setIsProcessing(false);
    setIsDrawing(false);
    setRect({ x: 0, y: 0, w: 0, h: 0 });
    try {
        await getCurrentWebviewWindow().hide();
    } catch (e) {
        console.error("Failed to hide window", e);
    }
  };

  const onMouseDown = (e: React.MouseEvent) => {
    // 如果正在处理上一次的 OCR，禁止再次划框
    if (isProcessing) return;
    setIsDrawing(true);
    setStartPos({ x: e.clientX, y: e.clientY });
    setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing || isProcessing) return;
    const currentX = e.clientX;
    const currentY = e.clientY;
    
    setRect({
      x: Math.min(startPos.x, currentX),
      y: Math.min(startPos.y, currentY),
      w: Math.abs(currentX - startPos.x),
      h: Math.abs(currentY - startPos.y),
    });
  };

  const onMouseUp = async () => {
    if (!isDrawing || isProcessing) return;
    setIsDrawing(false);
    
    // 过滤太小的矩形
    if (rect.w < 5 || rect.h < 5) {
        setRect({ x: 0, y: 0, w: 0, h: 0 });
        return;
    }

    setIsProcessing(true);
    try {
      const win = getCurrentWebviewWindow();
      const factor = await win.scaleFactor();
      const outerPos = await win.outerPosition();
      
      const physicalX = Math.round((outerPos.x + rect.x) * factor);
      const physicalY = Math.round((outerPos.y + rect.y) * factor);
      const physicalW = Math.round(rect.w * factor);
      const physicalH = Math.round(rect.h * factor);

      // 调用后端进行截图和 OCR
      // 这里增加一个超时保护，如果后端 15 秒没反应，自动解锁前端
      const ocrPromise = invoke("capture_and_ocr", {
        x: physicalX,
        y: physicalY,
        w: physicalW,
        h: physicalH
      });

      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("OCR Timeout")), 15000)
      );

      await Promise.race([ocrPromise, timeoutPromise]);
      
      // 成功后重置，窗口由后端负责 hide
      setRect({ x: 0, y: 0, w: 0, h: 0 });
    } catch (err) {
      console.error("OCR operation failed or timed out:", err);
      // 发生错误时手动关闭
      await close();
    } finally {
        setIsProcessing(false);
    }
  };

  return (
    <div 
      className="h-screen w-screen bg-black/10 cursor-crosshair overflow-hidden relative select-none"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {/* 只有在有宽度且未在处理时显示选框，或者在处理时显示固定的选框 */}
      {(rect.w > 0 || isProcessing) && (
        <div 
            className="absolute border-2 border-blue-500 bg-blue-500/10 pointer-events-none ring-1 ring-white/20"
            style={{
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h
            }}
        >
            {isProcessing && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-[10px] font-black tracking-widest animate-pulse">
                    SYNCING...
                </div>
            )}
        </div>
      )}

      <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-white/10 dark:bg-black/40 backdrop-blur-2xl text-white px-8 py-3 rounded-2xl text-[11px] font-black tracking-[0.2em] border border-white/20 shadow-2xl pointer-events-none flex items-center gap-3">
        <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
        DRAG TO SELECT · ESC TO CANCEL
      </div>
    </div>
  );
}
