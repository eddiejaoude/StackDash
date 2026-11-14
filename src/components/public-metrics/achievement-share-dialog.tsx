"use client";

import { ShareDialog } from "@/components/public-metrics/share-dialog";
import {
  achievementBadgeAltText,
  achievementBadgePath,
  achievementCardAltText,
  achievementCardPath,
  achievementShareLinks,
  CARD_SIZE,
  type ShareProjectPage,
} from "@/lib/public-metrics/share";

/*
 * The share dialog of a published achievement (#413), on the public project page and in the app
 * (the Achievements section and its timeline entry). The same dialog as a metric's (#149): the
 * badge with its Markdown for a README and a Copy button, the card with its URL and alt text, and
 * "Share to X" and "Share to LinkedIn", which open a prefilled post the person edits and sends.
 * Nothing is posted automatically. Render it only for a published achievement: anything else gets
 * the Unpublished badge and card.
 */

export type AchievementShareDialogProps = Readonly<{
  projectId: string;
  achievementId: string;
  publicTitle: string;
  providerName: string;
  /** Earned from the provider simulator's data (#131): every image and post says so. */
  simulated: boolean;
  /** The public origin the copied links use (`requestPublicOrigin()` on the server). */
  siteOrigin: string;
  /** The project page while it is public, else null: links then lead to the card and the site. */
  projectPage: ShareProjectPage | null;
  triggerText?: string;
}>;

export function AchievementShareDialog({
  projectId,
  achievementId,
  publicTitle,
  providerName,
  simulated,
  siteOrigin,
  projectPage,
  triggerText = "Share",
}: AchievementShareDialogProps) {
  const achievement = { publicTitle, providerName, simulated };
  const links = achievementShareLinks({ origin: siteOrigin, projectId, achievementId, achievement, projectPage });
  return (
    <ShareDialog
      title={`Share ${publicTitle}`}
      triggerText={triggerText}
      subject={publicTitle}
      // The previews load from this page's own origin, which the app's img-src 'self' allows even
      // when NEXT_PUBLIC_SITE_URL names another host; the copied links use the public origin.
      badge={{ src: achievementBadgePath(projectId, achievementId), alt: achievementBadgeAltText(achievement), markdown: links.badgeMarkdown }}
      card={{
        src: achievementCardPath(projectId, achievementId),
        alt: achievementCardAltText(achievement, projectPage?.projectName ?? null),
        ...CARD_SIZE,
        publicUrl: links.cardUrl,
      }}
      xIntentUrl={links.xIntentUrl}
      link={{ url: links.link, linkedInUrl: links.linkedInUrl }}
      notes={[
        "The badge and card show this achievement's public title, its provider, and when it was earned, and nothing else.",
        ...(simulated ? ["It was earned from simulated data, so the badge, the card, and posts say it is simulated."] : []),
        projectPage === null
          ? "Posts link to the card, and the badge to StackDash. Once the project page is on, they link to it instead."
          : `Posts and the badge link to the project page at ${projectPage.path}.`,
        "If the achievement is unpublished, the badge and card show Unpublished within a minute.",
      ]}
    />
  );
}
