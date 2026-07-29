import { invoke } from "@tauri-apps/api/core";

export interface TranslationHistoryEntry {
  id: number;
  source_text: string;
  translated_text: string;
  source_lang: string;
  target_lang: string;
  model: string;
  created_at: string;
}

export function listTranslationHistory(
  limit = 100,
  offset = 0,
): Promise<TranslationHistoryEntry[]> {
  return invoke<TranslationHistoryEntry[]>("get_translation_history", {
    limit,
    offset,
  });
}

export function deleteTranslationHistoryEntry(id: number): Promise<void> {
  return invoke<void>("delete_translation", { id });
}

export function clearTranslationHistory(): Promise<void> {
  return invoke<void>("clear_translation_history");
}
