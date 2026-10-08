import type { FactKind } from './plugins.js';

/**
 * The kinds ops-memory looks for out of the box. They are about places and the work done in them;
 * nothing here describes a guest or a staff member as a person.
 */
export const BUILT_IN_FACT_KINDS: Record<string, FactKind> = {
  recurring_issue: {
    name: 'recurring_issue',
    description:
      'A problem with the unit or something in it: broken, unreliable, dirty, noisy, leaking, missing. ' +
      'Topic names the thing (wifi, dishwasher, hot_water, smoke_alarm).'
  },
  equipment: {
    name: 'equipment',
    description:
      'A fact about an appliance or fixture in the unit that someone working there needs to know: ' +
      'model, quirk, how to operate or reset it, where it is.'
  },
  access_info: {
    name: 'access_info',
    description:
      'How to get in or around: entrance, parking, lockbox location, building door, elevator, garbage room. ' +
      'Never the code itself; codes are redacted before you see the text.'
  },
  guest_question: {
    name: 'guest_question',
    description:
      'Something guests ask about or struggle with at this unit (finding it, parking, the TV, check-in steps). ' +
      'Topic names the subject of the question.'
  },
  guest_praise: {
    name: 'guest_praise',
    description: 'Something guests consistently like about the unit (view, location, quiet, hot tub).'
  },
  cleaning_note: {
    name: 'cleaning_note',
    description:
      'Something cleaners or inspectors need to know for this unit: supply location, a hard-to-clean spot, ' +
      'a recurring miss, extra linen.'
  }
};

export const DEFAULT_FACT_KINDS = ['recurring_issue', 'equipment', 'access_info', 'guest_question'];

export const defaultMergeKey = (kind: string, topic: string): string => `${kind}:${slug(topic)}`;

/** `Hot Water ` and `hot-water` merge; anything not a letter or digit becomes `_`. */
export const slug = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'general';
