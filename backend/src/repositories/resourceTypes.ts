import type { Db } from '../db/pool.js';

export interface ResourceTypeRow {
  terraformType: string;
  provider: string;
  service: string;
  displayName: string;
  category: string;
  iconKey: string;
  color: string;
}

export function mapResourceType(row: Record<string, any>, prefix = ''): ResourceTypeRow {
  return {
    terraformType: row[`${prefix}terraform_type`],
    provider: row[`${prefix}provider`],
    service: row[`${prefix}service`],
    displayName: row[`${prefix}display_name`],
    category: row[`${prefix}category`],
    iconKey: row[`${prefix}icon_key`],
    color: row[`${prefix}color`],
  };
}

export async function list(db: Db): Promise<ResourceTypeRow[]> {
  const { rows } = await db.query(
    `SELECT terraform_type, provider, service, display_name, category, icon_key, color
     FROM resource_types ORDER BY sort_order, terraform_type`,
  );
  return rows.map((row) => mapResourceType(row));
}
