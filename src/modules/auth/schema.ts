import { Type } from '@sinclair/typebox';
import { Email, Password } from '../../lib/schemas.js';

export const RegisterBody = Type.Object({
  organizationName: Type.String({ minLength: 2, maxLength: 120 }),
  fullName: Type.Optional(Type.String({ minLength: 1, maxLength: 150 })),
  email: Email,
  password: Password,
  firstLocationName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, { additionalProperties: false });

export const LoginBody = Type.Object({
  organization: Type.String({ minLength: 2, maxLength: 80 }), // org slug
  email: Email,
  password: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });

export const ChangePasswordBody = Type.Object({
  currentPassword: Type.String({ minLength: 1, maxLength: 128 }),
  newPassword: Password,
}, { additionalProperties: false });

export const ForgotPasswordBody = Type.Object({
  organization: Type.String({ minLength: 2, maxLength: 80 }),
  email: Email,
}, { additionalProperties: false });

export const ResetPasswordBody = Type.Object({
  token: Type.String({ minLength: 20, maxLength: 200 }),
  password: Password,
}, { additionalProperties: false });

export const AcceptInviteBody = ResetPasswordBody;
