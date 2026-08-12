import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  approveBrowserPairing,
  getBrowserPairings,
  rejectBrowserPairing,
  revokeBrowserPairing,
  type BrowserPairingRecord,
  type BrowserPairingRequest,
} from "../services/browserPairing";

interface UseBrowserPairingOptions {
  onError: (message: string) => void;
}

export function useBrowserPairing({ onError }: UseBrowserPairingOptions) {
  const [pendingRequest, setPendingRequest] =
    useState<BrowserPairingRequest | null>(null);
  const [pairings, setPairings] = useState<BrowserPairingRecord[]>([]);
  const [isUpdating, setIsUpdating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setPairings(await getBrowserPairings());
    } catch (error) {
      onError(String(error));
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
    let active = true;
    const unlisten = listen<BrowserPairingRequest>(
      "browser-pairing-requested",
      (event) => {
        if (active) setPendingRequest(event.payload);
      },
    );
    return () => {
      active = false;
      void unlisten.then((dispose) => dispose());
    };
  }, [refresh]);

  const approve = useCallback(async () => {
    if (!pendingRequest || isUpdating) return;
    setIsUpdating(true);
    try {
      const record = await approveBrowserPairing(pendingRequest);
      setPairings((current) => [
        ...current.filter((item) => item.origin !== record.origin),
        record,
      ]);
      setPendingRequest(null);
    } catch (error) {
      onError(String(error));
    } finally {
      setIsUpdating(false);
    }
  }, [isUpdating, onError, pendingRequest]);

  const reject = useCallback(async () => {
    if (!pendingRequest || isUpdating) return;
    setIsUpdating(true);
    try {
      await rejectBrowserPairing(pendingRequest);
      setPendingRequest(null);
    } catch (error) {
      onError(String(error));
    } finally {
      setIsUpdating(false);
    }
  }, [isUpdating, onError, pendingRequest]);

  const revoke = useCallback(
    async (pairingId: string) => {
      if (isUpdating) return;
      setIsUpdating(true);
      try {
        await revokeBrowserPairing(pairingId);
        setPairings((current) =>
          current.filter((item) => item.pairing_id !== pairingId),
        );
      } catch (error) {
        onError(String(error));
      } finally {
        setIsUpdating(false);
      }
    },
    [isUpdating, onError],
  );

  return { pendingRequest, pairings, isUpdating, approve, reject, revoke };
}
