/* W2R4 wordmark — bold W with superscript 2 and radical-over-4. */

const W2R4Logo = ({ size = 28, color = "currentColor", style = {}, title = "Who2Root4" }) => (
  <svg
    viewBox="0 0 74 36"
    role="img"
    aria-label={title}
    style={{ height: size, width: "auto", display: "block", overflow: "visible", flexShrink: 0, ...style }}
  >
    {/* W — drawn as a heavy stroked path so weight stays consistent across browsers/fonts */}
    <path
      d="M2 4 L9.5 32 L17.5 14 L23 14 L31 32 L38.5 4"
      fill="none"
      stroke={color}
      strokeWidth="5.6"
      strokeLinejoin="miter"
      strokeMiterlimit="3"
      strokeLinecap="butt"
    />
    {/* superscript 2 */}
    <text
      x="36"
      y="13"
      fontFamily='"Barlow Condensed", "Barlow", sans-serif'
      fontWeight="900"
      fontSize="15"
      fill={color}
      style={{ letterSpacing: 0 }}
    >2</text>
    {/* radical: short ascending hook then horizontal vinculum */}
    <path
      d="M44 17 L47.5 17 L50.5 7.5 L73 7.5"
      fill="none"
      stroke={color}
      strokeWidth="3.2"
      strokeLinejoin="miter"
      strokeMiterlimit="3"
      strokeLinecap="butt"
    />
    {/* 4 under the radical */}
    <text
      x="51"
      y="33"
      fontFamily='"Barlow Condensed", "Barlow", sans-serif'
      fontWeight="900"
      fontSize="30"
      fill={color}
      style={{ letterSpacing: 0 }}
    >4</text>
  </svg>
);

window.W2R4Logo = W2R4Logo;
