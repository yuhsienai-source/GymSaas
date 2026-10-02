/** 場地站點名稱解析：逗號／頓號／換行分隔；支援 A~E 展開 */

export function parseStationNames(raw) {
  if (raw === undefined || raw === null) return [];
  const parts = Array.isArray(raw)
    ? raw.map((s) => String(s || '').trim()).filter(Boolean)
    : String(raw)
        .split(/[,，、\n\r]+/)
        .map((s) => s.trim())
        .filter(Boolean);

  const out = [];
  for (const part of parts) {
    const range = part.match(/^([A-Za-z])\s*[~～\-－至到]\s*([A-Za-z])$/u);
    if (range) {
      const a = range[1].toUpperCase().charCodeAt(0);
      const b = range[2].toUpperCase().charCodeAt(0);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (hi - lo > 25) {
        const err = new Error('站點範圍過大，請縮小（最多 26 個字母）');
        err.statusCode = 400;
        throw err;
      }
      for (let c = lo; c <= hi; c += 1) {
        out.push(String.fromCharCode(c));
      }
      continue;
    }
    if (part.length > 20) {
      const err = new Error(`站點名稱過長：${part}`);
      err.statusCode = 400;
      throw err;
    }
    out.push(part);
  }

  // 去重並保序
  return [...new Set(out)];
}

/**
 * 同步場地站點：依名稱清單重建（保留同名 id 以利已排課關聯）
 */
export async function syncVenueStations(tx, venueId, names) {
  const list = parseStationNames(names);
  const existing = await tx.venueStation.findMany({ where: { venueId } });
  const keepNames = new Set(list);
  const byName = new Map(existing.map((s) => [s.name, s]));

  for (const row of existing) {
    if (!keepNames.has(row.name)) {
      await tx.venueStation.delete({ where: { id: row.id } });
    }
  }

  const result = [];
  for (let i = 0; i < list.length; i += 1) {
    const name = list[i];
    const found = byName.get(name);
    if (found) {
      const updated = await tx.venueStation.update({
        where: { id: found.id },
        data: { sortOrder: i },
      });
      result.push(updated);
    } else {
      const created = await tx.venueStation.create({
        data: { venueId, name, sortOrder: i },
      });
      result.push(created);
    }
  }
  return result;
}

export function serializeVenueStation(row) {
  return {
    id: row.id,
    venueId: row.venueId,
    name: row.name,
    sortOrder: row.sortOrder ?? 0,
  };
}

export const venueWithStationsInclude = {
  branch: { select: { id: true, name: true, code: true, parentId: true } },
  stations: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
};

export function serializeVenue(row) {
  return {
    id: row.id,
    name: row.name,
    branchId: row.branchId,
    branch: row.branch || undefined,
    stations: (row.stations || []).map(serializeVenueStation),
  };
}

/** 場地／站點防衝堂 where：同站點互衝；未指定站點則與該場地所有課互衝 */
export function venueStationConflictWhere(venueId, stationId) {
  if (stationId == null) {
    return { venueId };
  }
  return {
    venueId,
    OR: [{ stationId }, { stationId: null }],
  };
}
