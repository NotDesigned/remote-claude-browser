/**
 * What sets one browser account apart from another on the same machine.
 *
 * Each account draws a screen size, a set of installed fonts and a way of rendering them from a
 * seed of its own. These are real differences in the environment, not noise added to canvas or
 * audio reads, which detectors recognise as tampering. The seed is derived from the account id,
 * so an account keeps its identity across restarts.
 */
import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface BrowserIdentity {
  screen: { width: number; height: number };
  /** Optional font families this account does not have. */
  missingFonts: string[];
  rendering: { hintstyle: string; antialias: boolean; autohint: boolean };
}

/** Common desktop screens, in CSS pixels. */
const SCREENS = [
  [1920, 1080],
  [2560, 1440],
  [1536, 864],
  [1680, 1050],
  [1440, 900],
  [1920, 1200],
  [1600, 900],
  [2560, 1600],
] as const;

/** Installed families an ordinary Linux desktop may or may not have. Core families stay. */
export const OPTIONAL_FONTS = [
  "Roboto",
  "Open Sans",
  "Lato",
  "Cantarell",
  "Carlito",
  "Caladea",
  "Arimo",
  "Tinos",
  "Cousine",
  "FreeSans",
  "FreeSerif",
  "FreeMono",
  "WenQuanYi Micro Hei",
  "WenQuanYi Zen Hei",
  "AR PL UKai CN",
  "AR PL UMing CN",
  "Hack",
  "Fira Code",
  "Inconsolata",
  "Linux Libertine O",
  "Linux Biolinum O",
  "Oxygen",
  "STIX Two Text",
  "Droid Sans Fallback",
  "Noto Sans Mono",
  "Noto Serif",
  "URW Bookman",
  "URW Gothic",
  "Nimbus Sans",
  "Nimbus Roman",
  "C059",
  "P052",
  "Z003",
] as const;

const RENDERINGS = [
  { hintstyle: "hintslight", antialias: true, autohint: false },
  { hintstyle: "hintfull", antialias: true, autohint: false },
  { hintstyle: "hintmedium", antialias: true, autohint: true },
  { hintstyle: "hintnone", antialias: true, autohint: false },
  { hintstyle: "hintslight", antialias: true, autohint: true },
] as const;

export function browserIdentity(secret: string, accountId: string): BrowserIdentity {
  // A deterministic stream of bytes: HMAC(secret, id || counter).
  let counter = 0;
  let pool = Buffer.alloc(0);
  const next = (): number => {
    if (pool.length < 4) {
      pool = createHmac("sha256", secret).update(`${accountId}\0${counter++}`).digest();
    }
    const value = pool.readUInt32BE(0) / 2 ** 32;
    pool = pool.subarray(4);
    return value;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const [width, height] = pick(SCREENS);
  return {
    screen: { width, height },
    missingFonts: OPTIONAL_FONTS.filter(() => next() < 0.45),
    rendering: { ...pick(RENDERINGS) },
  };
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function fontconfigFor(identity: BrowserIdentity): string {
  const { hintstyle, antialias, autohint } = identity.rendering;
  const rejected = identity.missingFonts
    .map(
      (family) =>
        `      <pattern><patelt name="family"><string>${xml(family)}</string></patelt></pattern>`,
    )
    .join("\n");
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <selectfont>
    <rejectfont>
${rejected}
    </rejectfont>
  </selectfont>
  <match target="font">
    <edit name="antialias" mode="assign"><bool>${antialias}</bool></edit>
    <edit name="hinting" mode="assign"><bool>${hintstyle !== "hintnone"}</bool></edit>
    <edit name="hintstyle" mode="assign"><const>${hintstyle}</const></edit>
    <edit name="autohint" mode="assign"><bool>${autohint}</bool></edit>
  </match>
</fontconfig>
`;
}

/** Writes this account's fontconfig into its profile and returns the environment that uses it. */
export async function identityEnvironment(
  dir: string,
  identity: BrowserIdentity,
): Promise<Record<string, string>> {
  const file = join(dir, "fonts.conf");
  await writeFile(file, fontconfigFor(identity), { mode: 0o600 });
  return { FONTCONFIG_FILE: file };
}
