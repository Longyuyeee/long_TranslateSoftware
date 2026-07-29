import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addGlossaryEntry,
  deleteGlossaryEntry,
  listGlossaryEntries,
  updateGlossaryEntry,
} from "./glossary";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("glossary service", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
  });

  it("uses the typed glossary command boundary", async () => {
    const entries = [{
      id: 7,
      source_term: "source",
      target_term: "target",
      created_at: "2026-07-29",
    }];
    invokeMock.mockResolvedValueOnce(entries);

    await expect(listGlossaryEntries()).resolves.toEqual(entries);
    await addGlossaryEntry("source", "target");
    await updateGlossaryEntry(7, "updated", "translation");
    await deleteGlossaryEntry(7);

    expect(invokeMock.mock.calls).toEqual([
      ["get_glossary_entries"],
      ["add_glossary_entry", { sourceTerm: "source", targetTerm: "target" }],
      ["update_glossary_entry", {
        id: 7,
        sourceTerm: "updated",
        targetTerm: "translation",
      }],
      ["delete_glossary_entry", { id: 7 }],
    ]);
  });
});
