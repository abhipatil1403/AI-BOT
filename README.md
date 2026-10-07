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

For a packaged desktop installation, run `npm run package`, then open `release/AI Quick Answer Setup 1.0.4.exe`. The portable EXE is also produced in `release/`. These builds are unsigned: Windows may display a publisher warning. Signing requires your own code-signing certificate and is not included.

## Providers

**Groq:** Obtain an API key from [Groq Console](https://console.groq.com/keys). Select Groq, enter the key, validate the connection, and save the credential. Requests use Groq's HTTPS chat-completions API with `openai/gpt-oss-120b`, low reasoning effort and JSON output. Validation checks the active model list as well as authentication. The old `llama-3.3-70b-versatile` model was [retired for free/developer accounts on August 16, 2026](https://console.groq.com/docs/deprecations); version 1.0.1 migrates to the supported replacement.

**Gemini Web:** Select Gemini Web and explicitly supply cookies from your own signed-in Gemini session. Accepted formats are a JSON name/value object, an exported JSON array of cookie objects (`name`, `value`, optional `domain`, other browser metadata allowed), or a single Cookie header string (`name=value; name=value`, optionally prefixed with `Cookie:`). Every format must contain `__Secure-1PSID`; supply other relevant Google session cookies as needed. Paste the complete input locally in Settings, validate, then save. Truncated JSON, duplicate header names, other HTTP headers and unsafe values are rejected. The app never opens browser cookie databases, extracts browser cookies, or obtains your initial session automatically. Session responses may update cookies in memory only. Re-enter cookies if the session expires.

Format examples below use placeholder values. Your actual session values belong only in local Settings.

```text
[{"name":"__Secure-1PSID","value":"your-session-value","domain":".google.com"}]

Cookie: __Secure-1PSID=your-session-value; __Secure-1PSIDTS=your-session-timestamp
```

Gemini Web uses an **unofficial, changeable web protocol**, with temporary-chat requests. Google may expire sessions, restrict access, or change the request format. It is not Google's supported Gemini Developer API. Protocol failures produce a small error and do not fall back to another provider or unauthenticated access. The adapter's wire format was checked against the [upstream Gemini web client](https://github.com/Expert-Vision-Software/gemini-web-sdk).

Provider validation checks authentication and never sends clipboard text. Keys and cookies are not returned to either renderer or extension after saving. Switch providers in the shared desktop Settings.

## Chromium extension

1. Run `npm run build` and start the desktop companion.
2. Open `chrome://extensions` (or `edge://extensions`), enable Developer mode, and choose **Load unpacked**.
3. Select `dist/extension` (development build) or `release/extension` (created by `npm run package`). The selected folder must directly contain `manifest.json`. **Do not select `release/win-unpacked`: that folder contains the Windows desktop app and cannot be loaded as a browser extension.**
4. Open desktop Settings → **Extension pairing & diagnostics**. Select the displayed pairing token manually.
5. Enter that token in the extension's **Pair extension** screen and choose **Save & connect**.
6. Reload website tabs that were open before the extension was loaded.

The extension uses the same provider, language, display duration, shortcut, position, and privacy settings as the desktop app. Its settings button opens desktop Settings. It does not store provider credentials. Its browser command defaults to **Ctrl+Shift+Y**, configurable at `chrome://extensions/shortcuts`; Chromium reserves ordinary paste, so the desktop listener supplies global **Ctrl+V**. The popup also has **Answer clipboard**.

The extension works on ordinary HTTP/HTTPS pages. Chromium internal pages, the web store, restricted pages and PDF viewers may block content scripts; use the desktop widget there. On websites, both widgets may be visible, each with the same answer. Browser answers are contained in an extension-origin iframe, rather than inserted as text in the webpage's DOM.

## Settings and privacy

- Shortcut: `Ctrl+V` by default; accepts `Ctrl+[Alt+][Shift+]` plus a letter, digit, or F1–F12. A passive OS keyboard listener recognizes only the configured combination and ignores key repeat. It never suppresses or synthesizes normal paste in production.
- Code language: Python, C, C++, Java, JavaScript, TypeScript, Go.
- The widget is completely hidden when idle. A 6-pixel marker appears after a question is triggered and blinks while waiting. Its transparent interaction surface is 18 × 18 pixels.
- Answer cards have a transparent background and light text, with compact widths of 166 pixels for MCQs, 226 for descriptions and 286 for code. Longer answers scroll inside the card.
- MCQ duration: 2, 3, 5, 10, 15 seconds or until the next trigger. The deadline starts when the answer arrives. Hover, focus and clicks cannot extend it or reveal an expired answer; both card and dot disappear when the deadline passes.
- No timers apply to descriptive/code answers. Hover or focus reveals them repeatedly until the next question or manual × dismissal. The × clears the current answer in both desktop and browser clients. Escape only collapses the card.
- MCQ explanations and code comments are optional and disabled by default.
- Visibility: always show, minimized, or hide while sharing. Minimized answers require hover/focus. The dot can be focused or clicked; Escape collapses it.
- Position: any screen corner, using the display nearest the pointer for desktop positioning.

**Windows capture exclusion:** version 1.0.3 enables **Exclude desktop windows from screen capture** by default, including for existing saved configurations. Both the widget and Settings window are created hidden, protected before loading/showing, and reapply protection when shown. Electron's [content protection API](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable) calls `SetWindowDisplayAffinity` with `WDA_EXCLUDEFROMCAPTURE` (0x11). Supported captures omit these windows while they remain visible on the local display. Windows 10 2004+ and Windows 11 support exclusion; older Windows can produce a black window instead. Settings diagnostics show whether Electron reports protection enabled.

**Before sharing:** keep capture exclusion enabled, choose **Always show** or **Minimized**, and enable **Screen sharing is active** in Settings or the tray. The protected desktop assistant stays visible locally when an answer is active. The browser overlay is hidden and its answer data is withheld because a Chrome iframe cannot independently use Windows display affinity. Choose **Hide assistant window while screen sharing** to hide the desktop widget too. Sharing detection is manual; turn the sharing toggle off when done. Reload the rebuilt extension (version 1.0.2) after upgrading the companion.

**Verify the actual sharing preview:** this is capture exclusion, not a universal guarantee of invisibility. Microsoft [does not guarantee protection against every capture method](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity), and Electron notes that the change takes effect on the next desktop composition. Hardware capture, cameras and capture methods that ignore affinity can still see the windows. This feature does not conceal the process in Task Manager or protect other applications.

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

`npm run check` runs lint, types, unit/integration/widget tests and both builds. `npm run test:e2e` launches actual Electron and Chromium, exercises OS clipboard/paste, secure storage, provider switching, all answer modes, copy, sharing visibility, and authenticated extension communication. It uses synthetic provider HTTP fixtures installed by the test runner, never production mock branches. It runs in isolated temporary app/browser profiles and requires an interactive Windows session and Playwright Chromium (`npx playwright install chromium`). Quit any existing companion first so port 47831 is free, and avoid concurrent typing during the native input test. Fixture tests establish client behavior; authenticated live Groq and Gemini operation must be verified locally with your own credentials. Never put credentials into test files, Git, or logs.

`npm run package` emits an NSIS installer and portable Windows EXE. The keyboard listener ships a prebuilt N-API binary, so packaging deliberately skips native rebuilding and needs no Visual Studio installation. `dist/extension` is the production extension folder. Build artifacts, user data, `.env`, cookie files, and credentials are excluded from Git. Push source changes to `main` with conventional commits.

## Troubleshooting

- **Desktop companion is not running:** start it and inspect the tray. Check the bridge diagnostics; another process may own port 47831.
- **Pairing invalid:** enter the current desktop token again, especially after a token rotation.
- **No response to Ctrl+V:** confirm text is copied, the tray app is running and the passive listener diagnostics report active. Shortcuts are ignored while desktop Settings has focus so pasting credentials there is safe. Some elevated/secure Windows surfaces restrict hooks; use the tray/popup action. Check that sharing mode isn't hiding the widget.
- **Groq model unavailable / HTTP 400:** install version 1.0.1 or later; version 1.0.0 requests a retired model. Validate the saved key again. Check project model permissions if access is denied. Provider errors include safe HTTP status details rather than raw response bodies.
- **Groq key invalid / rate limit:** validate your saved key, check your account quota, and retry later. A failed JSON generation gets one strict format retry; authentication, model-access and other request errors do not get format retries.
- **Gemini session expired / web protocol unavailable:** explicitly replace your own session cookies and validate. If Google has changed its protocol, an adapter update may be required; Groq remains an independent option.
- **Gemini validation reports AI connection failed with complete cookies:** install version 1.0.2 or later. Google's response can exceed Node's default 16 KiB header limit; the Gemini client now permits a bounded 64 KiB response header block. An oversized response gives a specific error without exposing cookies.
- **Invalid AI response:** a strict retry is attempted once. Try a clearer question if the model still returns malformed data.
- **Extension dot missing:** reload the rebuilt extension and the page after upgrading, and use a regular HTTP/HTTPS page. Capture exclusion intentionally hides the browser overlay while Screen sharing is active; use the protected desktop widget locally.
- **Secure storage unavailable:** run under a normal Windows user session and resave the credential if your Windows profile has changed.

Diagnostics expose status/version/error categories only, never clipboard text, responses or credentials. DeveloperTools are disabled for packaged app renderers. For development, use the tests to reproduce transport failures with synthetic fixtures.
