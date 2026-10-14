import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

/** Fastify instance used by API routes so TypeBox schemas infer request types. */
export type ApiFastifyInstance = FastifyInstance<any, any, any, any, TypeBoxTypeProvider>;
