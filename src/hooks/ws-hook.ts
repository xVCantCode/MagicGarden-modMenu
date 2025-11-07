// src/hooks/ws-hook.ts
import { NativeWS, sockets, setQWS } from "../core/state";
import { pageWindow, readSharedGlobal, shareGlobal } from "../utils/page-context";
import { parseWSData } from "../core/parse";
import { Atoms } from "../store/atoms";
import { lockerService } from "../services/locker";
import { MiscService } from "../services/misc";
import { plantCatalog } from "../data/hardcoded-data.clean";
import { StatsService } from "../services/stats";
import { toastSimple } from "../ui/toast";
import { PlayerService } from "../services/player";
import type { GardenState, PlantSlotTiming } from "../store/atoms";

export function installPageWebSocketHook() {
  if (!pageWindow || !NativeWS) return;

  function WrappedWebSocket(this: any, url: string | URL, protocols?: string | string[]) {
    const ws: WebSocket =
      protocols !== undefined
        ? new NativeWS(url as any, protocols)
        : new NativeWS(url as any);
    sockets.push(ws);

    ws.addEventListener("open", () => {
      setTimeout(() => {
        if ((ws as any).readyState === NativeWS.OPEN) setQWS(ws, "open-fallback");
      }, 800);
    });

    ws.addEventListener("message", async (ev: MessageEvent) => {
      const j = await parseWSData(ev.data);
      if (!j) return;
      if (
        !hasSharedQuinoaWS() &&
        (j.type === "Welcome" || j.type === "Config" || j.fullState || j.config)
      ) {
        setQWS(ws, "message:" + (j.type || "state"));
      }
    });
    return ws;
  }

  (WrappedWebSocket as any).prototype = NativeWS.prototype;
  try { (WrappedWebSocket as any).OPEN = (NativeWS as any).OPEN; } catch {}
  try { (WrappedWebSocket as any).CLOSED = (NativeWS as any).CLOSED; } catch {}
  try { (WrappedWebSocket as any).CLOSING = (NativeWS as any).CLOSING; } catch {}
  try { (WrappedWebSocket as any).CONNECTING = (NativeWS as any).CONNECTING; } catch {}

  (pageWindow as any).WebSocket = WrappedWebSocket as any;
  if (pageWindow !== window) {
    try { (window as any).WebSocket = WrappedWebSocket as any; } catch {}
  }

  function hasSharedQuinoaWS() {
    const existing = readSharedGlobal<WebSocket | null>("quinoaWS");
    return !!existing;
  }

  installHarvestCropInterceptor();
}

type ConnectionCtor = {
  sendMessage?: (message: unknown, ...rest: any[]) => unknown;
  prototype?: ConnectionCtor;
};

type ResolvedSendMessage =
  | { kind: "static" | "proto"; fn: (message: unknown, ...rest: any[]) => unknown }
  | null;

export type MessageInterceptorContext = {
  thisArg: unknown;
  args: any[];
};

export type MessageInterceptorResult =
  | void
  | { kind: "drop" }
  | { kind: "replace"; message: any };

export type MessageInterceptor = (
  message: any,
  context: MessageInterceptorContext
) => MessageInterceptorResult;

const interceptorsByType = new Map<string, MessageInterceptor[]>();

type AppliedInterceptorResult = { message: any; drop: boolean };

type InterceptorHookStatus = "idle" | "installing" | "installed";
let interceptorStatus: InterceptorHookStatus = readSharedGlobal<boolean>(
  "__tmMessageHookInstalled"
)
  ? "installed"
  : "idle";

let interceptorPoll: number | null = null;
let interceptorTimeout: number | null = null;

export function registerMessageInterceptor(
  type: string,
  interceptor: MessageInterceptor
): () => void {
  const list = interceptorsByType.get(type);
  if (list) {
    list.push(interceptor);
  } else {
    interceptorsByType.set(type, [interceptor]);
  }

  ensureMessageInterceptorInstalled();

  return () => {
    const current = interceptorsByType.get(type);
    if (!current) return;
    const index = current.indexOf(interceptor);
    if (index !== -1) current.splice(index, 1);
    if (current.length === 0) interceptorsByType.delete(type);
  };
}

function ensureMessageInterceptorInstalled() {
  if (interceptorStatus === "installed" || interceptorStatus === "installing") return;

  interceptorStatus = "installing";

  const tryInstall = () => {
    const Conn: ConnectionCtor | undefined =
      (pageWindow as any).MagicCircle_RoomConnection ||
      readSharedGlobal<ConnectionCtor>("MagicCircle_RoomConnection");
    if (!Conn) return false;

    const original = resolveSendMessage(Conn);
    if (!original) return false;

    const wrap = function (this: unknown, message: any, ...rest: any[]) {
      let currentMessage = message;

      try {
        const type = currentMessage?.type;
        if (type && interceptorsByType.size > 0) {
          const context: MessageInterceptorContext = { thisArg: this, args: rest };
          const result = applyInterceptors(type, currentMessage, context);
          if (result.drop) return;
          currentMessage = result.message;
        }
      } catch (error) {
        console.error("[MG-mod] Erreur dans le hook WS :", error);
      }

      return original.fn.call(this, currentMessage, ...rest);
    };

    if (original.kind === "static") {
      (Conn as any).sendMessage = wrap;
    } else {
      (Conn as any).prototype.sendMessage = wrap;
    }

    interceptorStatus = "installed";
    shareGlobal("__tmMessageHookInstalled", true);

    if (interceptorPoll !== null) {
      clearInterval(interceptorPoll);
      interceptorPoll = null;
    }
    if (interceptorTimeout !== null) {
      clearTimeout(interceptorTimeout);
      interceptorTimeout = null;
    }

    return true;
  };

  if (tryInstall()) return;

  interceptorPoll = window.setInterval(() => {
    if (tryInstall()) {
      if (interceptorPoll !== null) {
        clearInterval(interceptorPoll);
        interceptorPoll = null;
      }
    }
  }, 200);

  interceptorTimeout = window.setTimeout(() => {
    if (interceptorPoll !== null) {
      clearInterval(interceptorPoll);
      interceptorPoll = null;
    }
    if (interceptorStatus !== "installed") {
      interceptorStatus = "idle";
    }
    interceptorTimeout = null;
  }, 20000);
}

function applyInterceptors(
  type: string,
  initialMessage: any,
  context: MessageInterceptorContext
): AppliedInterceptorResult {
  const interceptors = interceptorsByType.get(type);
  if (!interceptors || interceptors.length === 0) {
    return { message: initialMessage, drop: false };
  }

  let currentMessage = initialMessage;
  for (const interceptor of [...interceptors]) {
    try {
      const result = interceptor(currentMessage, context);
      if (!result) continue;
      if (result.kind === "drop") {
        return { message: currentMessage, drop: true };
      }
      if (result.kind === "replace") {
        currentMessage = result.message;
      }
    } catch (error) {
    }
  }

  return { message: currentMessage, drop: false };
}

function installHarvestCropInterceptor() {
  if (readSharedGlobal<boolean>("__tmHarvestHookInstalled")) return;

  let latestGardenState: GardenState | null = null;
  let latestCropItemsToSell: any[] | null = null;
  let autoFavInstalled = false;

  void (async () => {
    try {
      latestGardenState = (await Atoms.data.garden.get()) ?? null;
    } catch {}
    try {
      await Atoms.data.garden.onChange((next) => {
        latestGardenState = (next as GardenState | null) ?? null;
      });
    } catch {}
    try {
      latestCropItemsToSell = await Atoms.inventory.myCropItemsToSell.get();
    } catch {}
    try {
      await Atoms.inventory.myCropItemsToSell.onChange((next) => {
        latestCropItemsToSell = Array.isArray(next) ? next.slice() : null;
      });
    } catch {}
  })();

  registerMessageInterceptor("HarvestCrop", (message) => {
    const slot = message.slot;
    const slotsIndex = message.slotsIndex;

    if (!Number.isInteger(slot as number) || !Number.isInteger(slotsIndex as number)) {
      return;
    }

    const garden = latestGardenState;
    const tileObjects = garden?.tileObjects;
    const tile = tileObjects ? (tileObjects[String(slot)] as any) : undefined;

    if (!tile || typeof tile !== "object" || tile.objectType !== "plant") {
      return;
    }

    const slots = Array.isArray(tile.slots) ? tile.slots : [];
    const cropSlot = slots[slotsIndex];

    if (!cropSlot || typeof cropSlot !== "object") {
      return;
    }

    const seedKey = extractSeedKey(tile);
    const sizePercent = extractSizePercent(cropSlot as PlantSlotTiming);
    const mutations = sanitizeMutations((cropSlot as PlantSlotTiming)?.mutations);

    const lockerEnabled = (() => {
      try {
        return lockerService.getState().enabled;
      } catch {
        return false;
      }
    })();

    if (lockerEnabled) {
      let harvestAllowed = true;

      try {
        harvestAllowed = lockerService.allowsHarvest({
          seedKey,
          sizePercent,
          mutations,
        });
      } catch {
        harvestAllowed = true;
      }

      if (!harvestAllowed) {
        console.log("[HarvestCrop] Blocked by locker", {
          slot,
          slotsIndex,
          seedKey,
          sizePercent,
          mutations,
        });
        return { kind: "drop" };
      }
    }

    StatsService.incrementGardenStat("totalHarvested");

    void (async () => {
      try {
        const garden = await Atoms.data.garden.get();
        const tileObjects = (garden as any)?.tileObjects ?? null;
        const tile = tileObjects ? tileObjects[String(slot)] : undefined;
        const cropSlot = Array.isArray(tile?.slots) ? tile.slots?.[slotsIndex] : undefined;
        console.log("[HarvestCrop]", {
          slot,
          slotsIndex,
          cropSlot,
        });
      } catch (error) {
        console.error("[HarvestCrop] Unable to log crop slot", error);
      }
    })();

    //return { kind: "drop" };
  });

  registerMessageInterceptor("RemoveGardenObject", (message) => {
    StatsService.incrementGardenStat("totalDestroyed");
  });

  registerMessageInterceptor("WaterPlant", (message) => {
    StatsService.incrementGardenStat("watercanUsed");
    StatsService.incrementGardenStat("waterTimeSavedMs", 5 * 60 * 1000);
  });

  registerMessageInterceptor("PlantSeed", (message) => {
    StatsService.incrementGardenStat("totalPlanted");
  });

  registerMessageInterceptor("PurchaseDecor", (message) => {
    StatsService.incrementShopStat("decorBought");
  });

  registerMessageInterceptor("PurchaseSeed", (message) => {
    StatsService.incrementShopStat("seedsBought");
  });

  registerMessageInterceptor("PurchaseEgg", (message) => {
    StatsService.incrementShopStat("eggsBought");
  });

  registerMessageInterceptor("PurchaseTool", (message) => {
    StatsService.incrementShopStat("toolsBought");
  });

  registerMessageInterceptor("HatchEgg", () => {
    void (async () => {
      const previousPets = await readInventoryPetSnapshots();
      const previousMap = buildPetMap(previousPets);

      const nextPets = await waitForInventoryPetAddition(previousMap);
      if (!nextPets) return;

      const newPets = extractNewPets(nextPets, previousMap);
      if (!newPets.length) return;

      for (const pet of newPets) {
        const rarity = inferPetRarity(pet.mutations);
        if (pet.species) {
          StatsService.incrementPetHatched(pet.species, rarity);
        }
      }
    })();
  });

  registerMessageInterceptor("SellAllCrops", (message) => {
    // Re-entry guard to allow the next SellAllCrops to pass through when we orchestrate the flow
    const ALLOW_FLAG_KEY = "__tmAllowNextSellAllCrops";
    const allowNext = !!readSharedGlobal<boolean>(ALLOW_FLAG_KEY);
    if (allowNext) {
      shareGlobal(ALLOW_FLAG_KEY, false);
      // Allow this one to go through (it was triggered by our orchestrated flow)
    } else {
      // Global block: veto entirely
      try {
        if (MiscService.readBlockSellCrops?.(false)) {
          console.log("[SellAllCrops] Blocked by setting");
          void toastSimple("Selling crops blocked", "Disable block in Misc to sell.", "warn");
          return { kind: "drop" };
        }
      } catch {}

      // Orchestrate: favorite protected species, send SellAllCrops, then unfavorite
      (async () => {
        try {
          const inv = await PlayerService.getCropInventoryState?.();
          const items = Array.isArray(inv) ? inv : [];
          const favSet = await PlayerService.getFavoriteIdSet?.().catch(() => new Set<string>()) as Set<string>;
          const protectedSet = (() => { try { return MiscService.readPetFoodSpeciesSet?.() ?? new Set<string>(); } catch { return new Set<string>(); }})();
          const protectedIds: string[] = [];
          for (const it of items) {
            const sp = String((it as any)?.species ?? "");
            const norm = sp
              .toLowerCase()
              .replace(/[\'’`]/g, "")
              .replace(/\s+/g, "")
              .replace(/-/g, "")
              .replace(/(seed|plant|baby|fruit|crop)$/i, "");
            if (protectedSet.has(norm) && typeof it?.id === "string" && it.id) {
              protectedIds.push(it.id);
            }
          }

          const toFavorite = protectedIds.filter((id) => !favSet.has(id));
          if (toFavorite.length > 0) {
            await PlayerService.ensureFavorites(toFavorite, true);
          }

          // Send our own message and allow it to pass through
          shareGlobal(ALLOW_FLAG_KEY, true);
          try {
            await PlayerService.sellAllCrops();
          } catch {}

          // Wait for one inventory diff as a signal of completion
          try {
            await new Promise<void>(async (resolve) => {
              let offUnsub: (() => void) | undefined;
              try {
                const reg = PlayerService.onCropInventoryDiff?.((inv, diff) => {
                  try { offUnsub?.(); } catch {}
                  resolve();
                });
                if (typeof reg === "function") offUnsub = reg as any;
                else if (reg && typeof (reg as any).then === "function") offUnsub = await (reg as Promise<() => void>);
              } catch {
                resolve();
              }
            });
          } catch {}

          // Unfavorite those we just favorited
          try {
            if (toFavorite.length > 0) {
              await PlayerService.ensureFavorites(toFavorite, false);
            }
          } catch {}
        } catch (error) {
          console.error("[SellAllCrops] Orchestration error", error);
        }
      })();

      return { kind: "drop" };
    }
    // Global block: veto entirely
    try {
      if (MiscService.readBlockSellCrops?.(false)) {
        console.log("[SellAllCrops] Blocked by setting");
        void toastSimple("Selling crops blocked", "Disable block in Misc to sell.", "warn");
        return { kind: "drop" };
      }
    } catch {}

    // (handled above in orchestrated branch)

    void (async () => {
      try {
        const items = await Atoms.inventory.myCropItemsToSell.get();
        const count = Array.isArray(items) ? items.length : 0;
        if (count > 0) {
          StatsService.incrementShopStat("cropsSoldCount", count);
        }
      } catch (error) {
        console.error("[SellAllCrops] Unable to read crop items", error);
      }

      try {
        const total = await Atoms.shop.totalCropSellPrice.get();
        const value = Number(total);
        if (Number.isFinite(value) && value > 0) {
          StatsService.incrementShopStat("cropsSoldValue", value);
        }
      } catch (error) {
        console.error("[SellAllCrops] Unable to read crop sell price", error);
      }
    })();
  });

  registerMessageInterceptor("SellPet", (message) => {
    StatsService.incrementShopStat("petsSoldCount");

    void (async () => {
      try {
        const total = await Atoms.pets.totalPetSellPrice.get();
        const value = Number(total);
        if (Number.isFinite(value) && value > 0) {
          StatsService.incrementShopStat("petsSoldValue", value);
        }
      } catch (error) {
        console.error("[SellPet] Unable to read pet sell price", error);
      }
    })();
  });

  // Persistency: auto-favorite protected species (Daffodil) when crops enter inventory
  if (!autoFavInstalled) {
    try {
      const off = PlayerService.onCropInventoryDiff?.(async (inv, diff) => {
        try {
          const enabled = MiscService.readPetFoodToggle?.(false);
          if (!enabled) return;
          const addedIds = Array.isArray(diff?.added) ? diff.added : [];
          if (!addedIds.length) return;
          const items = Array.isArray(inv) ? inv : [];
          const byId = new Map<string, any>();
          for (const it of items) {
            const id = String((it as any)?.id ?? "");
            if (id) byId.set(id, it);
          }
          const toFav: string[] = [];
          const protectedSet = (() => { try { return MiscService.readPetFoodSpeciesSet?.() ?? new Set<string>(); } catch { return new Set<string>(); }})();
          for (const id of addedIds) {
            const it = byId.get(String(id));
            if (!it) continue;
            const sp = String((it as any)?.species ?? "");
            const norm = sp
              .toLowerCase()
              .replace(/[\'’`]/g, "")
              .replace(/\s+/g, "")
              .replace(/-/g, "")
              .replace(/(seed|plant|baby|fruit|crop)$/i, "");
            if (protectedSet.has(norm)) {
              toFav.push(String(id));
            }
          }
          if (toFav.length) {
            await PlayerService.ensureFavorites?.(toFav, true);
          }
        } catch {}
      });
      autoFavInstalled = true;
    } catch {}
  }

  shareGlobal("__tmHarvestHookInstalled", true);
}

function extractSeedKey(tile: any): string | null {
  if (!tile || typeof tile !== "object") return null;
  if (typeof tile.seedKey === "string" && tile.seedKey) return tile.seedKey;
  if (typeof tile.species === "string" && tile.species) return tile.species;
  const fallbacks = ["seedSpecies", "plantSpecies", "cropSpecies", "speciesId"];
  for (const key of fallbacks) {
    const value = tile[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

const normalizeSpeciesKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/\s+/g, "")
    .replace(/-/g, "")
    .replace(/(seed|plant|baby|fruit|crop)$/i, "");

const MAX_SCALE_BY_SPECIES = (() => {
  const map = new Map<string, number>();
  const register = (key: unknown, value: number) => {
    if (typeof key !== "string") return;
    const normalized = normalizeSpeciesKey(key.trim());
    if (!normalized || map.has(normalized)) return;
    map.set(normalized, value);
  };

  for (const [species, entry] of Object.entries(plantCatalog as Record<string, any>)) {
    const maxScale = Number(entry?.crop?.maxScale);
    if (!Number.isFinite(maxScale) || maxScale <= 0) continue;
    register(species, maxScale);
    register(entry?.seed?.name, maxScale);
    register(entry?.plant?.name, maxScale);
    register(entry?.crop?.name, maxScale);
  }

  return map;
})();

function lookupMaxScale(species: unknown): number | null {
  if (typeof species !== "string") return null;
  const normalized = normalizeSpeciesKey(species.trim());
  if (!normalized) return null;
  const found = MAX_SCALE_BY_SPECIES.get(normalized);
  if (typeof found === "number" && Number.isFinite(found) && found > 0) {
    return found;
  }
  return null;
}

function getMaxScaleForSlot(slot: any): number | null {
  if (!slot || typeof slot !== "object") return null;
  const candidates = new Set<string>();
  const fromSeedKey = extractSeedKey(slot as any);
  if (fromSeedKey) candidates.add(fromSeedKey);
  const fields = [
    "species",
    "seedSpecies",
    "plantSpecies",
    "cropSpecies",
    "baseSpecies",
    "seedKey",
  ];
  for (const field of fields) {
    const value = (slot as Record<string, unknown>)[field];
    if (typeof value === "string" && value) {
      candidates.add(value);
    }
  }
  for (const cand of candidates) {
    const max = lookupMaxScale(cand);
    if (typeof max === "number" && Number.isFinite(max) && max > 0) {
      return max;
    }
  }
  return null;
}

function extractSizePercent(slot: PlantSlotTiming | undefined): number {
  if (!slot || typeof slot !== "object") return 100;
  const direct = Number(
    (slot as any).sizePercent ?? (slot as any).sizePct ?? (slot as any).size ?? (slot as any).percent ?? (slot as any).progressPercent
  );
  if (Number.isFinite(direct)) {
    return clampPercent(Math.round(direct), 0, 100);
  }
  const scale = Number((slot as any).targetScale ?? (slot as any).scale);
  if (Number.isFinite(scale)) {
    const maxScale = getMaxScaleForSlot(slot);
    if (typeof maxScale === "number" && Number.isFinite(maxScale) && maxScale > 1) {
      const clamped = Math.max(1, Math.min(maxScale, scale));
      const pct = 50 + ((clamped - 1) / (maxScale - 1)) * 50;
      return clampPercent(Math.round(pct), 50, 100);
    }
    if (scale > 1 && scale <= 2) {
      const pct = 50 + ((scale - 1) / 1) * 50;
      return clampPercent(Math.round(pct), 50, 100);
    }
    const pct = Math.round(scale * 100);
    return clampPercent(pct, 0, 100);
  }
  return 100;
}

function sanitizeMutations(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i];
    if (typeof value === "string") {
      if (value) out.push(value);
    } else if (value != null) {
      const str = String(value);
      if (str) out.push(str);
    }
  }
  return out;
}

function clampPercent(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type InventoryPetSnapshot = {
  id: string;
  species: string;
  mutations: string[];
};

const HATCH_EGG_TIMEOUT_MS = 5000;

async function readInventoryPetSnapshots(): Promise<InventoryPetSnapshot[]> {
  try {
    const inventory = await Atoms.inventory.myInventory.get();
    return collectInventoryPets(inventory);
  } catch (error) {
    console.error("[HatchEgg] Unable to read inventory", error);
    return [];
  }
}

function collectInventoryPets(rawInventory: any): InventoryPetSnapshot[] {
  const items = extractInventoryItems(rawInventory);
  const pets: InventoryPetSnapshot[] = [];
  for (const entry of items) {
    const pet = toInventoryPet(entry);
    if (pet) pets.push(pet);
  }
  return pets;
}

function extractInventoryItems(rawInventory: any): any[] {
  if (!rawInventory) return [];
  if (Array.isArray(rawInventory)) return rawInventory;
  if (Array.isArray(rawInventory.items)) return rawInventory.items;
  if (Array.isArray(rawInventory.inventory)) return rawInventory.inventory;
  if (Array.isArray(rawInventory.inventory?.items)) return rawInventory.inventory.items;
  return [];
}

function toInventoryPet(entry: any): InventoryPetSnapshot | null {
  if (!entry || typeof entry !== "object") return null;
  const source = (entry as any).item && typeof (entry as any).item === "object"
    ? (entry as any).item
    : entry;
  if (!source || typeof source !== "object") return null;
  const type = (source.itemType ?? source.data?.itemType ?? "") as string;
  if (String(type).toLowerCase() !== "pet") return null;

  const id = source.id ?? source.data?.id;
  const species = source.petSpecies ?? source.data?.petSpecies;
  if (!id || !species) return null;

  const mutations = sanitizeMutations(source.mutations ?? source.data?.mutations);

  return {
    id: String(id),
    species: String(species),
    mutations,
  };
}

function buildPetMap(pets: InventoryPetSnapshot[]): Map<string, InventoryPetSnapshot> {
  const map = new Map<string, InventoryPetSnapshot>();
  for (const pet of pets) {
    map.set(pet.id, pet);
  }
  return map;
}

function extractNewPets(
  pets: InventoryPetSnapshot[],
  previous: Map<string, InventoryPetSnapshot>
): InventoryPetSnapshot[] {
  return pets.filter(pet => !previous.has(pet.id));
}

function inferPetRarity(mutations: string[]): "normal" | "gold" | "rainbow" {
  if (!Array.isArray(mutations) || mutations.length === 0) {
    return "normal";
  }

  const seen = new Set(mutations.map(m => String(m).toLowerCase()));
  if (seen.has("rainbow")) return "rainbow";
  if (seen.has("gold") || seen.has("golden")) return "gold";
  return "normal";
}

async function waitForInventoryPetAddition(
  previous: Map<string, InventoryPetSnapshot>,
  timeoutMs = HATCH_EGG_TIMEOUT_MS
): Promise<InventoryPetSnapshot[] | null> {
  await delay(0);

  const initial = await readInventoryPetSnapshots();
  if (hasNewInventoryPet(initial, previous)) {
    return initial;
  }

  return new Promise(async (resolve) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finalize = (value: InventoryPetSnapshot[] | null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (unsub) {
        try { unsub(); } catch {}
      }
      resolve(value);
    };

    const evaluate = (source: any) => {
      const pets = collectInventoryPets(source);
      if (hasNewInventoryPet(pets, previous)) {
        finalize(pets);
      }
    };

    try {
      unsub = await Atoms.inventory.myInventory.onChange((next) => {
        evaluate(next);
      });
    } catch (error) {
      console.error("[HatchEgg] Unable to observe inventory", error);
      finalize(null);
      return;
    }

    timer = setTimeout(() => {
      void (async () => {
        const latest = await readInventoryPetSnapshots();
        if (hasNewInventoryPet(latest, previous)) {
          finalize(latest);
        } else {
          finalize(null);
        }
      })();
    }, timeoutMs);
  });
}

function hasNewInventoryPet(
  pets: InventoryPetSnapshot[],
  previous: Map<string, InventoryPetSnapshot>
): boolean {
  return pets.some(pet => !previous.has(pet.id));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveSendMessage(Conn: ConnectionCtor): ResolvedSendMessage {
  const isFn = (value: unknown): value is (...args: any[]) => any =>
    typeof value === "function";

  if (isFn(Conn.sendMessage)) {
    return { kind: "static" as const, fn: Conn.sendMessage.bind(Conn) };
  }

  if (Conn.prototype && isFn(Conn.prototype.sendMessage)) {
    return { kind: "proto" as const, fn: Conn.prototype.sendMessage };
  }

  return null;
}
