import { createHash, randomUUID } from 'node:crypto';
import type { SubjectRef } from './types.js';

export const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

/** The same subject and merge key always give the same fact id, across runs and machines. */
export const factId = (subject: SubjectRef, mergeKey: string): string =>
  sha1(`${subject.type}\u0000${subject.id}\u0000${mergeKey}`).slice(0, 24);

export const newId = (): string => randomUUID();
