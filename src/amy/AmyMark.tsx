/** Animated A.M.Y holo-globe mark used in the header. Decorative. */
export function AmyMark({ size = 40 }: { size?: number }) {
  return (
    <svg className="amy-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="22" fill="none" stroke="rgba(73,201,255,.3)" strokeWidth="1" />
      <g className="amy-mark-orbit a">
        <ellipse cx="32" cy="32" rx="24" ry="8" fill="none" stroke="#5eead4" strokeWidth="2" />
      </g>
      <g className="amy-mark-orbit b">
        <ellipse cx="32" cy="32" rx="24" ry="8" fill="none" stroke="#b69cff" strokeWidth="2" />
      </g>
      <circle className="amy-mark-core" cx="32" cy="32" r="7" fill="#e9fffb" />
    </svg>
  );
}
