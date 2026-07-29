import { invoke } from "@tauri-apps/api/core";

export interface GlossaryEntry {
  id: number;
  source_term: string;
  target_term: string;
  created_at: string;
}

export async function listGlossaryEntries(): Promise<GlossaryEntry[]> {
  return await invoke<GlossaryEntry[]>("get_glossary_entries");
}

export async function addGlossaryEntry(
  sourceTerm: string,
  targetTerm: string,
): Promise<void> {
  await invoke("add_glossary_entry", { sourceTerm, targetTerm });
}

export async function updateGlossaryEntry(
  id: number,
  sourceTerm: string,
  targetTerm: string,
): Promise<void> {
  await invoke("update_glossary_entry", { id, sourceTerm, targetTerm });
}

export async function deleteGlossaryEntry(id: number): Promise<void> {
  await invoke("delete_glossary_entry", { id });
}
