/** Small shared TypeBox fragments, so every module validates ids and pages identically. */
import { Type } from '@sinclair/typebox';

export const Uuid = Type.String({ format: 'uuid' });
export const IdParams = Type.Object({ id: Uuid });
export const PageQuery = {
  cursor: Type.Optional(Type.String({ maxLength: 300 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
};
export const HolderBody = Type.Object({
  type: Type.Union([Type.Literal('person'), Type.Literal('team'), Type.Literal('job')]),
  id: Uuid,
});
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const Email = Type.String({ format: 'email', maxLength: 254 });
export const Password = Type.String({ minLength: 12, maxLength: 128 });
