// Безопасные зоны вертикальных роликов: места кадра, которые в приложениях
// закрывают кнопки, подпись к ролику и шапка. Доли кадра 9:16 (1080×1920);
// цифры — по официальным гайдам площадок и замерам интерфейсов, с запасом.
//
// top    — шапка (вкладки, «Reels», камера);
// bottom — ник, подпись, музыка, нижнее меню;
// right  — столбик кнопок (лайк, комментарии, репост) от rightFrom до rightTo по высоте.

export const SAFE_PLATFORMS = [
  { id: "all", label: "Все сразу", top: 0.11, bottom: 0.22, right: 0.125, rightFrom: 0.42, rightTo: 0.86 },
  { id: "tiktok", label: "TikTok", top: 0.085, bottom: 0.2, right: 0.115, rightFrom: 0.46, rightTo: 0.86 },
  { id: "reels", label: "Reels", top: 0.11, bottom: 0.22, right: 0.11, rightFrom: 0.5, rightTo: 0.86 },
  { id: "shorts", label: "Shorts", top: 0.075, bottom: 0.21, right: 0.125, rightFrom: 0.42, rightTo: 0.84 },
];

export function safePlatform(id) {
  return SAFE_PLATFORMS.find((item) => item.id === id) || SAFE_PLATFORMS[0];
}

/**
 * Блок субтитров не заходит в шапку и нижнюю зону. alignment — как у движка:
 * verticalAlign («top» | «center» | «bottom») и verticalOffset (доля кадра).
 * half — примерная половина высоты блока для выравнивания по центру.
 */
export function keepAlignmentSafe(alignment, zone, half = 0.06) {
  const top = zone.top + 0.01;
  const bottom = 1 - zone.bottom - 0.01;
  const align = alignment.verticalAlign || "bottom";
  const offset = Number(alignment.verticalOffset ?? 0.78);
  let safe = offset;
  if (align === "bottom") safe = Math.min(Math.max(offset, top + half * 2), bottom);
  else if (align === "top") safe = Math.max(Math.min(offset, bottom - half * 2), top);
  else safe = Math.min(Math.max(offset, top + half), bottom - half);
  return safe === offset ? alignment : { ...alignment, verticalOffset: Math.round(safe * 1000) / 1000 };
}

/** Центр строки (доля кадра) с половиной высоты half — внутри безопасной полосы. */
export function keepCenterSafe(y, zone, half = 0.03) {
  const top = zone.top + 0.01 + half;
  const bottom = 1 - zone.bottom - 0.01 - half;
  return Math.min(Math.max(y, top), Math.max(top, bottom));
}

/** Пересекает ли прямоугольник (доли кадра) закрытые зоны площадки. */
export function rectUnsafe(rect, zone) {
  if (!rect) return false;
  const bottomEdge = rect.y + rect.h;
  if (rect.y < zone.top || bottomEdge > 1 - zone.bottom) return true;
  const right = rect.x + rect.w;
  return right > 1 - zone.right && bottomEdge > zone.rightFrom && rect.y < zone.rightTo;
}
