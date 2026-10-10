import type { SVGProps } from "react";

export function LegalTraceIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & {
  name: "briefcase" | "home" | "plus" | "collapse" | "search";
}) {
  const shapes = {
    briefcase: (
      <>
        <rect x="3" y="7" width="18" height="14" rx="2" />
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12a22 22 0 0 0 18 0M12 11v3" />
      </>
    ),
    home: <path d="m3 10 9-7 9 7v11h-6v-7H9v7H3z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    collapse: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 3v18" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
  };
  return (
    <svg
      className="lt-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {shapes[name]}
    </svg>
  );
}
