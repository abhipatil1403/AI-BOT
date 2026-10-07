# AI Quick Answer

A Windows tray assistant and Chromium Manifest V3 extension. Select text, press **Ctrl+C**, then **Ctrl+V**. Normal paste continues; the companion also reads the clipboard and requests an AI answer. Nothing runs automatically on copy alone.

- MCQs show the selected option for five seconds by default.
- Descriptive answers remain behind a small dot until hovered or focused.
- Code uses the configured language and includes a **Copy code** button that copies the raw snippet.

## Install and run

Requires Windows 10/11 and Node.js 22.12 or newer for development.

```sh
npm install
npm run dev
```

The first launch opens Settings. Closing Settings leaves the assistant in the system tray. Double-click its tray icon to reopen Settings; use **Quit** to exit.

For a packaged desktop installation, run `npm run package`, then open `release/AI Quick Answer Setup 1.0.0.exe`. The portable EXE is also produced in `release/`. These builds are unsigned: Windows may display a publisher warning. Signing requires your own code-signing certificate and is not included.

## Providers

**Groq:** Obtain an API key from [Groq Console](https://console.groq.com/keys). Select Groq, enter the key, validate the connection, and save the credential. Requests use Groq's HTTPS chat-completions API with `llama-3.3-70b-versatile` and JSON output.

**Gemini Web:** Select Gemini Web and explicitly supply cookie JSON from your own signed-in Gemini session. Accepted formats are a name/value object or an array of cookie objects (`name`, `value`, optional `domain`). The JSON must contain `__Secure-1PSID`; supply other relevant Google session cookies as needed. Validate, then save. The app never opens browser cookie databases, extracts browser cookies, or obtains your initial session automatically. Session responses may update cookies in memory only. Re-enter cookies if the session expires.

Gemini Web uses an **unofficial, changeable web protocol**, with temporary-chat requests. Google may expire sessions, restrict access, or change the request format. It is not Google's supported Gemini Developer API. Protocol failures produce a small error and do not fall back to another provider or unauthenticated access. The adapter's wire format was checked against the [upstream Gemini web client](https://github.com/Expert-Vision-Software/gemini-web-sdk).

Provider validation checks authentication and never sends clipboard text. Keys and cookies are not returned to either renderer or extension after saving. Switch providers in the shared desktop Settings.

## Chromium extension

1. Run `npm run build` and start the desktop companion.
2. Open `chrome://extensions` (or `edge://extensions`), enable Developer mode, and choose **Load unpacked**.
3. Select `dist/extension`.
4. Open desktop Settings → **Extension pairing & diagnostics**. Select the displayed pairing token manually.
5. Enter that token in the extension's **Pair extension** screen and choose **Save & connect**.
6. Reload website tabs that were open before the extension was loaded.

The extension uses the same provider, language, display duration, shortcut, position, and privacy settings as the desktop app. Its settings button opens desktop Settings. It does not store provider credentials. Its browser command defaults to **Ctrl+Shift+Y**, configurable at `chrome://extensions/shortcuts`; Chromium reserves ordinary paste, so the desktop listener supplies global **Ctrl+V**. The popup also has **Answer clipboard**.

The extension works on ordinary HTTP/HTTPS pages. Chromium internal pages, the web store, restricted pages and PDF viewers may block content scripts; use the desktop widget there. On websites, both widgets may be visible, each with the same answer. Browser answers are contained in an extension-origin iframe, rather than inserted as text in the webpage's DOM.

## Settings and privacy

- Shortcut: `Ctrl+V` by default; accepts `Ctrl+[Alt+][Shift+]` plus a letter, digit, or F1–F12. A passive OS keyboard listener recognizes only the configured combination and ignores key repeat. It never suppresses or synthesizes normal paste in production.
- Code language: Python, C, C++, Java, JavaScript, TypeScript, Go.
- MCQ duration: 2, 3, 5, 10, 15 seconds or until the next trigger. No timers apply to descriptive/code answers.
- MCQ explanations and code comments are optional and disabled by default.
- Visibility: always show, minimized, or hide while sharing. Minimized answers require hover/focus. The dot can be focused or clicked; Escape collapses it.
- Position: any screen corner, using the display nearest the pointer for desktop positioning.

**Screen sharing is user-controlled:** choose **Hide assistant window while screen sharing**, then enable **Screen sharing is active** in Settings or the tray before sharing. The app calls ordinary window hiding and removes the browser frame from display. It does not auto-detect other apps' sharing sessions or change recording APIs, display affinity, or monitoring behavior. Settings and other apps remain normal visible windows. Stop sharing mode yourself when done.

The clipboard is read only on the configured shortcut or an explicit Answer clipboard action. Empty/non-text contents do nothing. Text is normalized, bounded to 20,000 characters and sent only to the selected provider over HTTPS. The clipboard is changed only by **Copy code**. Never trigger with secrets or private material you do not want that provider to receive.

Answers/questions are kept in memory only and replaced by the next valid request or settings change. There is no local history or content cache. Provider retention policies still apply. Code is treated as text and is never executed. All model responses pass strict JSON/type/language/option validation; invalid output gets one controlled format retry.

Windows credentials and the desktop pairing token are encrypted using Electron `safeStorage` (Windows DPAPI) in the app's user-data directory. Encryption protects against other Windows users; it does not defend against malicious processes running as your own Windows account. Saving fails if secure storage is unavailable. Non-sensitive settings are saved separately. The extension pairing token is stored in trusted extension-local storage; it authenticates access to clipboard triggers and answers, so keep it private. Rotating it in desktop Settings disconnects existing extension pairings.

The bridge binds only `127.0.0.1:47831`, checks its Host header, authenticates each request, rejects website Origins and never returns credentials. It provides no remote provider/settings-write APIs. Both clients route code copying through the desktop so Windows browser newline conversion cannot alter the raw snippet. The extension sends only the current answer ID; arbitrary clipboard text and stale copies are rejected. The extension worker never accepts clipboard text from a webpage. The desktop renderers use sandboxing, context isolation, a narrow validated IPC bridge and a restrictive content security policy. Rendered answers use text nodes, never HTML.

## Architecture

```text
apps/desktop       Electron main, tray, passive hotkey, DPAPI vault, loopback bridge
apps/extension     MV3 worker, iframe widget, popup, pairing options
packages/core      Sanitizer → classifier → prompts → parser/validator
packages/providers GroqProvider / GeminiWebProvider behind AIProvider
packages/protocol  Shared API types and connection constants
packages/schemas   Strict configuration, cookie, answer and state validation
packages/ui        Shared widget, timers, hover/focus and copy behavior
tests              Unit, integration, provider and widget tests
scripts            Build and Electron/Chromium smoke checks
```

Requests reuse fetch connection pools and provider instances. Provider/session initialization is reused where possible. Network retries are bounded to one for transient failures or short rate limits; long rate limits fail promptly. HTTP attempts time out after 30 seconds and the entire answer pipeline after 65 seconds. New requests cancel older ones and cannot display stale results.

## Development and verification

```sh
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run build
npm run test:e2e
npm run package
```

`npm run check` runs lint, types, unit/integration/widget tests and both builds. `npm run test:e2e` launches actual Electron and Chromium, exercises OS clipboard/paste, secure storage, provider switching, all answer modes, copy, sharing visibility, and authenticated extension communication. It uses synthetic provider HTTP fixtures installed by the test runner, never production mock branches. It runs in isolated temporary app/browser profiles and requires an interactive Windows session and Playwright Chromium (`npx playwright install chromium`). Fixture tests establish client behavior; authenticated live Groq and Gemini operation must be verified locally with your own credentials. Never put credentials into test files, Git, or logs.

`npm run package` emits an NSIS installer and portable Windows EXE. The keyboard listener ships a prebuilt N-API binary, so packaging deliberately skips native rebuilding and needs no Visual Studio installation. `dist/extension` is the production extension folder. Build artifacts, user data, `.env`, cookie files, and credentials are excluded from Git. Push source changes to `main` with conventional commits.

## Troubleshooting

- **Desktop companion is not running:** start it and inspect the tray. Check the bridge diagnostics; another process may own port 47831.
- **Pairing invalid:** enter the current desktop token again, especially after a token rotation.
- **No response to Ctrl+V:** confirm text is copied, the tray app is running and the passive listener diagnostics report active. Shortcuts are ignored while desktop Settings has focus so pasting credentials there is safe. Some elevated/secure Windows surfaces restrict hooks; use the tray/popup action. Check that sharing mode isn't hiding the widget.
- **Groq key invalid / rate limit:** validate your saved key, check your account quota, and retry later.
- **Gemini session expired / web protocol unavailable:** explicitly replace your own session cookies and validate. If Google has changed its protocol, an adapter update may be required; Groq remains an independent option.
- **Invalid AI response:** a strict retry is attempted once. Try a clearer question if the model still returns malformed data.
- **Extension dot missing:** reload the page after installing the extension and use a regular HTTP/HTTPS page. Privacy mode intentionally hides it while sharing is active.
- **Secure storage unavailable:** run under a normal Windows user session and resave the credential if your Windows profile has changed.

Diagnostics expose status/version/error categories only, never clipboard text, responses or credentials. DeveloperTools are disabled for packaged app renderers. For development, use the tests to reproduce transport failures with synthetic fixtures.
