/**
 * Heuristic: does this shell string look like a network fetch or opening a URL?
 * Not a sandbox — models can still smuggle requests through interpreters. The
 * point is to bounce obvious curl/wget/open so the gamer uses gamer_* tools.
 */

const NETWORK_OR_URL_PATTERNS = [
  /\b(?:curl|wget|aria2c|httpie)\b/i,
  /\bcurl\.exe\b/i,
  /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i,
  // httpie CLI is often invoked as `http` / `https` plus a method or URL
  /(?:^|[\s;&|])(?:http|https)\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i,
  /(?:^|[\s;&|])(?:http|https)\s+https?:\/\//i,
  /\b(?:xdg-open|sensible-browser|x-www-browser|gnome-open)\b/i,
  // macOS `open` with a URL (avoid blocking `open file.txt` without a scheme)
  /\bopen\b[^\n]*https?:\/\//i,
  /\bStart-Process\b[^\n]*https?:\/\//i,
  /https?:\/\//i,
  /\b(?:python3?|node|perl|ruby|php)(?:\s+\S+)*\s+-[ce]\b[^\n]*(?:urllib|requests|http\.client|fetch\s*\(|https?:\/\/)/i,
  /\bfetch\b[^\n]*https?:\/\//i,
]

/** True when a bash/pwsh `command` string looks like network fetch or URL open. */
export function looksLikeNetworkOrUrlCommand(command: string): boolean {
  const text = command.trim()
  if (text === '') return false
  return NETWORK_OR_URL_PATTERNS.some((pattern) => pattern.test(text))
}
