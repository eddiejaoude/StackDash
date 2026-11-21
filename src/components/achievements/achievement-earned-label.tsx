/**
 * The words "Achievement earned" beside an achievement's own title in the timeline (#413). A label
 * rather than a title prefix keeps fun titles readable, and the words, not the color, carry it.
 * `emoji` (🏆) leads the words where the label is the event's only pill, as in the event details
 * (#596); it is decorative, because the words say the same.
 */
export function AchievementEarnedLabel({ emoji }: { emoji?: string } = {}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-gold/50 bg-gold-soft px-2 py-0.5 text-xs font-medium text-gold">
      {emoji === undefined ? null : <span aria-hidden="true" className="leading-none">{emoji}</span>}
      <span>Achievement earned</span>
    </span>
  );
}
