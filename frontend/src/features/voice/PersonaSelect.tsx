import { useTourStore } from '../tour-player/useTourStore';
import { PERSONAS, type PersonaId } from './personas';

/** Switches the guide's voice. Takes effect from the next line the guide speaks. */
export default function PersonaSelect() {
  const { personaId, setPersona } = useTourStore();

  return (
    <select
      aria-label="Guide personality"
      className="rounded border border-indigo-900 bg-indigo-950 px-2 py-1 text-sm text-slate-100"
      title={PERSONAS[personaId].description}
      value={personaId}
      onChange={(event) => setPersona(event.target.value as PersonaId)}
    >
      {Object.values(PERSONAS).map((persona) => (
        <option key={persona.id} value={persona.id}>
          {persona.name}
        </option>
      ))}
    </select>
  );
}
