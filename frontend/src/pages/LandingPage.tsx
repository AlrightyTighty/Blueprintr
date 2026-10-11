import { Link } from 'react-router-dom';
import GlowCard, { GLOW } from '../components/GlowCard';
import Logo from '../components/Logo';
import ParticleField from '../components/ParticleField';
import { primaryButtonClass, secondaryButtonClass } from '../components/ui';
import { useAuthStore } from '../features/auth/useAuthStore';

const BENEFITS = [
  {
    audience: 'New hires',
    body: 'Skip weeks of asking around. See how a real request travels through the code and the cloud on your first day.',
  },
  {
    audience: 'Small teams',
    body: 'The system lives in a few heads. Ripplemap writes it down as a tour anyone can take, and keeps it true to the repo.',
  },
  {
    audience: 'Reviewers and on-call',
    body: 'Before you apply a Terraform plan, see exactly which functions and permissions it touches, and what breaks if a resource goes down.',
  },
  {
    audience: 'Students and open-source contributors',
    body: 'Learn how a real cloud project fits together, with the code next to the infrastructure that runs it.',
  },
];

const STEPS = [
  {
    title: 'Link a repo',
    body: 'Paste a link to any public GitHub repository, no GitHub login needed (connect GitHub only for private ones). It reads the Terraform and the Python or JavaScript, and never runs either.',
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
    glow: GLOW.blue,
  },
  {
    name: 'Follow a request',
    body: 'Pick one journey and ride it end to end, from the API to where the data ends up.',
    accent: 'text-indigo-300',
    glow: GLOW.indigo,
  },
  {
    name: 'Disaster tour',
    body: 'Pull the plug on a resource and watch the failure spread, narrated by a guide who stays entirely calm.',
    accent: 'text-rose-300',
    glow: GLOW.rose,
  },
  {
    name: 'Change tour',
    body: 'Paste a Terraform plan and see what the change touches before you apply it, including the code that depends on it.',
    accent: 'text-amber-300',
    glow: GLOW.amber,
  },
];

const PROMISES = [
  {
    title: 'Static analysis only',
    body: 'We read files. We never run terraform apply or any code from your repo.',
  },
  {
    title: 'Honest about guesses',
    body: 'Inferred links are labelled in the graph and out loud on the tour. Humans review every conclusion.',
  },
  {
    title: 'The guide never invents',
    body: 'It only talks about things that exist in your graph, and points to the file and line.',
  },
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
    <svg
      viewBox="0 0 400 290"
      role="img"
      aria-label="A failure rippling outward through connected cloud resources"
      className="w-full max-w-md"
    >
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
        <line
          key={`${from}-${to}`}
          x1={nodes[from].x}
          y1={nodes[from].y}
          x2={nodes[to].x}
          y2={nodes[to].y}
          stroke="#475a85"
          strokeWidth="1.5"
        />
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
        <Link to="/" className="flex items-center gap-2 text-lg font-semibold text-indigo-200">
          <Logo size={30} />
          Ripplemap
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link to="/demo" className="text-indigo-300 hover:text-indigo-200">
            Demo
          </Link>
          {session ? (
            <Link to="/projects" className={`${primaryButtonClass} px-3! py-1!`}>
              Open dashboard
            </Link>
          ) : (
            <>
              <Link to="/login" className="text-indigo-300 hover:text-indigo-200">
                Sign in
              </Link>
              <Link to="/register" className={`${primaryButtonClass} px-3! py-1!`}>
                Get started
              </Link>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="relative overflow-hidden">
          <ParticleField />
          <div className="relative mx-auto grid max-w-5xl items-center gap-10 px-4 py-14 md:grid-cols-2 md:py-20">
            <div>
              <h1 className="text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
                A guided tour of your cloud, including the outage before it happens.
              </h1>
              <p className="mt-5 text-lg text-slate-300">
                Ripplemap links your code to your Terraform and walks you through how requests really flow. Then it lets you pull the plug on
                a resource and watch what ripples out, or preview a change before you apply it.
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
          </div>
        </section>

        <section className="border-y border-indigo-900 bg-indigo-950/30">
          <div className="mx-auto max-w-5xl px-4 py-14">
            <h2 className="text-2xl font-semibold">Why it helps</h2>
            <p className="mt-4 max-w-3xl text-slate-300">
              Cloud systems are split in two: the code says what happens, and the Terraform says where it runs. Nobody sees both at once, so
              the answer to &ldquo;what breaks if I change this?&rdquo; lives in someone&rsquo;s memory. Ripplemap connects the two from the
              repo alone, with nothing to install and nothing run, so understanding the system stops depending on who happens to be around.
            </p>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              {BENEFITS.map((benefit) => (
                <GlowCard key={benefit.audience}>
                  <h3 className="font-medium text-indigo-100">{benefit.audience}</h3>
                  <p className="mt-2 text-sm text-slate-400">{benefit.body}</p>
                </GlowCard>
              ))}
            </div>
          </div>
        </section>

        <section>
          <div className="mx-auto max-w-5xl px-4 py-14">
            <h2 className="text-2xl font-semibold">How it works</h2>
            <ol className="mt-8 grid gap-6 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <GlowCard as="li" key={step.title}>
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-600 text-sm font-medium text-white">
                    {index + 1}
                  </span>
                  <h3 className="mt-3 font-medium text-indigo-100">{step.title}</h3>
                  <p className="mt-2 text-sm text-slate-400">{step.body}</p>
                </GlowCard>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-y border-indigo-900 bg-indigo-950/30">
          <div className="mx-auto max-w-5xl px-4 py-14">
            <h2 className="text-2xl font-semibold">Four ways to take the tour</h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              {TOURS.map((tour) => (
                <GlowCard key={tour.name} glow={tour.glow}>
                  <h3 className={`font-medium ${tour.accent}`}>{tour.name}</h3>
                  <p className="mt-2 text-sm text-slate-400">{tour.body}</p>
                </GlowCard>
              ))}
            </div>
            <p className="mt-6 text-slate-300">
              Interrupt any time with a question. The guide answers from your graph, then picks the tour back up. Choose a calm docent or an
              overexcited guide.
            </p>
          </div>
        </section>

        <section>
          <div className="mx-auto max-w-5xl px-4 py-14">
            <h2 className="text-2xl font-semibold">Built to be trusted</h2>
            <div className="mt-8 grid gap-6 md:grid-cols-3">
              {PROMISES.map((promise) => (
                <GlowCard key={promise.title} glow={GLOW.indigo}>
                  <h3 className="font-medium text-indigo-100">{promise.title}</h3>
                  <p className="mt-2 text-sm text-slate-400">{promise.body}</p>
                </GlowCard>
              ))}
            </div>
            <p className="mt-6 text-sm text-slate-500">For now: Terraform and AWS only; Python and JavaScript or TypeScript code.</p>
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

      <footer className="border-t border-indigo-900 px-4 py-6 text-center text-sm text-slate-500">© {new Date().getFullYear()} Ripplemap. All rights reserved. · ripplemap.wiki</footer>
    </div>
  );
}
