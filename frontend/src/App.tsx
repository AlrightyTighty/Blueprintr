import FindingsPanel from './features/findings/FindingsPanel';
import GraphView from './features/graph-view/GraphView';
import { useGraphStore } from './features/graph-view/useGraphStore';
import PlanPanel from './features/plan-overlay/PlanPanel';

export default function App() {
  const { direction, setDirection } = useGraphStore();

  const toggleClass = (isActive: boolean) =>
    `rounded px-3 py-1 transition-colors ${
      isActive ? 'bg-violet-600 text-white' : 'bg-indigo-950 text-indigo-200 hover:bg-indigo-900'
    }`;

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-indigo-900 px-4 py-2">
        <h1 className="text-lg font-semibold text-indigo-200">Blueprint</h1>
        <div className="flex gap-2 text-sm">
          <button className={toggleClass(direction === 'dependents')} onClick={() => setDirection('dependents')}>
            What breaks?
          </button>
          <button
            className={toggleClass(direction === 'dependencies')}
            onClick={() => setDirection('dependencies')}
          >
            What does it use?
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <FindingsPanel />
        <main className="flex-1">
          <GraphView />
        </main>
        <PlanPanel />
      </div>
    </div>
  );
}
