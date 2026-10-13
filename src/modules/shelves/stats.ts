import { sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';

export interface CategoryStats {
  assets: number; assetsOut: number; overdue: number; underRepair: number; needsInspection: number;
  products: number; units: number; lowStock: number; needsAttention: number;
}
export const EMPTY_STATS: CategoryStats = { assets: 0, assetsOut: 0, overdue: 0, underRepair: 0, needsInspection: 0, products: 0, units: 0, lowStock: 0, needsAttention: 0 };

export function addStats(a: CategoryStats, b: CategoryStats): CategoryStats {
  const o = { ...a } as CategoryStats;
  (Object.keys(b) as (keyof CategoryStats)[]).forEach((k) => { o[k] += b[k]; });
  return o;
}

/**
 * One aggregate query for the "Collections" cards (UI kit): "48 assets, 11 out, 2 overdue", "6 products, 412 units,
 * Gloves low", "Inspect due". Scoped by org (and optionally shelf / category); cost is O(items in scope), index-backed.
 */
export async function categoryStats(db: Db, orgId: string, filter: { shelfId?: string; categoryId?: string } = {}): Promise<Map<string, CategoryStats>> {
  const rows = (await db.execute(sql`
    select c.id as category_id,
      count(i.id) filter (where i.type = 'asset')::int as assets,
      count(i.id) filter (where i.type = 'asset' and i.asset_status = 'checked_out')::int as assets_out,
      count(i.id) filter (where i.type = 'asset' and i.asset_status in ('under_repair','damaged'))::int as under_repair,
      count(i.id) filter (where i.type = 'asset' and i.condition = 'needs_inspection')::int as needs_inspection,
      count(i.id) filter (where i.type = 'consumable')::int as products,
      coalesce(sum(st.q) filter (where i.type = 'consumable'), 0)::int as units,
      count(i.id) filter (where i.type = 'consumable' and coalesce(i.min_threshold, c.default_min_threshold) is not null and st.q <= coalesce(i.min_threshold, c.default_min_threshold))::int as low_stock,
      (select count(*)::int from custody cu join items i2 on i2.id = cu.item_id
        where i2.category_id = c.id and i2.archived_at is null and cu.quantity > 0 and cu.due_at < now()) as overdue
    from categories c
    left join items i on i.category_id = c.id and i.archived_at is null
    left join lateral (select coalesce(sum(sl.quantity), 0) as q from stock_levels sl where sl.item_id = i.id) st on true
    where c.org_id = ${orgId}::uuid and c.archived_at is null
      ${filter.shelfId ? sql`and c.shelf_id = ${filter.shelfId}::uuid` : sql``}
      ${filter.categoryId ? sql`and c.id = ${filter.categoryId}::uuid` : sql``}
    group by c.id`)) as unknown as Array<Record<string, number | string>>;
  const out = new Map<string, CategoryStats>();
  for (const r of rows) {
    const underRepair = Number(r.under_repair); const needsInspection = Number(r.needs_inspection);
    out.set(String(r.category_id), {
      assets: Number(r.assets), assetsOut: Number(r.assets_out), overdue: Number(r.overdue), underRepair, needsInspection,
      products: Number(r.products), units: Number(r.units), lowStock: Number(r.low_stock),
      needsAttention: Number(r.overdue) + Number(r.low_stock) + underRepair + needsInspection,
    });
  }
  return out;
}
