import { chineseName } from "./localization.js";

export const OFFICIAL_ITEM_SPRITE = "./assets/items_sprite.f58c9476.svg";
const OFFICIAL_ITEM_SPRITE_MODULE_PATH = "../assets/items_sprite.f58c9476.svg";
export const EQUIPMENT_GRID_ORDER = [
  ["/equipment_types/main_hand", "/equipment_types/off_hand"],
  ["/equipment_types/head", "/equipment_types/back"],
  ["/equipment_types/body", "/equipment_types/neck"],
  ["/equipment_types/legs", "/equipment_types/earrings"],
  ["/equipment_types/hands", "/equipment_types/ring"],
  ["/equipment_types/feet", "/equipment_types/pouch"],
];

function iconHrid(hrid, catalog) {
  const id = String(hrid || "");
  if (id.startsWith("/items/")) return id;
  if (id.startsWith("/abilities/")) {
    const itemHrid = `/items/${id.split("/").pop()}`;
    if (catalog?.itemDetailMap?.[itemHrid]) return itemHrid;
    return "";
  }
  return "";
}

function safe(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" }[c]));
}

export function officialIconMarkup(hrid, catalog, label = "") {
  const symbol = iconHrid(hrid, catalog).split("/").pop();
  if (!symbol) return `<span class="loadout-icon-fallback" aria-hidden="true">?</span>`;
  return `<svg class="loadout-icon" role="img" aria-label="${safe(label)}"><use href="${OFFICIAL_ITEM_SPRITE}#${safe(symbol)}"></use></svg>`;
}

export function equipmentGridRows(equipment = {}) {
  const twoHand = equipment["/equipment_types/two_hand"] || null;
  return EQUIPMENT_GRID_ORDER.map(([leftType, rightType], index) => {
    if (index === 0 && twoHand) {
      return [
        { type: leftType, sourceType: "/equipment_types/two_hand", item: twoHand },
        { type: rightType, sourceType: rightType, item: null },
      ];
    }
    return [
      { type: leftType, sourceType: leftType, item: equipment[leftType] || null },
      { type: rightType, sourceType: rightType, item: equipment[rightType] || null },
    ];
  });
}

function displayGearCell(cell, catalog, slotNames) {
  const item = cell.item;
  return {
    type: cell.type,
    sourceType: cell.sourceType,
    slot: cell.type ? (slotNames[cell.type] || cell.type) : "",
    sourceSlot: cell.sourceType ? (slotNames[cell.sourceType] || cell.sourceType) : "",
    name: item ? chineseName(item.hrid, item.name) : "",
    level: item ? `+${item.enhancementLevel || 0}` : "",
    hrid: item ? iconHrid(item.hrid, catalog) : "",
    item,
  };
}

export function loadoutRows(result, catalog, slotNames) {
  const equipment = result?.bestPlan?.equipmentCandidate?.equipment || {};
  const gearPairs = equipmentGridRows(equipment).map((row) => row.map((cell) => displayGearCell(cell, catalog, slotNames)));
  const abilities = result?.bestPlan?.abilityOrder?.abilities || [];
  return {
    gearPairs,
    gear: gearPairs.flat().filter((entry) => entry.item),
    abilities: abilities.map((ability, index) => ({ slot: index === 0 ? "特殊技能" : `主动${index}`, name: chineseName(ability.hrid, ability.name), level: `等级 ${ability.level}`, hrid: iconHrid(ability.hrid, catalog) })),
  };
}

function iconSvg(entry, x, y, size = 26) {
  const symbol = entry.hrid.split("/").pop();
  return symbol
    ? `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 50 50"><use href="#${safe(symbol)}"></use></svg>`
    : "";
}

function summaryRowSvg(result, catalog, slotNames, title, offsetY, index) {
  const rows = loadoutRows(result, catalog, slotNames);
  const height = Math.max(236, 44 + rows.gearPairs.length * 30, 44 + rows.abilities.length * 34);
  const gear = rows.gearPairs.map((pair, rowIndex) => pair.map((entry, columnIndex) => {
    const x = 270 + columnIndex * 405;
    const y = 18 + rowIndex * 30;
    const itemText = entry.item ? safe(entry.name) : "—";
    const sourceHint = entry.sourceType === "/equipment_types/two_hand" ? " · 双手" : "";
    return `<text x="${x}" y="${y + 19}" fill="#8f938b" font-family="Microsoft YaHei, sans-serif" font-size="12">${safe(entry.slot)}${sourceHint}</text>${iconSvg(entry, x + 58, y, 25)}<text x="${x + 90}" y="${y + 19}" fill="${entry.item ? "#f4efe4" : "#6d716b"}" font-family="Microsoft YaHei, sans-serif" font-size="13">${itemText}</text><text x="${x + 385}" y="${y + 19}" text-anchor="end" fill="#d6ad57" font-family="Microsoft YaHei, sans-serif" font-size="12">${safe(entry.level)}</text>`;
  }).join("")).join("");
  const abilities = rows.abilities.map((entry, abilityIndex) => {
    const x = 1100;
    const y = 18 + abilityIndex * 34;
    return `<text x="${x}" y="${y + 20}" fill="#8f938b" font-family="Microsoft YaHei, sans-serif" font-size="12">${safe(entry.slot)}</text>${iconSvg(entry, x + 70, y, 27)}<text x="${x + 108}" y="${y + 20}" fill="#f4efe4" font-family="Microsoft YaHei, sans-serif" font-size="13">${safe(entry.name)}</text><text x="1680" y="${y + 20}" text-anchor="end" fill="#d6ad57" font-family="Microsoft YaHei, sans-serif" font-size="12">${safe(entry.level)}</text>`;
  }).join("");
  const background = index % 2 === 0 ? "#151716" : "#101211";
  return { height, markup: `<g transform="translate(0 ${offsetY})"><rect width="1720" height="${height}" fill="${background}"/><line x1="0" y1="${height - 1}" x2="1720" y2="${height - 1}" stroke="#343832"/><text x="24" y="48" fill="#d6ad57" font-family="Microsoft YaHei, sans-serif" font-size="23" font-weight="700">${safe(title)}</text><text x="24" y="77" fill="#aaa79d" font-family="Microsoft YaHei, sans-serif" font-size="13">${result.learning ? (result.targetMet ? "已认证等级" : "未认证候选等级") : "最高怪物等级"} ${safe(result.highestMonsterLevel ?? result.highestLevel)} · 胜率 ${safe(((result.finalResult?.clearRate || 0) * 100).toFixed(1))}%</text>${gear}${abilities}</g>` };
}

export function buildLoadoutSvg(results, catalog, slotNames, monsterNames, spriteText) {
  const completed = results.filter(Boolean).map((result) => ({ hrid: result.monsterHrid, result }));
  if (!completed.length) return "";
  const defs = spriteText.replace(/^.*?<svg[^>]*>/s, "").replace(/<\/svg>\s*$/s, "");
  const titleHeight = 90;
  let offset = titleHeight;
  const rows = completed.map(({ hrid, result }, index) => { const row = summaryRowSvg(result, catalog, slotNames, monsterNames[hrid] || result.name, offset, index); offset += row.height; return row.markup; }).join("");
  const header = `<rect width="1720" height="${titleHeight}" fill="#101211"/><text x="24" y="38" fill="#d6ad57" font-family="Microsoft YaHei, sans-serif" font-size="27" font-weight="700">迷宫配装总表</text><text x="24" y="70" fill="#aaa79d" font-family="Microsoft YaHei, sans-serif" font-size="13">怪物与结果</text><text x="270" y="70" fill="#aaa79d" font-family="Microsoft YaHei, sans-serif" font-size="13">装备（左右两列）</text><text x="1100" y="70" fill="#aaa79d" font-family="Microsoft YaHei, sans-serif" font-size="13">技能顺序</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1720" height="${offset}" viewBox="0 0 1720 ${offset}"><defs>${defs}</defs>${header}${rows}</svg>`;
}

export async function downloadLoadouts(results, catalog, slotNames, monsterNames) {
  if (!results.some(Boolean)) return false;
  const spriteText = await fetch(new URL(OFFICIAL_ITEM_SPRITE_MODULE_PATH, import.meta.url)).then((response) => { if (!response.ok) throw new Error(`官方图标读取失败（${response.status}）`); return response.text(); });
  const svg = buildLoadoutSvg(results, catalog, slotNames, monsterNames, spriteText);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `mwi迷宫配装总表-v039-${new Date().toISOString().slice(0, 10)}.svg`; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
  return true;
}
