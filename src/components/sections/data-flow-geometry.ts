// The hero data-flow stage is drawn at 700 by 520 and scaled to its container (.flow-stage in
// globals.css). offset-path coordinates are stage pixels, so every position is too. A plain
// module, not the client one, so the server component that places the nodes reads real values.
export const CENTER = { x: 350, y: 260 } as const;
export const ORBIT = { rx: 270, ry: 200 } as const;
export const INNER_ORBIT = { rx: 150, ry: 110 } as const;
