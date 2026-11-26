"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

import type { AccountProfile } from "@/lib/account/profile";

/**
 * The signed-in user's avatar and name, linking to the Account page (#175), so someone with more
 * than one GitHub account can see which one is active. The name is the link's text and the avatar
 * is decorative. Below `md` only the avatar shows; the name stays in the link's accessible name.
 * From `sm` the role badge and the live label already take the room, so a name at its 160 px cap
 * would leave the workspace switcher no room for its own name (#366).
 *
 * The fallback person icon sits under the avatar, so a missing, slow, or failed avatar never shows
 * a broken image. next/image replays an error that happened before hydration to `onError`.
 */
export function AccountLink({ profile }: { profile: AccountProfile }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const avatarUrl = profile.avatarUrl !== failedUrl ? profile.avatarUrl : null;

  return (
    <Link
      href="/account"
      className="inline-flex min-h-9 min-w-0 items-center gap-2 rounded-md px-1 py-1 text-sm text-muted transition-colors hover:text-foreground sm:px-2"
    >
      <span aria-hidden="true" className="relative inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line-strong bg-panel-raised">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          data-testid="account-avatar-fallback"
        >
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
        {avatarUrl !== null ? (
          // Served as-is: GitHub already resizes on `s` (src/lib/account/profile.ts), and the app
          // CSP allows its host, so optimizing would only add a metered transformation per user.
          <Image
            src={avatarUrl}
            alt=""
            width={28}
            height={28}
            unoptimized
            loading="eager"
            onError={() => setFailedUrl(avatarUrl)}
            className="absolute inset-0 size-full object-cover"
            data-testid="account-avatar"
          />
        ) : null}
      </span>
      {profile.name !== null ? (
        <>
          <span className="sr-only">Account: </span>
          <span className="sr-only md:not-sr-only">
            <span className="block max-w-40 truncate">{profile.name}</span>
          </span>
        </>
      ) : (
        <span className="sr-only md:not-sr-only">Account</span>
      )}
    </Link>
  );
}
