import { describe, expect, it } from "vitest";

import { attachmentRefusalMessage, checkAttachment, displayFilename, formatMegabytes, sniffImageType } from "./attachments";
import { MAX_ATTACHMENT_BYTES } from "./limits";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const GIF = text("GIF89a\u0001\u0000");
const WEBP = text("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");

describe("sniffImageType", () => {
  it.each([
    ["PNG", PNG, "image/png"],
    ["JPEG", JPEG, "image/jpeg"],
    ["GIF89a", GIF, "image/gif"],
    ["GIF87a", text("GIF87a"), "image/gif"],
    ["WebP", WEBP, "image/webp"],
  ])("recognizes %s by its signature", (_title, head, mime) => {
    expect(sniffImageType(head)).toBe(mime);
  });

  it.each([
    ["an SVG", text('<svg xmlns="http://www.w3.org/2000/svg">')],
    ["a RIFF file that is not WebP (a WAV)", text("RIFF\u0000\u0000\u0000\u0000WAVEfmt ")],
    ["a PNG signature cut short", PNG.subarray(0, 7)],
    ["an empty file", bytes()],
    ["a PDF", text("%PDF-1.7")],
  ])("recognizes nothing in %s", (_title, head) => {
    expect(sniffImageType(head)).toBeNull();
  });
});

describe("checkAttachment", () => {
  const file = (name: string, size: number, type = "") => ({ name, size, type });

  it("admits a PNG by its bytes, whatever its name or reported type say", () => {
    expect(checkAttachment(file("notes.txt", 1024, "text/plain"), PNG)).toEqual({ ok: true, mime: "image/png" });
  });

  it.each([
    ["an SVG reported as one", file("logo.png", 100, "image/svg+xml"), text("<svg>")],
    ["an SVG by its extension", file("logo.svg", 100), text("<svg>")],
    ["an SVG that only says so in its bytes, behind a byte order mark", file("logo", 100), bytes(0xef, 0xbb, 0xbf, 0x20, 0x3c, 0x73)],
  ])("refuses %s, saying it is an SVG", (_title, facts, head) => {
    expect(checkAttachment(facts, head)).toEqual({ ok: false, refusal: "svg" });
  });

  it("refuses a file named .png whose bytes are not an image", () => {
    expect(checkAttachment(file("screen.png", 100, "image/png"), text("%PDF-1.7"))).toEqual({ ok: false, refusal: "type" });
  });

  it.each([
    ["an empty file", 0, "empty"],
    ["one byte over 10 MiB", MAX_ATTACHMENT_BYTES + 1, "too_large"],
  ])("refuses %s before reading its type", (_title, size, refusal) => {
    expect(checkAttachment(file("screen.png", size), PNG)).toEqual({ ok: false, refusal });
  });

  it("admits a PNG of exactly 10 MiB", () => {
    expect(checkAttachment(file("screen.png", MAX_ATTACHMENT_BYTES), PNG)).toEqual({ ok: true, mime: "image/png" });
  });
});

describe("displayFilename", () => {
  it.each([
    ["a plain name", "screen.png", "screen.png"],
    ["a path, which never names a file here", "../../evil.svg", "evil.svg"],
    ["a Windows path", "C:\\Users\\me\\shot.png", "shot.png"],
    ["control characters", "shot\u0000\u0007.png", "shot.png"],
    ["nothing left", "  /  ", "image"],
  ])("shows %s as text", (_title, name, expected) => {
    expect(displayFilename(name)).toBe(expected);
  });

  it("cuts a very long name to 255 characters, counting an emoji once", () => {
    const shown = displayFilename(`${"😀".repeat(300)}.png`);
    expect([...shown]).toHaveLength(255);
  });
});

describe("attachmentRefusalMessage", () => {
  it("says why an SVG is refused and what to attach instead", () => {
    expect(attachmentRefusalMessage("svg", { name: "logo.svg", size: 10 })).toBe(
      "logo.svg is an SVG image, which can carry scripts, so it cannot be attached. Attach a PNG, JPEG, GIF, or WebP image instead.",
    );
  });

  it("names the size and the limit for an oversized file", () => {
    expect(attachmentRefusalMessage("too_large", { name: "big.png", size: 12.4 * 1024 * 1024 })).toBe(
      "big.png is 12 MB, over the 10 MB limit for an image. Attach a smaller image.",
    );
  });

  it("never uses a dash, in any refusal", () => {
    const refusals = ["svg", "type", "empty", "too_large", "count", "staged_cap", "thread", "upload", "unreadable"] as const;
    for (const refusal of refusals) expect(attachmentRefusalMessage(refusal, { name: "a.png", size: 1 })).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("formatMegabytes", () => {
  it.each([
    [512 * 1024, "0.5 MB"],
    [1024 * 1024, "1 MB"],
    [9.96 * 1024 * 1024, "10 MB"],
    [10 * 1024 * 1024, "10 MB"],
  ])("%s bytes is %s", (size, label) => {
    expect(formatMegabytes(size)).toBe(label);
  });
});
