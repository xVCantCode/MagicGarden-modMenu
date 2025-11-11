// src/services/removeGardenObject.ts
import { eventMatchesKeybind } from "./keybinds";
import { Atoms } from "../store/atoms";
import { shouldIgnoreKeydown } from "../utils/keyboard";
import { sendToGame } from "../core/webSocketBridge";

let installed = false;

export function installRemoveGardenObjectHotkeysOnce(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener(
    "keydown",
    (event) => {
      try {
        if (shouldIgnoreKeydown(event)) return;
      } catch {}

      if (!eventMatchesKeybind("game.remove-slot-75", event)) return;

      event.preventDefault();
      event.stopPropagation();

      (async () => {
        try {
          const cur = await Atoms.garden.myCurrentGardenTile.get();
          const tt = String(cur?.tileType ?? "");
          const li = Number(cur?.localTileIndex);
          if (tt !== "Dirt" && tt !== "Boardwalk") {
            console.warn("[Belial's Mod] RemoveGardenObject: current tile type invalid", cur);
            return;
          }
          if (!Number.isFinite(li)) {
            console.warn("[Belial's Mod] RemoveGardenObject: localTileIndex invalid", cur);
            return;
          }

          console.info("[Belial's Mod] RemoveGardenObject: sending", { slotType: tt, slot: li });

          // Use the internal bridge to send via the active page WebSocket
          sendToGame({ type: "RemoveGardenObject", slot: li, slotType: tt });
        } catch (err) {
          // Silently ignore; this mirrors other WS calls pattern in the repo
          console.error("[Belial's Mod] RemoveGardenObject: error", err);
        }
      })();
    },
    true,
  );
}