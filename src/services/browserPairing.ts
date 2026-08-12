import { invoke } from "@tauri-apps/api/core";

export interface BrowserPairingRequest {
  origin: string;
  display_name: string;
  capabilities: string[];
}

export interface BrowserPairingRecord extends BrowserPairingRequest {
  pairing_id: string;
  approved_at: string;
  last_used_at: string;
}

export function getBrowserPairings(): Promise<BrowserPairingRecord[]> {
  return invoke<BrowserPairingRecord[]>("get_browser_pairings");
}

export function approveBrowserPairing(
  request: BrowserPairingRequest,
): Promise<BrowserPairingRecord> {
  return invoke<BrowserPairingRecord>("approve_browser_pairing", { request });
}

export function rejectBrowserPairing(
  request: BrowserPairingRequest,
): Promise<void> {
  return invoke<void>("reject_browser_pairing", { request });
}

export function revokeBrowserPairing(pairingId: string): Promise<void> {
  return invoke<void>("revoke_browser_pairing", { pairingId });
}
