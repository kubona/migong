const SECTION_BY_PREFIX = [
  ["/items/", "itemNames"],
  ["/abilities/", "abilityNames"],
  ["/monsters/", "monsterNames"],
  ["/equipment_types/", "equipmentTypeNames"],
  ["/combat_styles/", "combatStyleNames"],
  ["/damage_types/", "damageTypeNames"],
  ["/skills/", "skillNames"],
  ["/buff_types/", "buffTypeNames"],
];

let translations = {};

const LOCAL_OVERRIDES = {
  "/items/pathbreaker_boots": "开路者靴",
  "/items/pathbreaker_boots_refined": "开路者靴（精）",
  "/items/pathfinder_boots": "探路者靴",
  "/items/pathfinder_boots_refined": "探路者靴（精）",
  "/items/pathseeker_boots": "寻路者靴",
  "/items/pathseeker_boots_refined": "寻路者靴（精）",
  "/items/gatherer_cape": "采集者披风",
  "/items/gatherer_cape_refined": "采集者披风（精）",
  "/items/artificer_cape": "工匠披风",
  "/items/artificer_cape_refined": "工匠披风（精）",
  "/items/culinary_cape": "烹饪披风",
  "/items/culinary_cape_refined": "烹饪披风（精）",
  "/items/chance_cape": "机缘披风",
  "/items/chance_cape_refined": "机缘披风（精）",
  "/monsters/shadow_archer": "暗影弓手",
  "/monsters/pyre_hunter": "火焰猎手",
  "/monsters/frost_sniper": "霜冻狙击手",
  "/monsters/siren": "海妖",
  "/monsters/salamander": "火蜥蜴",
  "/monsters/dryad": "树精",
  "/monsters/giant_scorpion": "巨蝎",
  "/monsters/giant_mantis": "巨螳螂",
  "/monsters/cyclops": "独眼巨人",
  "/monsters/mimic": "宝箱怪",
};

export function installChineseTranslations(dictionary) {
  translations = dictionary && typeof dictionary === "object" ? dictionary : {};
}

export async function loadChineseTranslations(url = new URL("../data/zh.json", import.meta.url)) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`中文词条加载失败（${response.status}）`);
  installChineseTranslations(await response.json());
}

export function chineseName(hrid, fallback = "") {
  const id = String(hrid || "");
  if (LOCAL_OVERRIDES[id]) return LOCAL_OVERRIDES[id];
  const section = SECTION_BY_PREFIX.find(([prefix]) => id.startsWith(prefix))?.[1];
  const localized = section ? translations?.[section]?.[id] : "";
  return String(localized || fallback || id);
}
