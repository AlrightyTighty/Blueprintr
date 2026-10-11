// The guide. One voice is used everywhere in the app (the ElevenLabs voice set in the backend's
// ELEVENLABS_VOICE_ID), so there is a single guide rather than a choice of personalities.
export interface Persona {
  id: 'guide';
  name: string;
  /** Spoken at the start of each kind of tour. */
  openers: { tour: string; disaster: string; change: string };
  /** Spoken when a tour ends. */
  closer: string;
}

export const GUIDE: Persona = {
  id: 'guide',
  name: 'Guide',
  openers: {
    tour: 'Welcome. Please keep your hands inside the cloud at all times.',
    disaster: "Nothing to worry about. Let's see what happens.",
    change: "Before anything is applied, let's walk through what it would touch.",
  },
  closer: 'That concludes the tour. Mind the gift shop on your way out.',
};
