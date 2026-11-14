import Image from "next/image";

import { site } from "@/lib/site";

interface WordmarkProps {
  loading?: "eager" | "lazy";
  size?: "compact" | "site";
}

// The artwork is cropped to its bounds, so at h-5 the letters match 14 px text. The public site
// steps down to h-5 below sm so the phone header keeps the logo, Sign in, and GitHub on one row.
const sizeClasses: Record<NonNullable<WordmarkProps["size"]>, string> = {
  compact: "h-5 w-auto sm:h-6",
  site: "h-5 w-auto sm:h-7",
};

/** The official StackDash wordmark, sized for compact app chrome or the public site. */
export function Wordmark({ loading = "eager", size = "compact" }: WordmarkProps) {
  return (
    <Image
      src="/brand/stackdash-logo-dark-no-tagline.svg"
      alt={site.name}
      width={377}
      height={76}
      className={sizeClasses[size]}
      loading={loading}
      unoptimized
    />
  );
}
