// The guide's personalities. Today each is a browser voice with its own pace and pitch; each can
// become an ElevenLabs voice by adding a voiceId here once the backend offers narration audio.
export type PersonaId = 'calm_docent' | 'overexcited_guide';

export interface Persona {
  id: PersonaId;
  name: string;
  description: string;
  /** Speech rate and pitch for the browser voice (1 is normal). */
  rate: number;
  pitch: number;
  /** Spoken at the start of each kind of tour. */
  openers: { tour: string; disaster: string; change: string };
  /** Spoken when a tour ends. */
  closer: string;
}

export const PERSONAS: Record<PersonaId, Persona> = {
  calm_docent: {
    id: 'calm_docent',
    name: 'Calm docent',
    description: 'Unhurried, like a museum guide. Unbothered even by outages.',
    rate: 0.9,
    pitch: 0.9,
    openers: {
      tour: "Welcome. Please keep your hands inside the cloud at all times.",
      disaster: "Nothing to worry about. Let's see what happens.",
      change: "Before anything is applied, let's walk through what it would touch.",
    },
    closer: 'That concludes the tour. Mind the gift shop on your way out.',
  },
  overexcited_guide: {
    id: 'overexcited_guide',
    name: 'Overexcited guide',
    description: 'Thrilled by every Lambda. Even more thrilled by failures.',
    rate: 1.15,
    pitch: 1.3,
    openers: {
      tour: "Oh, you are going to love this! Follow me!",
      disaster: 'Oh, this is my favourite part!',
      change: "Ooh, a change! Let's see what it shakes loose!",
    },
    closer: "And that's the tour! Wasn't that wonderful?",
  },
};

export const DEFAULT_PERSONA_ID: PersonaId = 'calm_docent';
