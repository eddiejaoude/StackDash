// The export makes this file a module, so the block below augments React's types instead of
// replacing the "react" module with an ambient declaration.
export {};

// Lets the motion inputs in globals.css travel as typed inline custom properties instead of a cast:
// the count-up range, the usage bar's starting scale, an arriving event's edge color (#171), and
// where a hero data-flow packet parks under reduced motion.
declare module "react" {
  interface CSSProperties {
    "--count-to"?: number;
    "--count-from"?: number;
    "--bar-from"?: number;
    "--flash"?: string;
    "--park"?: string;
  }
}
