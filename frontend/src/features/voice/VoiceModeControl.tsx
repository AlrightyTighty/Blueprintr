import { useVoiceStore, type VoiceMode } from './useVoiceStore';

const OPTIONS: { mode: VoiceMode; label: string; description: string }[] = [
  { mode: 'off', label: 'Off', description: 'Captions only. Nothing is played and no credits are used.' },
  { mode: 'saved', label: 'Saved', description: 'Plays the pre-recorded demo clips. Free. Anything without a clip stays a caption.' },
  { mode: 'live', label: 'Live', description: 'Also has ElevenLabs speak any other line on demand. This uses voice credits.' },
];

/** The one place to decide whether the guide may spend ElevenLabs credits. */
export default function VoiceModeControl() {
  const { mode, setMode } = useVoiceStore();

  return (
    <div role="group" aria-label="Guide voice" className="flex items-center gap-2 text-xs">
      <span className="text-slate-400">Voice</span>
      <div className="flex overflow-hidden rounded border border-indigo-900">
        {OPTIONS.map((option) => {
          const isActive = option.mode === mode;
          // Live is the only mode that costs money, so it looks different when it's on.
          const activeClass = option.mode === 'live' ? 'bg-amber-500 text-slate-950' : 'bg-violet-600 text-white';
          return (
            <button
              key={option.mode}
              type="button"
              title={option.description}
              aria-pressed={isActive}
              className={`px-2.5 py-1 transition-colors ${isActive ? activeClass : 'bg-indigo-950 text-indigo-200 hover:bg-indigo-900'}`}
              onClick={() => setMode(option.mode)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
