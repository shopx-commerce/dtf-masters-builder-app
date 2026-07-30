/** Product card icons - t-shirt for garment transfers, sticker for UV decals */

import { Shirt } from "lucide-react";

/** Custom panda SVG - Lucide Panda added in 0.507+, project uses 0.453 */
function PandaIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="6" cy="7" r="3" />
      <circle cx="18" cy="7" r="3" />
      <circle cx="9" cy="11" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="15" cy="11" r="1.5" fill="currentColor" stroke="none" />
      <path d="M9 15c1 0.5 2 0.5 3 0.5s2 0 3-0.5" />
    </svg>
  );
}

export function IconHotPeel({ className = "w-8 h-8" }: { className?: string }) {
  return <Shirt className={className} strokeWidth={2} />;
}

export function IconFluorescent({ className = "w-8 h-8" }: { className?: string }) {
  return <Shirt className={className} strokeWidth={2} />;
}

export function IconUvDtf({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <span className={`relative inline-flex items-center justify-center rounded-xl border-2 border-current shadow-sm ${className}`}>
      <PandaIcon className="w-[55%] h-[55%]" />
    </span>
  );
}

export function IconSpecialtyColdPeel({ className = "w-8 h-8" }: { className?: string }) {
  return <Shirt className={className} strokeWidth={2} />;
}
