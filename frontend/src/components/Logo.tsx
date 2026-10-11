interface LogoProps {
  /** Height and width in pixels. */
  size?: number;
  className?: string;
}

/** The Ripplemap mark (public/favicon.svg, also the browser tab icon). Decorative: the word next to it names the app. */
export default function Logo({ size = 28, className }: LogoProps) {
  return <img src="/favicon.svg" width={size} height={size} alt="" aria-hidden="true" className={className} />;
}
