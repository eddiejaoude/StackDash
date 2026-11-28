import Image from "next/image";

/**
 * A member's avatar in the support inbox (#680), for the list (a Server Component) and the open
 * conversation (a client component) alike, so it has no directive and no handlers. Decorative: the
 * member's name is always written beside it. The person icon sits under the image, so a missing or
 * failed avatar shows the icon rather than a broken image (an empty `alt` draws nothing).
 */
export function MemberAvatar({ url, size }: { url: string | null; size: 32 | 40 }) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-line-strong bg-panel-raised text-muted ${
        size === 32 ? "size-8" : "size-10"
      }`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </svg>
      {url === null ? null : (
        // Served as-is, as the account link serves GitHub avatars: the CSP allows the host, and
        // optimizing would add a metered transformation per member.
        <Image src={url} alt="" width={size} height={size} unoptimized className="absolute inset-0 size-full object-cover" />
      )}
    </span>
  );
}
