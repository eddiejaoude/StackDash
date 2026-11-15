import { GitHubIcon } from "@/components/icons";
import { site } from "@/lib/site";

const SIZE_CLASSES = {
  sm: "gap-2 rounded-md px-3.5 py-2",
  md: "gap-2.5 rounded-lg px-5 py-3",
  lg: "gap-2.5 rounded-lg px-6 py-3.5",
} as const;

interface GitHubButtonProps {
  size?: keyof typeof SIZE_CLASSES;
  /** Below sm, show only the mark; the label stays as the link's accessible name. */
  iconOnlyOnPhone?: boolean;
}

/** The page's one call to action: follow the build on GitHub. */
export function GitHubButton({ size = "md", iconOnlyOnPhone = false }: GitHubButtonProps) {
  return (
    <a
      href={site.githubUrl}
      className={`inline-flex items-center bg-accent text-sm font-medium text-background transition-opacity hover:opacity-85 ${SIZE_CLASSES[size]}`}
    >
      <GitHubIcon />
      <span className={iconOnlyOnPhone ? "sr-only sm:not-sr-only" : undefined}>Follow on GitHub</span>
    </a>
  );
}
