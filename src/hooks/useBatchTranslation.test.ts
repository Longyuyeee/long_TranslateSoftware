// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TranslationTaskCallbacks,
  TranslationTaskCompletion,
} from "../services/api";
import {
  combineComparisonResults,
  useBatchTranslation,
} from "./useBatchTranslation";

const invokeMock = vi.fn();
let taskCallbacks: TranslationTaskCallbacks = {};
let resolveTask: (completion: TranslationTaskCompletion) => void = () => {};
const cancelTask = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("../services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/api")>();
  return {
    ...actual,
    startTranslationTask: vi.fn(
      (_text: string, callbacks: TranslationTaskCallbacks) => {
        taskCallbacks = callbacks;
        return {
          id: "task-1",
          cancel: cancelTask,
          done: new Promise<TranslationTaskCompletion>((resolve) => {
            resolveTask = resolve;
          }),
        };
      },
    ),
  };
});

describe("useBatchTranslation", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    cancelTask.mockReset();
    taskCallbacks = {};
  });

  it("streams only the active task and saves successful history", async () => {
    const onCompleted = vi.fn();
    const { result } = renderHook(() =>
      useBatchTranslation({
        sourceLang: "English",
        targetLang: "Chinese",
        onCompleted,
      }),
    );

    act(() => result.current.setBatchInput("hello"));
    act(() => result.current.startBatchTranslation());
    expect(result.current.batchTaskState.phase).toBe("loading-config");

    act(() => {
      taskCallbacks.onText?.("你好", "stale-task");
      taskCallbacks.onText?.("您好", "task-1");
    });
    expect(result.current.batchOutput).toBe("您好");

    await act(async () => {
      resolveTask({
        status: "success",
        result: {
          text: "您好",
          model: "primary-model",
          cached: false,
          usedBackup: false,
        },
      });
      await Promise.resolve();
    });

    expect(result.current.isTranslating).toBe(false);
    expect(onCompleted).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("save_translation", {
      sourceText: "hello",
      translatedText: "您好",
      sourceLang: "English",
      targetLang: "Chinese",
      model: "primary-model",
    });
  });

  it("cancels the active task when the owner unmounts", () => {
    const { result, unmount } = renderHook(() =>
      useBatchTranslation({ sourceLang: "auto", targetLang: "Chinese" }),
    );
    act(() => result.current.setBatchInput("hello"));
    act(() => result.current.startBatchTranslation());

    unmount();
    expect(cancelTask).toHaveBeenCalledOnce();
  });
});

describe("combineComparisonResults", () => {
  it("preserves model attribution in the saved comparison", () => {
    expect(
      combineComparisonResults({
        primary: { text: "A", model: "alpha", durationMs: 10 },
        backup: { text: "B", model: "beta", durationMs: 20 },
      }),
    ).toEqual({
      text: "[alpha]\nA\n\n[beta]\nB",
      model: "alpha vs beta",
    });
  });
});
