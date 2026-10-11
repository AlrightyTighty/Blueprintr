import { Link } from 'react-router-dom';
import { primaryButtonClass, secondaryButtonClass } from '../components/ui';
import { useAuthStore } from '../features/auth/useAuthStore';

const STEPS = [
  {
    title: 'Link a repo',
    body: 'Point Ripplemap at a GitHub repository. It reads your Terraform and your Python or JavaScript, and never runs either.',
  },
  {
    title: 'See one graph',
    body: 'Code and cloud resources are linked into a single map. Every link says how sure we are: certain, high, or inferred.',
  },
  {
    title: 'Take the tour',
    body: 'A guide walks a real request through your system, stop by stop, with the code beside the Terraform that runs it.',
  },
];

const TOURS = [
  {
    name: 'First day',
    body: 'The main journeys through the system, starting at the front door: the domain.',
    accent: 'text-blue-300',
  },
  {
    name: 'Follow a request',
    body: 'Pick one journey and ride it end to end, from the API to where the data ends up.',
    accent: 'text-indigo-300',
  },
  {
    name: 'Disaster tour',
    body: 'Pull the plug on a resource and watch the failure spread, narrated by a guide who stays entirely calm.',
    accent: 'text-rose-300',
  },
  {
    name: 'Change tour',
    body: 'Paste a Terraform plan and see what the change touches before you apply it, including the code that depends on it.',
    accent: 'text-amber-300',
  },
];

const PROMISES = [
  { title: 'Static analysis only', body: 'We read files. We never run terraform apply or any code from your repo.' },
  { title: 'Honest about guesses', body: 'Inferred links are labelled in the graph and out loud on the tour. Humans review every conclusion.' },
  { title: 'The guide never invents', body: 'It only talks about things that exist in your graph, and points to the file and line.' },
];

/** A ripple spreading out from a failing resource through the things that depend on it. */
function RippleIllustration() {
  const nodes = [
    { x: 200, y: 150, label: 'orders table', isRoot: true },
    { x: 110, y: 90, label: 'api function' },
    { x: 290, y: 90, label: 'worker' },
    { x: 70, y: 40, label: 'API Gateway' },
    { x: 330, y: 40, label: 'queue' },
    { x: 200, y: 245, label: 'CDN' },
  ];
  const links = [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 4],
    [0, 5],
  ];

  return (
    <svg viewBox="0 0 400 290" role="img" aria-label="A failure rippling outward through connected cloud resources" className="w-full max-w-md">
      {[0, 1, 2].map((ring) => (
        <circle
          key={ring}
          className="ripple-ring"
          cx="200"
          cy="150"
          r="130"
          fill="none"
          stroke="#8b5cf6"
          strokeWidth="1.5"
          style={{ animationDelay: `${ring * 1.3}s` }}
        />
      ))}
      {links.map(([from, to]) => (
        <line key={`${from}-${to}`} x1={nodes[from].x} y1={nodes[from].y} x2={nodes[to].x} y2={nodes[to].y} stroke="#475a85" strokeWidth="1.5" />
      ))}
      {nodes.map((node) => (
        <g key={node.label}>
          <rect
            x={node.x - 46}
            y={node.y - 14}
            width="92"
            height="28"
            rx="6"
            fill={node.isRoot ? '#4c0519' : '#1e1b4b'}
            stroke={node.isRoot ? '#f43f5e' : '#818cf8'}
            strokeWidth="1.5"
          />
          <text x={node.x} y={node.y + 4} textAnchor="middle" fontSize="11" fill="#f1f5f9">
            {node.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default function LandingPage() {
  const session = useAuthStore((state) => state.session);

  return (
    <div className="min-h-full bg-slate-950 text-slate-100">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <span className="text-lg font-semibold text-indigo-200">Ripplemap</span>
        <nav className="flex items-center gap-4 text-sm">
          <Link to="/demo" className="text-indigo-300 hover:text-indigo-200">
            Demo
          </Link>
          {session ? (
            <Link to="/projects" className={`${primaryButtonClass} !px-3 !py-1`}>
              Open dashboard
            </Link>
          ) : (
            <>
              <Link to="/login" className="text-indigo-300 hover:text-indigo-200">
                Sign in
              </Link>
              <Link to="/register" className={`${primaryButtonClass} !px-3 !py-1`}>
                Get started
              </Link>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-5xl items-center gap-10 px-4 py-14 md:grid-cols-2 md:py-20">
          <div>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
              A guided tour of your cloud, including the outage before it happens.
            </h1>
            <p className="mt-5 text-lg text-slate-300">
              Ripplemap links your code to your Terraform and walks you through how requests really flow. Then it lets you
              pull the plug on a resource and watch what ripples out, or preview a change before you apply it.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/demo" className={primaryButtonClass}>
                Take the demo tour
              </Link>
              <Link to={session ? '/projects' : '/register'} className={secondaryButtonClass}>
                {session ? 'Your projects' : 'Link your repo'}
              </Link>
            </div>
            <p className="mt-4 text-sm text-slate-500">No account needed for the demo.</p>
          </div>
          <div className="flex justify-center">
            <RippleIllustration />
          </div>
        </section>

        <section className="border-y border-indigo-900 bg-indigo-950/30">
          <div className="mx-auto max-w-5xl px-4 py-14">
            <h2 className="text-2xl font-semibold">How it works</h2>
            <ol className="mt-8 grid gap-6 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="rounded-lg border border-indigo-900 bg-slate-950 p-5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-600 text-sm font-medium text-white">
                    {index + 1}
                  </span>
                  <h3 className="mt-3 font-medium text-indigo-100">{step.title}</h3>
                  <p className="mt-2 text-sm text-slate-400">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-4 py-14">
          <h2 className="text-2xl font-semibold">Four ways to take the tour</h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {TOURS.map((tour) => (
              <div key={tour.name} className="rounded-lg border border-indigo-900 bg-indigo-950/40 p-5">
                <h3 className={`font-medium ${tour.accent}`}>{tour.name}</h3>
                <p className="mt-2 text-sm text-slate-400">{tour.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 text-slate-300">
            Interrupt any time with a question. The guide answers from your graph, then picks the tour back up. Choose a
            calm docent or an overexcited guide.
          </p>
        </section>

        <section className="border-t border-indigo-900 bg-indigo-950/30">
          <div className="mx-auto max-w-5xl px-4 py-14">
            <h2 className="text-2xl font-semibold">Built to be trusted</h2>
            <div className="mt-8 grid gap-6 md:grid-cols-3">
              {PROMISES.map((promise) => (
                <div key={promise.title}>
                  <h3 className="font-medium text-indigo-100">{promise.title}</h3>
                  <p className="mt-2 text-sm text-slate-400">{promise.body}</p>
                </div>
              ))}
            </div>
            <p className="mt-6 text-sm text-slate-500">
              For now: Terraform and AWS only; Python and JavaScript or TypeScript code.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-4 py-16 text-center">
          <h2 className="text-3xl font-semibold">See your system before it surprises you.</h2>
          <div className="mt-6 flex justify-center gap-3">
            <Link to="/demo" className={primaryButtonClass}>
              Take the demo tour
            </Link>
            {!session && (
              <Link to="/login" className={secondaryButtonClass}>
                Sign in
              </Link>
            )}
          </div>
        </section>
      </main>

      <footer className="border-t border-indigo-900 px-4 py-6 text-center text-sm text-slate-500">
        Ripplemap · ripplemap.wiki
      </footer>
    </div>
  );
}
