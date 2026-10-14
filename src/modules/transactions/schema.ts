import { Type } from '@sinclair/typebox';
import { HolderBody, PageQuery, Uuid } from '../../lib/schemas.js';
import { Condition } from '../items/schema.js';

const Common = {
  note: Type.Optional(Type.String({ maxLength: 2000 })),
  snapshotFileId: Type.Optional(Uuid),
};
const Strict = { additionalProperties: false } as const;
const Qty = Type.Integer({ minimum: 1, maximum: 100_000_000 });

export const CheckoutBody = Type.Object({
  itemId: Uuid, holder: HolderBody, quantity: Type.Optional(Qty), jobId: Type.Optional(Uuid), purpose: Type.Optional(Type.String({ maxLength: 500 })),
  locationId: Type.Optional(Uuid), condition: Type.Optional(Condition), expectedReturnAt: Type.Optional(Type.String({ format: 'date-time' })), ...Common,
}, Strict);

export const BatchCheckoutBody = Type.Object({
  holder: HolderBody, jobId: Type.Optional(Uuid), purpose: Type.Optional(Type.String({ maxLength: 500 })), locationId: Type.Optional(Uuid), ...Common,
  lines: Type.Array(Type.Object({ itemId: Uuid, quantity: Type.Optional(Qty), condition: Type.Optional(Condition) }, Strict), { minItems: 1, maxItems: 100 }),
}, Strict);

export const CheckinBody = Type.Object({
  itemId: Uuid, holder: Type.Optional(HolderBody), quantity: Type.Optional(Qty), locationId: Type.Optional(Uuid), condition: Type.Optional(Condition),
  acceptOverReturn: Type.Optional(Type.Boolean()), ...Common,
}, Strict);

export const ConsumeBody = Type.Object({
  itemId: Uuid, quantity: Qty, locationId: Type.Optional(Uuid), jobId: Type.Optional(Uuid), purpose: Type.Optional(Type.String({ maxLength: 500 })), holder: Type.Optional(HolderBody), ...Common,
}, Strict);

export const RestockBody = Type.Object({ itemId: Uuid, quantity: Qty, locationId: Type.Optional(Uuid), ...Common }, Strict);

export const AdjustmentBody = Type.Object({
  itemId: Uuid, delta: Type.Integer({ minimum: -100_000_000, maximum: 100_000_000 }),
  reason: Type.Union([
    Type.Literal('count_correction'), Type.Literal('opening_balance'), Type.Literal('unrecorded_movement'),
    Type.Literal('damage'), Type.Literal('loss'), Type.Literal('other'),
  ]),
  locationId: Type.Optional(Uuid), ...Common,
}, Strict);

export const IncidentBody = Type.Object({
  itemId: Uuid, quantity: Type.Optional(Qty), holder: Type.Optional(HolderBody), locationId: Type.Optional(Uuid),
  reason: Type.String({ minLength: 3, maxLength: 500 }), ...Common,
}, Strict);

export const ConditionBody = Type.Object({ condition: Condition, ...Common }, Strict);
export const StatusBody = Type.Object({ to: Type.Union([Type.Literal('available'), Type.Literal('under_repair'), Type.Literal('retired')]), ...Common }, Strict);
export const TransferBody = Type.Object({ itemId: Uuid, fromLocationId: Uuid, toLocationId: Uuid, quantity: Type.Optional(Qty), ...Common }, Strict);
export const ReplacementBody = Type.Object({ replacementItemId: Uuid, note: Type.String({ minLength: 3, maxLength: 2000 }), snapshotFileId: Type.Optional(Uuid) }, Strict);
export const CorrectionBody = Type.Object({ note: Type.String({ minLength: 3, maxLength: 2000 }) }, Strict);

export const ListTransactionsQuery = Type.Object({
  limit: PageQuery.limit, cursor: Type.Optional(Type.String({ maxLength: 40 })),
  itemId: Type.Optional(Uuid), type: Type.Optional(Type.String({ maxLength: 40 })), actorUserId: Type.Optional(Uuid), locationId: Type.Optional(Uuid), jobId: Type.Optional(Uuid),
  holderType: Type.Optional(Type.Union([Type.Literal('person'), Type.Literal('team'), Type.Literal('job')])), holderId: Type.Optional(Uuid),
  source: Type.Optional(Type.Union([Type.Literal('online'), Type.Literal('offline_sync'), Type.Literal('import'), Type.Literal('system')])),
  from: Type.Optional(Type.String({ format: 'date-time' })), to: Type.Optional(Type.String({ format: 'date-time' })),
});
