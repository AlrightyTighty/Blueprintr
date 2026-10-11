import type { Journey } from '../../core/journeys/types';
import { GUIDE, type Persona } from './personas';

/** Exactly what the guide says at a stop: a tour's opening line, the stop, and a closing line. */
export function spokenTextFor(journey: Journey, stopIndex: number, persona: Persona = GUIDE): string {
  const isFirst = stopIndex === 0;
  const isLast = stopIndex === journey.stops.length - 1;
  const openerKind = journey.kind === 'disaster' ? 'disaster' : journey.kind === 'change' ? 'change' : 'tour';
  return [isFirst ? persona.openers[openerKind] : '', journey.stops[stopIndex].script, isLast ? persona.closer : '']
    .filter(Boolean)
    .join(' ');
}
