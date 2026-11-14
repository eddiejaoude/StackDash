/**
 * The words "Achievement earned" beside an achievement's own title in the timeline (#413). A label
 * rather than a title prefix keeps fun titles readable, and the words, not the color, carry it.
 */
export function AchievementEarnedLabel() {
  return (
    <span className="whitespace-nowrap rounded-full border border-success px-2 py-0.5 text-xs font-medium text-success">
      Achievement earned
    </span>
  );
}
