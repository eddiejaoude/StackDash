import { PlatformLogo, PuzzleIcon } from "@/components/icons";
import type { ProviderId } from "@/lib/adapters/types";
import { providerName, providerPlatform } from "@/lib/providers";
import type { Platform } from "@/lib/site";

const SIZES = {
  sm: { frame: "size-7 rounded-md", icon: "size-4" },
  md: { frame: "size-8 rounded-md", icon: "size-4" },
  lg: { frame: "size-10 rounded-lg", icon: "size-5" },
} as const;

/**
 * The app's one provider mark (#342): a brand logo in a framed square. `null` is StackDash itself
 * (its daily summaries and alerts), which has an empty frame; a provider without a brand, such as
 * the test-only fake one, gets the generic puzzle mark. `platform` marks a platform that is not a
 * provider, such as the landing page's GitHub Actions.
 *
 * `emoji` sits in the frame's bottom right corner and says what happened at a glance (🏆 an
 * achievement, 💳 a payment). It is always decorative, because a row says the same in words.
 *
 * Decorative by default, because the name is printed beside it. Set `labeled` where the mark
 * stands alone, so it is read out as an image named after the provider.
 */
export function ProviderMark({
  size = "lg",
  labeled = false,
  className = "",
  emoji,
  ...source
}: (Readonly<{ provider: ProviderId | null }> | Readonly<{ platform: Platform }>) & {
  size?: keyof typeof SIZES;
  labeled?: boolean;
  /** Placement only, such as `mt-0.5`. */
  className?: string;
  emoji?: string;
}) {
  const platform = "platform" in source ? source.platform : providerPlatform(source.provider);
  const name = "platform" in source ? source.platform : providerName(source.provider);
  const { frame, icon } = SIZES[size];
  return (
    <span
      {...(labeled ? { role: "img", "aria-label": name, title: name } : {})}
      className={`relative flex shrink-0 items-center justify-center border border-line bg-panel-raised text-foreground ${frame} ${className}`.trim()}
    >
      {platform !== null ? (
        <PlatformLogo platform={platform} className={icon} />
      ) : "provider" in source && source.provider !== null ? (
        <PuzzleIcon className={icon} />
      ) : null}
      {emoji === undefined ? null : (
        <span aria-hidden="true" className="absolute -right-1.5 -bottom-1.5 text-[11px] leading-none">
          {emoji}
        </span>
      )}
    </span>
  );
}
