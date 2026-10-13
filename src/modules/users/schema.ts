import { Type } from '@sinclair/typebox';
import { Email, PageQuery, Uuid } from '../../lib/schemas.js';

export const Role = Type.Union([Type.Literal('admin'), Type.Literal('store_staff'), Type.Literal('supervisor'), Type.Literal('viewer')]);
export const ListUsersQuery = Type.Object({ ...PageQuery, role: Type.Optional(Role), active: Type.Optional(Type.Boolean()), q: Type.Optional(Type.String({ maxLength: 100 })) });
export const UpdateUserBody = Type.Object({ role: Type.Optional(Role), active: Type.Optional(Type.Boolean()) }, { additionalProperties: false, minProperties: 1 });
export const CreateInviteBody = Type.Object({
  email: Email, role: Role, fullName: Type.Optional(Type.String({ minLength: 1, maxLength: 150 })), personId: Type.Optional(Uuid),
  locationIds: Type.Optional(Type.Array(Uuid, { maxItems: 50, uniqueItems: true })),
}, { additionalProperties: false });
export const SetUserLocationsBody = Type.Object({ locationIds: Type.Array(Uuid, { maxItems: 100 }) }, { additionalProperties: false });
