import { Type } from '@sinclair/typebox';
import { PageQuery, Uuid } from '../../lib/schemas.js';
import { ColorField, IconField } from '../../lib/appearance.js';

const NullInt = (min: number, max: number) => Type.Optional(Type.Union([Type.Integer({ minimum: min, maximum: max }), Type.Null()]));
export const ItemType = Type.Union([Type.Literal('asset'), Type.Literal('consumable')]);
export const Condition = Type.Union([Type.Literal('good'), Type.Literal('damaged'), Type.Literal('needs_inspection'), Type.Literal('replaced')]);
export const AssetStatus = Type.Union([
  Type.Literal('available'), Type.Literal('checked_out'), Type.Literal('lost'),
  Type.Literal('damaged'), Type.Literal('under_repair'), Type.Literal('retired'),
]);

export const CreateItemBody = Type.Object({
  type: ItemType,
  sku: Type.String({ minLength: 1, maxLength: 100 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 4000 })),
  categoryId: Uuid, // required: every item lives under a category (which lives under a shelf)
  photoFileId: Type.Optional(Uuid),
  color: ColorField, // shown on the card when there is no photo
  icon: IconField,
  qrCode: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), // generated when omitted
  // assets
  assetTag: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  condition: Type.Optional(Condition),
  expectedReturnHours: NullInt(1, 24 * 365),
  // consumables
  unit: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
  openingQuantity: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000_000 })),
  minThreshold: NullInt(0, 100_000_000),
  reorderQuantity: NullInt(1, 100_000_000),
}, { additionalProperties: false });
export type CreateItemBody = typeof CreateItemBody.static;

export const UpdateItemBody = Type.Partial(Type.Omit(CreateItemBody, ['type', 'openingQuantity', 'condition']), { additionalProperties: false });
export const BulkMoveBody = Type.Object({ itemIds: Type.Array(Uuid, { minItems: 1, maxItems: 200, uniqueItems: true }), categoryId: Uuid }, { additionalProperties: false });
export type UpdateItemBody = typeof UpdateItemBody.static;

export const ListItemsQuery = Type.Object({
  ...PageQuery,
  type: Type.Optional(ItemType),
  categoryId: Type.Optional(Uuid),
  shelfId: Type.Optional(Uuid),
  holderType: Type.Optional(Type.Union([Type.Literal('person'), Type.Literal('team'), Type.Literal('job')])),
  holderId: Type.Optional(Uuid),
  locationId: Type.Optional(Uuid),
  status: Type.Optional(AssetStatus),
  lowStock: Type.Optional(Type.Boolean()),
  q: Type.Optional(Type.String({ maxLength: 200 })),
  includeArchived: Type.Optional(Type.Boolean()),
});
export type ListItemsQuery = typeof ListItemsQuery.static;

export const LookupQuery = Type.Object({ code: Type.String({ minLength: 1, maxLength: 200 }) });
export const TimelineQuery = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 300 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
  type: Type.Optional(Type.String({ maxLength: 40 })),
});
