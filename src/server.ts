import { buildApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';
const maxFileSizeBytes = process.env.MAX_FILE_SIZE_BYTES
  ? Number.parseInt(process.env.MAX_FILE_SIZE_BYTES, 10)
  : undefined;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

if (
  maxFileSizeBytes !== undefined &&
  (!Number.isInteger(maxFileSizeBytes) || maxFileSizeBytes < 1)
) {
  throw new Error('MAX_FILE_SIZE_BYTES must be a positive integer.');
}

const app = await buildApp({
  logger: true,
  ...(maxFileSizeBytes === undefined ? {} : { maxFileSizeBytes }),
});

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
