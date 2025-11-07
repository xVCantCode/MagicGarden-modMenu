// src/services/sell.ts
// Installs keybind handlers for selling crops and pets.

import { PlayerService } from "./player";
import { eventMatchesKeybind } from "./keybinds";
import { shouldIgnoreKeydown } from "../utils/keyboard";
import { runSellAllPetsFlow } from "../utils/sellAllPets";
import { MiscService } from "./misc";
import { toastSimple } from "../ui/toast";
import { Atoms } from "../store/atoms";

let sellKeybindsInstalled = false;

export function installSellKeybindsOnce(): void {
  if (sellKeybindsInstalled || typeof window === "undefined") return;
  sellKeybindsInstalled = true;

  window.addEventListener(
    "keydown",
    (event) => {
      if (shouldIgnoreKeydown(event)) return;

      if (eventMatchesKeybind("sell.sell-all", event)) {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          try {
            if (MiscService.readBlockSellCrops?.(false)) {
              void toastSimple("Selling crops blocked", "Disable block in Misc to sell.", "warn");
              return;
            }
          } catch {}

          void PlayerService.sellAllCrops();
        })();
        return;
      }

      if (eventMatchesKeybind("sell.sell-all-pets", event)) {
        event.preventDefault();
        event.stopPropagation();
        void runSellAllPetsFlow();
      }
    },
    true,
  );
}
