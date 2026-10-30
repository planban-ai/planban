/** The real Planban wordmark, on every web screen (approved mockup section 6). */
export function Wordmark({ height = 20 }: { height?: number }) {
  return (
    <picture className="web-wordmark">
      <source srcSet="/assets/planban-logo-wordmark-white.svg" media="(prefers-color-scheme: dark)" />
      <img src="/assets/planban-logo-wordmark-black.svg" alt="Planban" style={{ height }} />
    </picture>
  );
}

/** The Planban card stack on its own (board header, owner decision 16 October 2026). */
export function CardStackMark({ width = 30 }: { width?: number }) {
  return (
    <picture className="card-stack-mark">
      <source srcSet="/assets/card-stack-white.svg" media="(prefers-color-scheme: dark)" />
      <img src="/assets/card-stack-black.svg" alt="" style={{ width, height: "auto" }} />
    </picture>
  );
}
