import multipart from '@fastify/multipart';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from 'fastify';

import { countMpeg1Layer3Frames, Mp3ParseError } from './mp3/frame-counter.js';

const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

type BuildAppOptions = {
  logger?: boolean;
  maxFileSizeBytes?: number;
};

type ErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;

  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 10,
      fileSize: maxFileSizeBytes,
    },
  });

  app.post('/file-upload', async (request, reply) => {
    const file = await request.file();

    if (!file) {
      return sendError(reply, 400, 'FILE_REQUIRED', 'Upload one MP3 file as multipart form data.');
    }

    let frameCount: number;
    try {
      frameCount = await countMpeg1Layer3Frames(file.file);
    } catch (error) {
      if (file.file.truncated) {
        return sendError(
          reply,
          413,
          'FILE_TOO_LARGE',
          `The uploaded file exceeds the ${maxFileSizeBytes}-byte limit.`,
        );
      }
      throw error;
    }

    if (file.file.truncated) {
      return sendError(
        reply,
        413,
        'FILE_TOO_LARGE',
        `The uploaded file exceeds the ${maxFileSizeBytes}-byte limit.`,
      );
    }

    return reply.code(200).send({ frameCount });
  });

  app.setErrorHandler((error: FastifyError | Mp3ParseError, _request, reply) => {
    if (error instanceof Mp3ParseError) {
      return sendError(reply, 400, 'INVALID_MP3', error.message);
    }

    if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return sendError(
        reply,
        413,
        'FILE_TOO_LARGE',
        `The uploaded file exceeds the ${maxFileSizeBytes}-byte limit.`,
      );
    }

    if (
      error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
      error.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE'
    ) {
      return sendError(
        reply,
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Content-Type must be multipart/form-data.',
      );
    }

    requestLogError(app, error);
    return sendError(reply, 500, 'INTERNAL_ERROR', 'The file could not be processed.');
  });

  return app;
}

function sendError(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.code(statusCode).send({ error: { code, message } } satisfies ErrorBody);
}

function requestLogError(app: FastifyInstance, error: FastifyError): void {
  app.log.error({ err: error }, 'Unhandled request error');
}
