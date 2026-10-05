// A short, human description of a session's device for the "Active devices" list ("Chrome on Windows"), parsed
// from the user agent we already store (domain-implementation-plan.md §0.5.E). Deliberately tiny and forgiving:
// it exists so a person can recognise their own devices, not to fingerprint anyone — and it is only ever
// rendered as TEXT. The order matters (Edge and Opera also say "Chrome"; Chrome also says "Safari").

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(Firefox|FxiOS)\//, "Firefox"],
  [/\b(Chrome|CriOS|HeadlessChrome|Chromium)\//, "Chrome"],
  [/\bSafari\//, "Safari"],
  [/^curl\//, "curl"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b|\bX11\b/, "Linux"],
];

export function describeUserAgent(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").slice(0, 255);
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}
